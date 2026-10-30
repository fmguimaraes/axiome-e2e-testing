import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { ingestCsvFixture } from './harness/opening-templates';
import { automaticDataFlow, automaticPlan, callLogRows, debugHolder, type DebugHolder } from './harness/automatic-mode';

/**
 * AXI-2355 (epic AXI-2308 — NFR11b/c, FR26, FR46, AC37, EC15; owner ruling D20 Q2): the
 * identifying-data check refuses category levels that look like personal names (rule
 * `NFR11-L4`), for Automatic mode (AXI-2341) and for the Guided suggestion call (AXI-2345),
 * which send the same levels to AWS Bedrock. Ordinary levels (sex, arms, site codes, gene
 * symbols, group labels) are not flagged.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2355.3–.6 (incl. .5b).
 * API-level (no browser).
 *
 * ZERO SPEND BY CONSTRUCTION. Recorded transport, no provider key, no AWS credential. A refusal
 * builds no request at all; the one call that reaches the transport (.4, the positive control)
 * hits the committed AXI-2341 T1 recording (`llm-debug/recordings/compiled-planner/`). No new
 * recording was authored for this story.
 *
 * Fixture (synthetic, no real person): `automatic-name-levels-v2.csv` — `referent` holds full names,
 * `infirmiere` holds given names,
 * `saisi_par` holds the NOM_Prenom export shape (review B1), beside five ordinary categorical columns; headers are neutral so
 * only the level rule can fire.
 *
 * Run: `API_BASE_URL=<gateway serving the AXI-2355 branch> npx playwright test tests/AXI-2308/AXI-2355-* --no-deps`.
 * Never against the shared demo gateway (:3000): it approves seeded carriers (append-only).
 */

const NAMES = 'automatic-name-levels-v2.csv'; // v2: + saisi_par (NOM_Prenom). The harness reuses a dataset BY FILENAME, so a changed fixture needs a new name.
const PAUL = 'opening-templates-paul-header.csv';
const MAG4_27 = 'microbiote_igg4_mag4_27';
const Q_T1 = `Does ${MAG4_27} differ between F and M of sexe?`; // the AXI-2341 recording's question
const Q_NAMES = 'Does igg4_g_l differ between Placebo and Traitement A of bras?';
const NAME_TEXT = /Dupont|Lefebvre|Benali|Sophie|Nathalie|Camille|MARTIN/;
const ORDINARY = ['sexe', 'bras', 'site', 'gene_mute', 'groupe'];

let api: Api;
let t: Tenant;
let holder: DebugHolder;
let names: AnchoredDataset;
let paul: AnchoredDataset;
let refusal: any;

async function anchoredFixture(file: string): Promise<AnchoredDataset> {
  const datasetId = await ingestCsvFixture(api, t, file);
  const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
  if (!anchored) throw new Error(`${file} could not be anchored`);
  return anchored;
}

const indexOf = (ds: AnchoredDataset, name: string) => ds.columns.findIndex((c) => c.name === name);

test.describe.serial('AXI-2355 personal names in category levels are refused @SI-045 @SI-010', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000); // hooks are governed by setTimeout, never describe.configure
    expect(process.env.E2E_LIVE_LLM).toBeUndefined();
    expect(process.env.GUIDED_ANALYSIS_LIVE_SPEND_GO).toBeUndefined();
    api = await adminApi();
    t = await ensureTenant(api);
    names = await anchoredFixture(NAMES);
    paul = await anchoredFixture(PAUL);
    await approveCarriersFor(['stats.mann_whitney_u']);
    holder = await debugHolder(api, t);
  });

  test.afterAll(async () => {
    await holder?.cleanup();
    await api?.ctx.dispose();
  });

  test('AXI-2355.3 AC37 EC15 — name-like levels refuse Automatic mode before any request, logged not_called', async () => {
    const res = await automaticPlan(api, t, names, Q_NAMES);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    refusal = res.body;
    expect(refusal.ok, JSON.stringify(refusal)).toBe(false);
    expect(refusal).toMatchObject({ code: 'IDENTIFYING_DATA', offerGuided: true, question: Q_NAMES });
    expect(refusal).not.toHaveProperty('compiled');
    expect(refusal.ruleIds).toContain('NFR11-L4');
    const l4 = (refusal.findings as any[]).filter((f) => f.ruleId === 'NFR11-L4');
    expect(l4).toEqual([
      { columnIndex: indexOf(names, 'referent'), kind: 'level', ruleId: 'NFR11-L4' },
      { columnIndex: indexOf(names, 'infirmiere'), kind: 'level', ruleId: 'NFR11-L4' },
      { columnIndex: indexOf(names, 'saisi_par'), kind: 'level', ruleId: 'NFR11-L4' }, // NOM_Prenom (review B1)
    ]);
    expect(JSON.stringify(refusal)).not.toMatch(NAME_TEXT);

    const rows = (await callLogRows(holder, t)).filter((r) => r.correlationId === refusal.callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entryMode: 'automatic', outcome: 'identifying_data', model: 'not_called', refusalCodes: ['IDENTIFYING_DATA'] });
    expect(JSON.stringify(rows[0])).not.toMatch(NAME_TEXT);
  });

  test('AXI-2355.4 AC37 — ordinary levels are not flagged; the investigator header still plans T1', async () => {
    const flagged = new Set((refusal?.findings as any[] | undefined)?.map((f) => f.columnIndex) ?? []);
    for (const column of ORDINARY) expect(flagged.has(indexOf(names, column)), column).toBe(false);

    const res = await automaticPlan(api, t, paul, Q_T1);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(res.body.templateId).toBe('T1');
  });

  test('AXI-2355.5 NFR11b — the Guided suggestion call is skipped on name-like levels, logged not_called', async () => {
    const dataset = {
      datasetId: randomUUID(),
      columns: [
        { name: 'ccl19', type: 'numeric' },
        { name: 'referent', type: 'categorical', categories: ['Jean Dupont', 'Marie Lefebvre'] },
      ],
    };
    const before = new Set((await callLogRows(holder, t)).map((r) => r.correlationId));
    const res = await api.post('/api/v1/guided-analysis/intent-prefill/suggest',
      { projectId: t.projectId, question: 'Does ccl19 differ by referent?', dataset }, t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: 'skipped_identifying', intent: null, slots: [], contradictions: [], callId: null });
    const fresh = (await callLogRows(holder, t)).filter((r) => r.callSite === 'intent-prefill' && !before.has(r.correlationId));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ outcome: 'skipped_identifying', model: 'not_called' });
    expect(JSON.stringify(fresh[0])).not.toMatch(NAME_TEXT);
    expect(JSON.stringify(res.body)).not.toMatch(NAME_TEXT);
  });

  test('AXI-2355.5b NFR11b — the NOM_Prenom export shape and other separators are refused the same way', async () => {
    // Two levels each: a one-level column is not a grouping column and is never sent at all.
    const shapes = [['MARTIN_Sophie', 'DUPONT_Jean'], ['Jean.Dupont', 'Marie.Curie'], ['Dupont/Jean', 'Curie/Marie'], ['Jean Dupont (CHU)', 'Marie Curie (CHU)']];
    for (const categories of shapes) {
      const dataset = { datasetId: randomUUID(), columns: [{ name: 'ccl19', type: 'numeric' }, { name: 'referent', type: 'categorical', categories }] };
      const res = await api.post('/api/v1/guided-analysis/intent-prefill/suggest',
        { projectId: t.projectId, question: 'Does ccl19 differ by referent?', dataset }, t.headers);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status, categories.join('|')).toBe('skipped_identifying');
    }
  });

  test('AXI-2355.6 NFR11c — the data-flow statement states the check', async () => {
    const res = await automaticDataFlow(api, t);
    expect(res.status).toBe(200);
    const { statement } = res.body;
    expect(statement).toContain('AWS Bedrock');
    expect(statement).toContain('no patient-level values');
    expect(statement).toContain('the analysis itself runs without any external call.');
    expect(statement).toMatch(/personal names/);
    expect(statement).toMatch(/nothing is sent/);
  });
});

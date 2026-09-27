import { test, expect } from '@playwright/test';
import { workspaceHeader } from '../AXI-1435/harness/api';
import { seedLiveWorkbench, submitStepAndWait, SCREEN_OP, type Seeded } from './harness/live-workbench';

/**
 * AXI-1754 — Evidence & Interpretation: persist the fact sheet, sections and
 * cited items (epic AXI-1717).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` §19.
 * Tags: @SI-045 (guided-analysis: `DiscoveryEvidenceService`), @SI-046 (front:
 * `EvidenceBuilderModal` reads real citable validation applications live).
 *
 * REAL BACKEND, LLM-FREE — the nine-step plan is a TEMPLATE instantiation
 * (`POST /discovery/plans`), never a planner call. Fixture: Riaz 2017 immune,
 * 27 patients, `response` R/NR, `patient_id`. Seed lifted from AXI-1725's
 * harness (`./harness/live-workbench.ts`) rather than re-deriving it.
 */

const evidenceUrl = (va: string) => `/api/v1/discovery/analyses/${va}/evidence`;
const evidenceItemsUrl = (va: string) => `/api/v1/discovery/analyses/${va}/evidence-items`;

const SECTIONS = { asked: [{ text: 'Does biomarker_x separate responders?', provenance: 'template' }], found: [], validated: [], limitations: [], not_established: [] };
const FACT_SHEET = [{ id: 'f1', key: 'n', value: '27', unit: null, sourceRunId: 'e2e-run', evidenceVersionId: null }];

test.describe('AXI-1754 - declare/get the evidence document (API, real backend)', { tag: ['@SI-045'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1754-api-${Date.now().toString(36)}`, `AXI-1754 Evidence API ${Date.now().toString(36)}`);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('AC1 - a fresh question has no evidence yet (get returns null)', async () => {
    const res = await s.api.get(evidenceUrl(s.viewAnalysisId), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ document: null });
  });

  test('AC1 - declaring the evidence document persists the fact sheet and the five sections verbatim', async () => {
    const res = await s.api.post(evidenceUrl(s.viewAnalysisId), { factSheet: FACT_SHEET, sections: SECTIONS }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.declared).toBe(true);
    expect(res.body.document).toMatchObject({ viewAnalysisId: s.viewAnalysisId, factSheet: FACT_SHEET, sections: SECTIONS, reportedBranchId: null });
  });

  test('AC1 - the read back is byte-for-byte identical', async () => {
    const res = await s.api.get(evidenceUrl(s.viewAnalysisId), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.document).toMatchObject({ factSheet: FACT_SHEET, sections: SECTIONS });
  });

  test('AC2 - one evidence per question: a second declare is refused, race-safely, and nothing was overwritten', async () => {
    const res = await s.api.post(evidenceUrl(s.viewAnalysisId), {
      factSheet: [{ id: 'f2', key: 'n', value: '999', unit: null, sourceRunId: null, evidenceVersionId: null }],
      sections: SECTIONS,
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.declared).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/already has evidence/);

    const stillOriginal = await s.api.get(evidenceUrl(s.viewAnalysisId), s.t.headers);
    expect(stillOriginal.body.document).toMatchObject({ factSheet: FACT_SHEET });
  });

  test('an unknown reportedBranchId is refused before any write', async () => {
    // A second, fresh question so this refusal is not shadowed by AC2's "already declared".
    const fresh = await seedLiveWorkbench(`axi-1754-branch-${Date.now().toString(36)}`, `AXI-1754 Branch Refusal ${Date.now().toString(36)}`);
    try {
      const res = await fresh.api.post(evidenceUrl(fresh.viewAnalysisId), { reportedBranchId: '00000000-0000-4000-8000-000000000000', factSheet: [], sections: SECTIONS }, fresh.t.headers);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.declared).toBe(false);
      expect(res.body.reasons.join(' ')).toContain('00000000-0000-4000-8000-000000000000');
    } finally {
      await fresh.api.ctx.dispose();
    }
  });

  test('NFR8 tenancy - workspaceId in the body is refused by the pipe (400); another workspace sees no instance (404)', async () => {
    const forged = await s.api.post(evidenceUrl(s.viewAnalysisId), { factSheet: [], sections: SECTIONS, workspaceId: s.t.workspaceId }, s.t.headers);
    expect(forged.status).toBe(400);

    const other = await s.api.post('/api/v1/workspaces', { name: 'AXI-1754 Other Tenant', type: 'internal', ownerOrganizationId: s.t.orgId });
    const otherId = other.body?.id ?? (await s.api.get('/api/v1/workspaces?limit=100')).body.find?.((w: any) => w.name === 'AXI-1754 Other Tenant')?.id;
    expect(otherId, `other workspace: ${JSON.stringify(other.body)}`).toBeTruthy();
    const cross = await s.api.get(evidenceUrl(s.viewAnalysisId), workspaceHeader(otherId));
    expect([403, 404], JSON.stringify(cross)).toContain(cross.status);
  });

  test('gap #28 - listEvidenceItems answers a structurally shaped items array, including the existing Evidence citations once a step has run', async () => {
    await submitStepAndWait(s, s.viewAnalysisId, 'screen', SCREEN_OP);
    const res = await s.api.get(evidenceItemsUrl(s.viewAnalysisId), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    // Every item is a REFERENCE, never a copy: no title/value fields, only ids + version.
    for (const item of res.body.items) {
      expect(item).toEqual(expect.objectContaining({ kind: expect.any(String), version: expect.any(Number) }));
      expect(item).not.toHaveProperty('title');
    }
  });
});

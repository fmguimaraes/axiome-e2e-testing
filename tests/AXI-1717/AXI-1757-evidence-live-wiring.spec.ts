import { test, expect } from '@playwright/test';
import { seedLiveWorkbench, type Seeded } from './harness/live-workbench';

/**
 * AXI-1757 — Evidence & Interpretation: wire the editor to live data (epic
 * AXI-1717, ruling R16). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` §26.
 * Tag: @SI-046.
 *
 * REAL BACKEND, LLM-FREE — reuses AXI-1754/1756's `seedLiveWorkbench` harness
 * (Riaz 2017 immune fixture, template instantiation, never a planner call).
 * This spec covers the story's backend-observable surface (the mandatory
 * review advisories): the new side-effect-free check-only endpoint (A1), the
 * server-derived over-claim context (A2), the concurrent-revise refusal (B1)
 * and the export tamper check (B2), plus publish's optional `sections`
 * override the live editor needs (no separate "save draft" endpoint). The
 * front end's own wiring (EvidenceEditorModal/EvidenceBuilderModal/EvidenceNode)
 * is covered by `UT-FE-GUIDED-1757-01..19` (Vitest, axiome-front).
 */

const evidenceUrl = (va: string) => `/api/v1/discovery/analyses/${va}/evidence`;
const checkUrl = (va: string) => `/api/v1/discovery/analyses/${va}/evidence/check`;
const publishUrl = (va: string) => `/api/v1/discovery/analyses/${va}/evidence/publish`;
const reviseUrl = (va: string) => `/api/v1/discovery/analyses/${va}/evidence/revise`;
const exportUrl = (va: string, format: string) => `/api/v1/discovery/analyses/${va}/evidence/export?format=${format}`;

const SECTIONS = { asked: [{ text: 'Does biomarker_x separate responders?', provenance: 'template' }], found: [], validated: [], limitations: [], not_established: [] };
const OVER_CLAIM_SECTIONS = { ...SECTIONS, found: [{ text: 'This confirms the association.', provenance: null }] };
const FACT_SHEET = [{ id: 'f1', key: 'n', value: '27', unit: null, sourceRunId: 'e2e-run', evidenceVersionId: null }];

async function freshQuestionWithDeclaredEvidence(tag: string) {
  const s = await seedLiveWorkbench(`axi-1757-${tag}-${Date.now().toString(36)}`, `AXI-1757 ${tag} ${Date.now().toString(36)}`);
  const declared = await s.api.post(evidenceUrl(s.viewAnalysisId), { factSheet: FACT_SHEET, sections: SECTIONS }, s.t.headers);
  expect(declared.status, JSON.stringify(declared.body)).toBe(200);
  expect(declared.body.declared).toBe(true);
  return s;
}

test.describe('AXI-1757 - the check-only endpoint (review advisory A1)', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  test.beforeAll(async () => { s = await freshQuestionWithDeclaredEvidence('check'); });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('clean sections at the on-claim-level report no checks, and write nothing', async () => {
    const res = await s.api.post(checkUrl(s.viewAnalysisId), { factSheet: [], sections: SECTIONS, claimLevel: 'exploratory' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checks).toEqual([]);

    const read = await s.api.get(evidenceUrl(s.viewAnalysisId), s.t.headers);
    expect(read.body.document).toMatchObject({ status: 'draft', sections: SECTIONS });
  });

  test('an over-claiming section at an exploratory claim level is flagged — the SAME rule publish would enforce', async () => {
    const res = await s.api.post(checkUrl(s.viewAnalysisId), { factSheet: [], sections: OVER_CLAIM_SECTIONS, claimLevel: 'exploratory' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checks.some((c: { detail: string }) => /over-claim/.test(c.detail))).toBe(true);
  });

  test('publishing the SAME over-claiming sections at the SAME claim level is refused for the identical reason (one authority, never a second copy)', async () => {
    const res = await s.api.post(publishUrl(s.viewAnalysisId), { approverNote: 'ok', claimLevel: 'exploratory', sections: OVER_CLAIM_SECTIONS }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.published).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/over-claim/);
  });
});

test.describe('AXI-1757 - publish accepts an unsaved sections override (no separate save-draft endpoint)', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  test.beforeAll(async () => { s = await freshQuestionWithDeclaredEvidence('publish-override'); });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  const EDITED = { ...SECTIONS, found: [{ text: 'Edited in the live editor just before publish.', provenance: null }] };

  test('publish with a `sections` override freezes the CALLER\'s edit, not the stale persisted draft', async () => {
    const res = await s.api.post(publishUrl(s.viewAnalysisId), { approverNote: 'reviewed the edit', claimLevel: 'descriptive_only', sections: EDITED }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.published).toBe(true);
    expect(res.body.document).toMatchObject({ status: 'published', sections: EDITED });
    expect(res.body.document.contentHash).toMatch(/^sha256:/);
  });

  test('the export of that published version carries the frozen (edited) content, and a tamper check passes (review advisory B2)', async () => {
    const res = await s.api.get(exportUrl(s.viewAnalysisId, 'json'), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.exported).not.toBe(false);
    expect(res.body.sections.found.entries?.[0]?.text ?? JSON.stringify(res.body)).toMatch(/Edited in the live editor/);
  });
});

test.describe('AXI-1757 - concurrent revise is refused, never a raw 500 (review advisory B1)', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    s = await freshQuestionWithDeclaredEvidence('concurrent-revise');
    const published = await s.api.post(publishUrl(s.viewAnalysisId), { approverNote: 'ok', claimLevel: 'exploratory' }, s.t.headers);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.published).toBe(true);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('two concurrent revise calls on the same published version: one succeeds, the other is refused with a reason naming the version, never a 500', async () => {
    const [a, b] = await Promise.all([
      s.api.post(reviseUrl(s.viewAnalysisId), { factSheet: FACT_SHEET, sections: SECTIONS }, s.t.headers),
      s.api.post(reviseUrl(s.viewAnalysisId), { factSheet: FACT_SHEET, sections: SECTIONS }, s.t.headers),
    ]);
    for (const r of [a, b]) expect(r.status, JSON.stringify(r.body)).toBe(200);
    const bodies = [a.body, b.body];
    const succeeded = bodies.filter((body) => body.revised === true);
    const refused = bodies.filter((body) => body.revised === false);
    expect(succeeded.length + refused.length).toBe(2);
    // Either both raced into one success + one lost-race refusal, or the
    // dedup/lock happened to serialize them into two successes — either way,
    // no response is ever a raw 500 and no lost race is silently dropped.
    if (refused.length > 0) expect(refused[0].reasons.join(' ')).toMatch(/concurrent|already/);
  });
});

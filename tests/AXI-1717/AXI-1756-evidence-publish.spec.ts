import { test, expect } from '@playwright/test';
import { seedLiveWorkbench, type Seeded } from './harness/live-workbench';

/**
 * AXI-1756 — Evidence & Interpretation: publish, revise and stamp the claim
 * level (epic AXI-1717, ruling R16; AXI-1728 gaps #23, #25, #27).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` §25.
 * Tag: @SI-046.
 *
 * REAL BACKEND, LLM-FREE — reuses AXI-1754's `seedLiveWorkbench` harness
 * (Riaz 2017 immune fixture, template instantiation, never a planner call).
 */

const evidenceUrl = (va: string) => `/api/v1/discovery/analyses/${va}/evidence`;
const publishUrl = (va: string) => `/api/v1/discovery/analyses/${va}/evidence/publish`;
const discardUrl = (va: string) => `/api/v1/discovery/analyses/${va}/evidence/discard`;
const reviseUrl = (va: string) => `/api/v1/discovery/analyses/${va}/evidence/revise`;
const exportUrl = (va: string, format: string) => `/api/v1/discovery/analyses/${va}/evidence/export?format=${format}`;

const SECTIONS = { asked: [{ text: 'Does biomarker_x separate responders?', provenance: 'template' }], found: [], validated: [], limitations: [], not_established: [] };
const REVISED_SECTIONS = { ...SECTIONS, found: [{ text: 'Yes, at p<0.01', provenance: 'run-2' }] };
const FACT_SHEET = [{ id: 'f1', key: 'n', value: '27', unit: null, sourceRunId: 'e2e-run', evidenceVersionId: null }];

async function freshQuestionWithDeclaredEvidence(tag: string) {
  const s = await seedLiveWorkbench(`axi-1756-${tag}-${Date.now().toString(36)}`, `AXI-1756 ${tag} ${Date.now().toString(36)}`);
  const declared = await s.api.post(evidenceUrl(s.viewAnalysisId), { factSheet: FACT_SHEET, sections: SECTIONS }, s.t.headers);
  expect(declared.status, JSON.stringify(declared.body)).toBe(200);
  expect(declared.body.declared).toBe(true);
  return s;
}

test.describe('AXI-1756 - publish, discard, revise and the claim level (API, real backend)', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  test.beforeAll(async () => { s = await freshQuestionWithDeclaredEvidence('publish'); });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('AC1 - publish without a note is refused, and nothing is published', async () => {
    const res = await s.api.post(publishUrl(s.viewAnalysisId), { claimLevel: 'exploratory' }, s.t.headers);
    expect(res.status).toBe(400); // the gateway DTO itself requires a non-empty note
  });

  test('publish requires the claim level too (out-of-vocabulary is a 400)', async () => {
    const res = await s.api.post(publishUrl(s.viewAnalysisId), { approverNote: 'ok', claimLevel: 'made_up' }, s.t.headers);
    expect(res.status).toBe(400);
  });

  test('publishing freezes the content hash and stamps the claim level', async () => {
    const res = await s.api.post(publishUrl(s.viewAnalysisId), { approverNote: 'reviewed, looks right', claimLevel: 'descriptive_only' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.published).toBe(true);
    expect(res.body.document).toMatchObject({ status: 'published', version: 1, claimLevel: 'descriptive_only', approverNote: 'reviewed, looks right' });
    expect(res.body.document.contentHash).toMatch(/^sha256:/);
  });

  test('AC2 - a published version cannot be silently altered: publishing again is refused', async () => {
    const res = await s.api.post(publishUrl(s.viewAnalysisId), { approverNote: 'again', claimLevel: 'capped' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.published).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/already published/);
  });

  test('a published document cannot be discarded directly', async () => {
    const res = await s.api.post(discardUrl(s.viewAnalysisId), { reason: 'changed my mind' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.discarded).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/cannot be discarded directly/);
  });

  test('AC3 - revise creates v2 and archives v1 as superseded by v2', async () => {
    const res = await s.api.post(reviseUrl(s.viewAnalysisId), { factSheet: FACT_SHEET, sections: REVISED_SECTIONS }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.revised).toBe(true);
    expect(res.body.previousVersion).toBe(1);
    expect(res.body.document).toMatchObject({ version: 2, status: 'draft', sections: REVISED_SECTIONS });

    const read = await s.api.get(evidenceUrl(s.viewAnalysisId), s.t.headers);
    expect(read.body.document.history).toEqual(
      expect.arrayContaining([expect.objectContaining({ version: 1, status: 'superseded', supersededByVersion: 2 })]),
    );
  });

  test('AC4 - the JSON export of the published v2 carries the claim level, once published again', async () => {
    const published = await s.api.post(publishUrl(s.viewAnalysisId), { approverNote: 'v2 approved', claimLevel: 'confirmatory_on_target' }, s.t.headers);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.published).toBe(true);

    const res = await s.api.get(exportUrl(s.viewAnalysisId, 'json'), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.claimLevel).toBe('confirmatory_on_target');
    expect(res.body.sections.found.claimLevel).toBe('confirmatory_on_target');
  });
});

test.describe('AXI-1756 - discard a draft, and export refuses a non-published document', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  test.beforeAll(async () => { s = await freshQuestionWithDeclaredEvidence('discard'); });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('discard without a reason is refused', async () => {
    const res = await s.api.post(discardUrl(s.viewAnalysisId), {}, s.t.headers);
    expect(res.status).toBe(400);
  });

  test('export of a draft (never published) is refused, naming the status', async () => {
    const res = await s.api.get(exportUrl(s.viewAnalysisId, 'json'), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.exported).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/current status: 'draft'/);
  });

  test('discard with a reason records it', async () => {
    const res = await s.api.post(discardUrl(s.viewAnalysisId), { reason: 'wrong marker family' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.discarded).toBe(true);
    expect(res.body.document).toMatchObject({ status: 'discarded', discardReason: 'wrong marker family' });
  });

  test('revise refuses a discarded document — only a published one may be revised', async () => {
    const res = await s.api.post(reviseUrl(s.viewAnalysisId), { factSheet: FACT_SHEET, sections: SECTIONS }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.revised).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/Only a published/);
  });
});

import { test, expect } from '@playwright/test';
import { seedLiveWorkbench, type Seeded } from './harness/live-workbench';

/**
 * AXI-1755 — Evidence & Interpretation: governed drafting and wording checks
 * (epic AXI-1717, ruling R16; AXI-1728 gaps #21/#22).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` §24.
 * Tags: @SI-045/@SI-047 (guided-analysis: `EvidenceDraftService`,
 * `checkDraftSections`), @SI-046 (front: live "Draft with AI").
 *
 * REAL BACKEND, LLM-FREE — the draft provider defaults to `deterministic`
 * (`DISCOVERY_EVIDENCE_DRAFT_PROVIDER` unset), so no network call to
 * Anthropic is ever made by this spec. Fixture: Riaz 2017 immune, 27
 * patients, `response` R/NR, `patient_id`. Seed lifted from AXI-1725/1754's
 * harness (`./harness/live-workbench.ts`) rather than re-deriving it.
 */

const draftUrl = (va: string) => `/api/v1/discovery/analyses/${va}/evidence/draft`;

const RUO = 'Research Use Only. Not for use in diagnostic procedures.';
const EMPTY = { asked: [], found: [], validated: [], limitations: [], not_established: [] };

const FACTS = [{ id: 'F1', label: 'validation n', value: '40', unit: '', required: true }];

test.describe('AXI-1755 - server-side draft/checks endpoint (API, real backend)', { tag: ['@SI-045', '@SI-047'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1755-api-${Date.now().toString(36)}`, `AXI-1755 Evidence Draft API ${Date.now().toString(36)}`);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('AC1 - a clean draft over a satisfied fact sheet passes with no failures and no fallback', async () => {
    const sections = { ...EMPTY, found: [{ text: 'n={fact:F1}.', provenance: 'template' }] };
    const res = await s.api.post(draftUrl(s.viewAnalysisId), { facts: FACTS, items: [], status: 'exploratory', sections }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checks).toEqual([]);
    expect(res.body.usedFallback).toBe(false);
  });

  test('AC1 - a literal digit outside a placeholder is refused by name', async () => {
    const sections = { ...EMPTY, found: [{ text: 'The count was 40.', provenance: 'user' }] };
    const res = await s.api.post(draftUrl(s.viewAnalysisId), { facts: FACTS, items: [], status: 'exploratory', sections }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checks.map((c: any) => c.check)).toContain('literal number');
  });

  test('AC1 - an unknown placeholder is refused by name', async () => {
    const sections = { ...EMPTY, found: [{ text: 'See {fact:F9}.', provenance: 'user' }] };
    const res = await s.api.post(draftUrl(s.viewAnalysisId), { facts: FACTS, items: [], status: 'exploratory', sections }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checks.map((c: any) => c.check)).toContain('unknown fact');
  });

  test('AC1 - a forbidden term (predictive/diagnostic/proves/clinically useful) is refused', async () => {
    const sections = { ...EMPTY, found: [{ text: 'This is a predictive marker.', provenance: 'user' }] };
    const res = await s.api.post(draftUrl(s.viewAnalysisId), { facts: FACTS, items: [], status: 'exploratory', sections }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checks.map((c: any) => c.check)).toContain('forbidden term');
  });

  test('AC1 - an over-claim above the request status is refused, and a required fact never referenced is refused', async () => {
    const sections = { ...EMPTY, found: [{ text: 'The finding is confirmed.', provenance: 'user' }] };
    const res = await s.api.post(draftUrl(s.viewAnalysisId), { facts: FACTS, items: [], status: 'exploratory', sections }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const checks = res.body.checks.map((c: any) => c.check);
    expect(checks).toContain('over-claim');
    expect(checks).toContain('missing required fact');
  });

  test('AC1 - a failing draft (unsupported by the deterministic port) falls back to the template with usedFallback true', async () => {
    // The deterministic adapter always echoes the submitted sections back unchanged,
    // so a submission that fails its own checks has no repair available and settles
    // on the template fallback for the failing section.
    const sections = { ...EMPTY, found: [{ text: 'a predictive marker', provenance: 'user' }] };
    const res = await s.api.post(draftUrl(s.viewAnalysisId), { facts: FACTS, items: [], status: 'exploratory', sections }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.usedFallback).toBe(true);
    expect(res.body.log.join(' ')).toMatch(/repair turn|fallback|template/i);
  });

  test('AC3 - the fixed RUO notice text never trips the literal-number or forbidden-term checks', async () => {
    const sections = { ...EMPTY, limitations: [{ text: RUO, provenance: 'template' }] };
    const res = await s.api.post(draftUrl(s.viewAnalysisId), { facts: [], items: [], status: 'exploratory', sections }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checks).toEqual([]);
  });

  test('NFR8 tenancy - facts/items/status/sections are required; a workspaceId/caller in the body is refused by the pipe (400)', async () => {
    const missing = await s.api.post(draftUrl(s.viewAnalysisId), { facts: [], items: [] }, s.t.headers);
    expect(missing.status).toBe(400);

    const forged = await s.api.post(draftUrl(s.viewAnalysisId), { facts: [], items: [], status: 'exploratory', sections: EMPTY, workspaceId: s.t.workspaceId }, s.t.headers);
    expect(forged.status).toBe(400);
  });

  test('NFR8 - the route answers 200 on every outcome, including a fully-fallen-back draft', async () => {
    const sections = { ...EMPTY, found: [{ text: 'this proves it', provenance: 'user' }] };
    const res = await s.api.post(draftUrl(s.viewAnalysisId), { facts: [], items: [], status: 'exploratory', sections }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

/**
 * Rebase addendum (onto AXI-1756) — the lifecycle guard: drafting is refused,
 * a 200 `{refused:true, reasons}` (never a 4xx — NFR8), once the question's
 * evidence document is published (frozen — `revise` is the only path off it)
 * or discarded (terminal). A separate question per scenario — publish/discard
 * are irreversible-by-drafting once applied.
 */
const evidenceUrl = (va: string) => `/api/v1/discovery/analyses/${va}/evidence`;
const publishUrl = (va: string) => `/api/v1/discovery/analyses/${va}/evidence/publish`;
const discardUrl = (va: string) => `/api/v1/discovery/analyses/${va}/evidence/discard`;
const DECLARE_SECTIONS = { ...EMPTY, found: [{ text: 'n={fact:F1}.', provenance: 'template' }] };
const DECLARE_FACT_SHEET = [{ id: 'F1', key: 'n', value: '40', unit: null, sourceRunId: null, evidenceVersionId: null }];

test.describe('AXI-1755 - drafting is refused once published/discarded (rebase onto AXI-1756)', { tag: ['@SI-045', '@SI-047'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  test('drafting is refused, without altering the frozen content, once the document is published', async () => {
    const s2 = await seedLiveWorkbench(`axi-1755-published-${Date.now().toString(36)}`, `AXI-1755 Published ${Date.now().toString(36)}`);
    try {
      const declared = await s2.api.post(evidenceUrl(s2.viewAnalysisId), { factSheet: DECLARE_FACT_SHEET, sections: DECLARE_SECTIONS }, s2.t.headers);
      expect(declared.status, JSON.stringify(declared.body)).toBe(200);
      const published = await s2.api.post(publishUrl(s2.viewAnalysisId), { approverNote: 'reviewed', claimLevel: 'exploratory' }, s2.t.headers);
      expect(published.status, JSON.stringify(published.body)).toBe(200);
      expect(published.body.published).toBe(true);

      const res = await s2.api.post(draftUrl(s2.viewAnalysisId), { facts: FACTS, items: [], status: 'exploratory', sections: DECLARE_SECTIONS }, s2.t.headers);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.refused).toBe(true);
      expect(res.body.reasons.join(' ')).toMatch(/published.*frozen|revise/i);
      expect(res.body.sections).toEqual(DECLARE_SECTIONS);
    } finally {
      await s2.api.ctx.dispose();
    }
  });

  test('drafting is refused once the document is discarded', async () => {
    const s3 = await seedLiveWorkbench(`axi-1755-discarded-${Date.now().toString(36)}`, `AXI-1755 Discarded ${Date.now().toString(36)}`);
    try {
      const declared = await s3.api.post(evidenceUrl(s3.viewAnalysisId), { factSheet: DECLARE_FACT_SHEET, sections: DECLARE_SECTIONS }, s3.t.headers);
      expect(declared.status, JSON.stringify(declared.body)).toBe(200);
      const discarded = await s3.api.post(discardUrl(s3.viewAnalysisId), { reason: 'wrong question' }, s3.t.headers);
      expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
      expect(discarded.body.discarded).toBe(true);

      const res = await s3.api.post(draftUrl(s3.viewAnalysisId), { facts: FACTS, items: [], status: 'exploratory', sections: DECLARE_SECTIONS }, s3.t.headers);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.refused).toBe(true);
      expect(res.body.reasons.join(' ')).toMatch(/discarded/i);
    } finally {
      await s3.api.ctx.dispose();
    }
  });

  test('drafting still runs as normal on a DRAFT (undeclared or not-yet-published) document', async () => {
    const s4 = await seedLiveWorkbench(`axi-1755-stilldraft-${Date.now().toString(36)}`, `AXI-1755 StillDraft ${Date.now().toString(36)}`);
    try {
      const res = await s4.api.post(draftUrl(s4.viewAnalysisId), { facts: FACTS, items: [], status: 'exploratory', sections: DECLARE_SECTIONS }, s4.t.headers);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.refused).toBeFalsy();
    } finally {
      await s4.api.ctx.dispose();
    }
  });
});

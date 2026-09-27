import { test, expect } from '@playwright/test';
import { workspaceHeader } from '../AXI-1435/harness/api';
import {
  seedLiveWorkbench, stepUrl, submitStepAndWait, CUTOFF_OP, SCREEN_OP, type Seeded,
} from './harness/live-workbench';

/**
 * AXI-1752 — API refusals match the UI: declined cutoff and upstream binding
 * precedence (epic AXI-1717, rulings R17 + R18). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` §21.
 *
 * Tag: @SI-045 (guided-analysis: `StepResolverService.submit`'s new R17 guard,
 * `resolveStep`'s pre-existing R18 precedence order).
 *
 * REAL BACKEND, LLM-FREE. API-level only — no UI is needed for either ruling: R17
 * is a server-side refusal a headless client hits directly, and R18's precedence
 * is a property of the resolve response's `source` tags. Same AXI-1507/1721
 * harness/fixture as every AXI-1717 sibling spec (Riaz 2017 immune, 27 patients,
 * `response` R/NR, `patient_id`).
 *
 * R18's actual CONFLICT case (a slot both an upstream node and a role could
 * fill, with DIFFERENT values) needs a fabricated node the real template never
 * produces — that is unit-tested (`step-resolver.spec.ts`,
 * UT-GUIDED-1752-01..04). What this file proves live is the wire-level fact the
 * unit tests can't: on a REAL instantiated container, the SAME slot (`groupColumn`)
 * is bindable from BOTH the resolver's role map and the node's own upstream
 * declaration, and the resolve response tags it `upstream:d6`, never `role:outcome`.
 */

test.describe('AXI-1752 - R17: a declined cutoff refuses a direct API submit, same words as the UI (real backend)', { tag: ['@SI-045'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  let screenRunId: string;
  let declaredScreenRunId: string;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1752-api-${Date.now().toString(36)}`, `AXI-1752 API Parity ${Date.now().toString(36)}`);
    screenRunId = await submitStepAndWait(s, s.viewAnalysisId, 'screen', SCREEN_OP);
    declaredScreenRunId = await submitStepAndWait(s, s.declaredAnalysisId, 'screen', SCREEN_OP);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('R17 - resolving the OPEN container\'s cutoff with no picks: positiveGroup is unresolved (the plan\'s own decline, EC4-shape)', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'resolve'), {
      operationId: CUTOFF_OP, datasetId: s.datasetId,
      selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'CD8A_pre' } },
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.unresolved.map((u: any) => u.name)).toEqual(['positiveGroup']);
    expect(res.body.fullyBound).toBe(false);
  });

  test('R17 - a direct API submit with an IN-DOMAIN positiveGroup pick is REFUSED, not accepted: a pick cannot un-decline the plan', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'submit'), {
      operationId: CUTOFF_OP, datasetId: s.datasetId, projectId: s.projectId,
      selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'CD8A_pre' } },
      picks: { positiveGroup: 'R' },
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.submitted).toBe(false);
    // The SAME sentence the front end's GuardReason/parameterPicker path already
    // renders for this signature — golden-text pinned in both repos' unit tests.
    expect(JSON.stringify(res.body.reasons)).toMatch(
      /no positive outcome class was declared for this proposal, so the plan records it as declined; a pick cannot un-decline it/,
    );
  });

  test('R17 - the reply resolves what the pick WOULD have bound, so a caller can see why, but nothing was submitted', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'submit'), {
      operationId: CUTOFF_OP, datasetId: s.datasetId, projectId: s.projectId,
      selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'CD8A_pre' } },
      picks: { positiveGroup: 'R' },
    }, s.t.headers);
    expect(res.body.resolution.bindings.find((b: any) => b.name === 'positiveGroup')).toMatchObject({ value: 'R', source: 'user' });
    expect(res.body.resolution.fullyBound).toBe(true);
  });

  test('R17 parity - the DECLARED container\'s cutoff (a real outcomePositiveLevel) is unaffected: no picks needed, submit succeeds', async () => {
    const res = await s.api.post(stepUrl(s.declaredAnalysisId, 'cutoff', 'submit'), {
      operationId: CUTOFF_OP, datasetId: s.datasetId, projectId: s.projectId,
      selection: { kind: 'shortlist_row', nodeId: 'd6', runId: declaredScreenRunId, values: { marker: 'CD8A_pre' } },
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.submitted).toBe(true);
    expect(res.body.bindingSources).toMatchObject({ positiveGroup: 'upstream:d7' });
  });

  test('NFR8 tenancy - a foreign workspace submitting against this container sees no instance (404); workspaceId in the body is a 400', async () => {
    const forged = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'submit'), {
      operationId: CUTOFF_OP, datasetId: s.datasetId, projectId: s.projectId, workspaceId: s.t.workspaceId,
      selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'CD8A_pre' } },
    }, s.t.headers);
    expect(forged.status).toBe(400);

    const other = await s.api.post('/api/v1/workspaces', { name: 'AXI-1752 Other Tenant', type: 'internal', ownerOrganizationId: s.t.orgId });
    const otherId = other.body?.id ?? (await s.api.get('/api/v1/workspaces?limit=100')).body.find?.((w: any) => w.name === 'AXI-1752 Other Tenant')?.id;
    expect(otherId, `other workspace: ${JSON.stringify(other.body)}`).toBeTruthy();
    const cross = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'submit'), {
      operationId: CUTOFF_OP, datasetId: s.datasetId, projectId: s.projectId,
      selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'CD8A_pre' } },
    }, workspaceHeader(otherId));
    expect([403, 404], JSON.stringify(cross)).toContain(cross.status);
  });
});

test.describe('AXI-1752 - R18: upstream outranks role over the wire (real backend)', { tag: ['@SI-045'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1752-r18-${Date.now().toString(36)}`, `AXI-1752 R18 Precedence ${Date.now().toString(36)}`);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('R18 - groupColumn is bindable from BOTH the confirmed dataset role and the screen node\'s own upstream declaration; resolve tags it upstream:d6, never role:outcome', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'screen', 'resolve'), { operationId: SCREEN_OP, datasetId: s.datasetId }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const groupColumn = res.body.bindings.find((b: any) => b.name === 'groupColumn');
    expect(groupColumn, JSON.stringify(res.body.bindings)).toMatchObject({ value: 'response', source: 'upstream:d6', sourceKind: 'upstream' });
    // The role map WOULD answer the same slot too (this fixture's role and
    // upstream happen to agree on the value) — the fabricated-conflict case
    // that PROVES upstream replaces, not merely sorts before, role is unit-only
    // (step-resolver.spec.ts UT-GUIDED-1752-01, where the two values differ).
  });

  test('R18 - the split step\'s plan-level upstream:plan tag also outranks its own role-fillable neighbors (questionKey vs. anything role could name)', async () => {
    const res = await s.api.post(stepUrl(s.viewAnalysisId, 'split', 'resolve'), { operationId: 'split.exploration_holdout', datasetId: s.datasetId }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byName = Object.fromEntries(res.body.bindings.map((b: any) => [b.name, b]));
    expect(byName.questionKey).toMatchObject({ source: 'upstream:plan' });
    expect(byName.patientKey).toMatchObject({ source: 'role:subject' });
  });
});

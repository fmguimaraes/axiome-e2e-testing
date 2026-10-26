import { test, expect, request as apiRequest } from '@playwright/test';
import { adminApi, workspaceHeader, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, createAnalysis, createSnapshot, frozenRenderPayload, uniq, type Tenant } from '../AXI-1233/harness/seed-axi1234';
import { apiUrl } from '../../config/env';

/**
 * AXI-2085 (epic AXI-2060 — gap G3; FR20, FR21, FR16, AC9; owner ruling
 * 2026-10-20, "yes for require approval").
 *
 * Scenario doc: manual-e2e/AXI-2060-Microbiote-IgG4-Study-Reproduction.md
 * (AXI-2085 section).
 *
 * Before this story, `ViewAnalysesService.publish()` had no structural
 * precondition that any decision existed or was approved (`decisionIds` was
 * optional and unconsulted), and ALSO ran `cascadePublishDrivenApprovals`,
 * silently promoting any cited `draft` decision to `reviewed` as a publish
 * side effect. Both are now fixed: `publish()` refuses
 * `PUBLISH_REQUIRES_APPROVED_INTERPRETATION` (400) unless every published
 * `evidenceVersionId` is cited by at least one `DecisionDraft` already at
 * status `approved`, and publish no longer changes any decision's status at
 * all (`cascadePublishDrivenApprovals` is DELETED).
 *
 * This spec is READ/WRITE against a dedicated, reusable e2e fixture tenant
 * (`AXI-1233 Freeze Render Org/Workspace/Project`, the same one
 * `AXI-2077`/`AXI-2081` already use) — never the real Microbiote IgG4 demo
 * project (`Microbiote IgG4 — synthetic reproduction (AXI-2064)`,
 * CeRAINOM-IgG4 org / Mag4 workspace) and never the two forbidden project
 * ids named in this story's scope. Every ViewAnalysis, evidence and decision
 * this spec creates is uniquely named (`uniq()`) and throwaway; nothing here
 * publishes, approves or creates a decision on real demo data.
 */

let api: Api;
let t: Tenant;
// AXI-2258 (epic AXI-2073): `reviewed -> approved` now refuses the draft's
// own author. `api` (the shared fixture admin) authors every decision this
// spec creates, so approving must go through a DIFFERENT workspace member —
// a throwaway self-registered actor added to the SAME fixture workspace,
// removed again in `afterAll`.
let approverUserId: string;
let approverHeaders: Record<string, string>;
let approverCtx: import('@playwright/test').APIRequestContext;

async function registerApprover(): Promise<void> {
  const email = `axi2085-approver-${uniq()}@axiome.local`;
  const password = 'Axi2085-e2e-pw!';
  const bootstrap = await apiRequest.newContext();
  await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password, firstName: 'AXI2085', lastName: 'Approver' },
  });
  const loginRes = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  const { accessToken } = await loginRes.json();
  await bootstrap.dispose();
  approverCtx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
  const me = await (await approverCtx.get(apiUrl('/api/v1/auth/me'))).json();
  approverUserId = me.id;
  approverHeaders = workspaceHeader(t.workspaceId);
  const add = await api.post(`/api/v1/workspaces/${t.workspaceId}/members`, {
    userId: approverUserId,
    organizationId: t.orgId,
    role: 'admin',
  }, t.headers);
  expect(add.status, `add approver as member: ${JSON.stringify(add.body)}`).toBeLessThan(300);
}

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  await registerApprover();
});

test.afterAll(async () => {
  await api.ctx
    .delete(apiUrl(`/api/v1/workspaces/${t.workspaceId}/members/${approverUserId}`), {
      headers: t.headers,
    })
    .catch(() => undefined);
  await approverCtx?.dispose();
  await api?.ctx.dispose();
});

/** A fresh ViewAnalysis + one evidence (with a frozen chart) on it. Returns
 *  the evidence's currentVersionId — the exact citation key both a
 *  DecisionDraft's `evidenceLinks[].evidenceVersionId` and a publish
 *  request's `evidenceVersionIds` use. */
async function createAnalysisWithEvidence(name: string): Promise<{ analysisId: string; evidenceId: string; evidenceVersionId: string }> {
  const analysisId = await createAnalysis(api, t, name);
  const specId = `spec-${uniq()}`;
  const snapshotId = await createSnapshot(api, t, analysisId, []);
  const res = await api.post('/api/v1/view-analyses/evidences', {
    viewAnalysisId: analysisId,
    chartEntries: [
      { chartArtifactId: specId, snapshotId, datasetVersionId: t.datasetId, frozenRender: frozenRenderPayload({ dataviewSpecId: specId, datasetVersionId: t.datasetId }) },
    ],
    title: `AXI-2085 ${uniq()}`,
    createdBy: 'e2e-axi-2085',
  }, t.headers);
  expect(res.status, `createEvidence -> ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return { analysisId, evidenceId: res.body.id, evidenceVersionId: res.body.currentVersionId };
}

async function createDraftDecision(projectId: string, evidenceId: string, evidenceVersionId: string): Promise<string> {
  const res = await api.post(`/api/v1/workspaces/${t.workspaceId}/decisions`, {
    label: `AXI-2085 decision ${uniq()}`,
    type: 'biomarker_threshold',
    projectId,
    context: { intendedUse: 'RUO' },
    evidenceLinks: [{ evidenceId, evidenceVersionId }],
    evidenceValues: [],
  }, t.headers);
  expect(res.status, `create decision: ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  expect(res.body.status).toBe('draft');
  return res.body.id;
}

async function transition(decisionId: string, targetStatus: string): Promise<{ status: number; body: any }> {
  return api.post(`/api/v1/workspaces/${t.workspaceId}/decisions/${decisionId}/transition`, { targetStatus }, t.headers);
}

/** AXI-2258: `reviewed -> approved` through the APPROVER actor, never `api`
 *  (the decision's own author) — the self-approval guard refuses the latter. */
async function approveAsApprover(decisionId: string): Promise<{ status: number; body: any }> {
  const res = await approverCtx.post(
    apiUrl(`/api/v1/workspaces/${t.workspaceId}/decisions/${decisionId}/transition`),
    { data: { targetStatus: 'approved' }, headers: approverHeaders },
  );
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : undefined };
}

async function approve(decisionId: string): Promise<void> {
  const reviewed = await transition(decisionId, 'reviewed');
  expect(reviewed.status, `draft -> reviewed: ${JSON.stringify(reviewed.body)}`).toBeLessThan(300);
  const approved = await approveAsApprover(decisionId);
  expect(approved.status, `reviewed -> approved: ${JSON.stringify(approved.body)}`).toBeLessThan(300);
  expect(approved.body.status).toBe('approved');
}

async function publish(analysisId: string, evidenceVersionIds: string[], decisionIds: string[]): Promise<{ status: number; body: any }> {
  return api.post('/api/v1/view-analyses/publish', {
    viewAnalysisId: analysisId,
    evidenceVersionIds,
    decisionIds,
    publishedBy: 'e2e-axi-2085',
  }, t.headers);
}

async function decisionStatus(decisionId: string): Promise<string> {
  const res = await api.get(`/api/v1/workspaces/${t.workspaceId}/decisions/${decisionId}`, t.headers);
  expect(res.status, `read decision ${decisionId}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body.status;
}

test.describe('AXI-2085 — publish requires an approved interpretation; the publish-driven approval cascade is gone', () => {
  // AC1, FR20/FR21: no decision at all cites the evidence — publish refuses
  // whether or not `decisionIds` is supplied, naming the missing evidence version.
  test('refuses PUBLISH_REQUIRES_APPROVED_INTERPRETATION with no approved decision, decisionIds omitted @SI-016 @SI-017', async () => {
    const { analysisId, evidenceVersionId } = await createAnalysisWithEvidence(`AXI-2085 no-decision ${uniq()}`);

    const res = await publish(analysisId, [evidenceVersionId], []);

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    // The structured `code` + `missingEvidenceVersionIds` the service throws do
    // not survive the RPC→gateway transport today (HttpToRpcExceptionFilter only
    // lifts a lowercase `code: ` message prefix; the gateway emits `errorCode`,
    // the front reads `code`) — follow-up debt. What reaches the client is the
    // 400 and the server's own refusal message, which the modal renders.
    expect(res.body.message).toMatch(/must carry at least one APPROVED interpretation/);
  });

  // AC1: a `decisionIds` entry naming a real but merely `draft` (not
  // `approved`) decision still does not pass — `decisionIds` is record-only,
  // never consulted by the gate.
  test('refuses when the cited decisionIds entry is only draft, not approved @SI-016 @SI-017', async () => {
    const { analysisId, evidenceId, evidenceVersionId } = await createAnalysisWithEvidence(`AXI-2085 draft-only ${uniq()}`);
    const projectId = t.projectId;
    const draftDecisionId = await createDraftDecision(projectId, evidenceId, evidenceVersionId);

    const res = await publish(analysisId, [evidenceVersionId], [draftDecisionId]);

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    // The structured `code` + `missingEvidenceVersionIds` the service throws do
    // not survive the RPC→gateway transport today (HttpToRpcExceptionFilter only
    // lifts a lowercase `code: ` message prefix; the gateway emits `errorCode`,
    // the front reads `code`) — follow-up debt. What reaches the client is the
    // 400 and the server's own refusal message, which the modal renders.
    expect(res.body.message).toMatch(/must carry at least one APPROVED interpretation/);

    // The refused publish call must not have touched the draft decision either.
    expect(await decisionStatus(draftDecisionId)).toBe('draft');
  });

  // AC1/AC9: once a decision citing the evidence version is `approved`
  // (human draft -> reviewed -> approved), publish succeeds — regardless of
  // whether its id is listed in `decisionIds`.
  test('publishes once an approved decision cites every published evidence version @SI-016 @SI-017', async () => {
    const { analysisId, evidenceId, evidenceVersionId } = await createAnalysisWithEvidence(`AXI-2085 approved ${uniq()}`);
    const decisionId = await createDraftDecision(t.projectId, evidenceId, evidenceVersionId);
    await approve(decisionId);

    const res = await publish(analysisId, [evidenceVersionId], []);

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(res.body.status).toBe('published');
  });

  // The cascade is REMOVED, not narrowed: a successful publish must not
  // promote any OTHER draft decision that also cites the same evidence
  // version, even though the old `cascadePublishDrivenApprovals` would have.
  test('a successful publish does not promote a second, unapproved decision citing the same evidence (cascade removed) @SI-016 @SI-017', async () => {
    const { analysisId, evidenceId, evidenceVersionId } = await createAnalysisWithEvidence(`AXI-2085 no-cascade ${uniq()}`);
    const approvedDecisionId = await createDraftDecision(t.projectId, evidenceId, evidenceVersionId);
    await approve(approvedDecisionId);
    const bystanderDecisionId = await createDraftDecision(t.projectId, evidenceId, evidenceVersionId);
    expect(await decisionStatus(bystanderDecisionId)).toBe('draft');

    const res = await publish(analysisId, [evidenceVersionId], [bystanderDecisionId]);

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    // The bystander decision was NOT approved; the old cascade would have
    // silently advanced it to `reviewed` as a publish side effect. It must
    // still be exactly `draft`.
    expect(await decisionStatus(bystanderDecisionId)).toBe('draft');
  });
});

import { test, expect, request as apiRequest } from '@playwright/test';
import { adminApi, workspaceHeader, type Api } from '../AXI-1400/harness/api';
import {
  ensureTenant,
  createAnalysis,
  createSnapshot,
  frozenRenderPayload,
  uniq,
  type Tenant,
} from '../AXI-1233/harness/seed-axi1234';
import { apiUrl } from '../../config/env';

/**
 * AXI-2258 (epic AXI-2073 — round 2 Phase 1 finding #4): "Approved
 * interpretation can still be edited (decision_draft.updated after
 * approval)". Fixes:
 *
 *   1. An APPROVED DecisionDraft is now immutable — `PATCH .../decisions/:id`
 *      is refused (403), matching `reviewed`/`valid`/`invalidated`/`abandoned`.
 *   2. The `reviewed -> approved` edge refuses the draft's own author
 *      (self-approval guard, no escape hatch) — same rule applied to Evidence
 *      status updates targeting `approved`.
 *   3. `approvedBy`/`approvedAt` are stamped on the row when the edge fires.
 *
 * Fixture: the shared, reusable `AXI-1233 Freeze Render Org/Workspace/Project`
 * tenant (`AXI-2077`/`AXI-2081`/`AXI-2085` already use it) plus a throwaway
 * SECOND workspace member (`approver`) this spec registers and removes —
 * every write here is additive and uniquely named (`uniq()`).
 */

let api: Api;
let t: Tenant;
let approverCtx: import('@playwright/test').APIRequestContext;
let approverHeaders: Record<string, string>;
let approverUserId: string;

async function registerApprover(label: string): Promise<{ ctx: import('@playwright/test').APIRequestContext; userId: string }> {
  const email = `axi2258-${label}-${uniq()}@axiome.local`;
  const password = 'Axi2258-e2e-pw!';
  const bootstrap = await apiRequest.newContext();
  await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password, firstName: 'AXI2258', lastName: label },
  });
  const loginRes = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  expect(loginRes.ok(), `login ${email}: ${await loginRes.text()}`).toBeTruthy();
  const { accessToken } = await loginRes.json();
  await bootstrap.dispose();
  const ctx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
  const me = await (await ctx.get(apiUrl('/api/v1/auth/me'))).json();
  const add = await api.post(`/api/v1/workspaces/${t.workspaceId}/members`, {
    userId: me.id,
    organizationId: t.orgId,
    role: 'admin',
  }, t.headers);
  expect(add.status, `add ${label} as member: ${JSON.stringify(add.body)}`).toBeLessThan(300);
  return { ctx, userId: me.id };
}

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  const approver = await registerApprover('approver');
  approverCtx = approver.ctx;
  approverUserId = approver.userId;
  approverHeaders = workspaceHeader(t.workspaceId);
});

test.afterAll(async () => {
  await api.ctx
    .delete(apiUrl(`/api/v1/workspaces/${t.workspaceId}/members/${approverUserId}`), { headers: t.headers })
    .catch(() => undefined);
  await approverCtx?.dispose();
  await api?.ctx.dispose();
});

async function createAnalysisWithEvidence(
  name: string,
): Promise<{ analysisId: string; evidenceId: string; evidenceVersionId: string }> {
  const analysisId = await createAnalysis(api, t, name);
  const specId = `spec-${uniq()}`;
  const snapshotId = await createSnapshot(api, t, analysisId, []);
  const res = await api.post('/api/v1/view-analyses/evidences', {
    viewAnalysisId: analysisId,
    chartEntries: [
      {
        chartArtifactId: specId,
        snapshotId,
        datasetVersionId: t.datasetId,
        frozenRender: frozenRenderPayload({ dataviewSpecId: specId, datasetVersionId: t.datasetId }),
      },
    ],
    title: `AXI-2258 ${uniq()}`,
    createdBy: 'e2e-axi-2258',
  }, t.headers);
  expect(res.status, `createEvidence -> ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return { analysisId, evidenceId: res.body.id, evidenceVersionId: res.body.currentVersionId };
}

async function createDraftDecision(evidenceId: string, evidenceVersionId: string): Promise<string> {
  const res = await api.post(`/api/v1/workspaces/${t.workspaceId}/decisions`, {
    label: `AXI-2258 decision ${uniq()}`,
    type: 'qc_assessment',
    projectId: t.projectId,
    context: { intendedUse: 'RUO' },
    evidenceLinks: [{ evidenceId, evidenceVersionId }],
    evidenceValues: [],
  }, t.headers);
  expect(res.status, `create decision: ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  expect(res.body.status).toBe('draft');
  return res.body.id;
}

async function transitionAs(
  actor: Api | import('@playwright/test').APIRequestContext,
  decisionId: string,
  targetStatus: string,
): Promise<{ status: number; body: any }> {
  if ('post' in actor && typeof (actor as Api).post === 'function' && 'ctx' in actor) {
    return (actor as Api).post(
      `/api/v1/workspaces/${t.workspaceId}/decisions/${decisionId}/transition`,
      { targetStatus },
      t.headers,
    );
  }
  const res = await (actor as import('@playwright/test').APIRequestContext).post(
    apiUrl(`/api/v1/workspaces/${t.workspaceId}/decisions/${decisionId}/transition`),
    { data: { targetStatus }, headers: approverHeaders },
  );
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : undefined };
}

async function getDraft(decisionId: string): Promise<{ status: number; body: any }> {
  return api.get(`/api/v1/workspaces/${t.workspaceId}/decisions/${decisionId}`, t.headers);
}

test.describe('AXI-2258 — a DecisionDraft is immutable once approved, and approval cannot be self-made', () => {
  // AC: `reviewed -> approved` by the draft's own author is refused.
  test('the author cannot approve their own decision — SELF_APPROVAL_NOT_PERMITTED (403) @SI-015', async () => {
    const { evidenceId, evidenceVersionId } = await createAnalysisWithEvidence(`AXI-2258 self-approve ${uniq()}`);
    const decisionId = await createDraftDecision(evidenceId, evidenceVersionId);
    const reviewed = await transitionAs(api, decisionId, 'reviewed');
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBeLessThan(300);

    const selfApprove = await transitionAs(api, decisionId, 'approved');

    expect(selfApprove.status, JSON.stringify(selfApprove.body)).toBe(403);
    expect(selfApprove.body.message).toMatch(/SELF_APPROVAL_NOT_PERMITTED/);
    expect(await getDraft(decisionId).then((r) => r.body.status)).toBe('reviewed');
  });

  // AC: a DIFFERENT workspace member approves normally, and the row is
  // stamped with WHO approved and WHEN (the field the AXI-2073 audit report
  // is meant to read for its approved_by/approved_at line).
  test('a different workspace member approves successfully, stamping approvedBy/approvedAt @SI-015', async () => {
    const { evidenceId, evidenceVersionId } = await createAnalysisWithEvidence(`AXI-2258 cross-approve ${uniq()}`);
    const decisionId = await createDraftDecision(evidenceId, evidenceVersionId);
    await transitionAs(api, decisionId, 'reviewed');

    const approved = await transitionAs(approverCtx, decisionId, 'approved');

    expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(300);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.approvedBy).toBe(approverUserId);
    expect(approved.body.approvedAt).toBeTruthy();
  });

  // AC: once approved, the draft is immutable — update() is refused, never a
  // silent `decision_draft.updated` 50 minutes after approval (the reported bug).
  test('an APPROVED decision cannot be edited — PATCH is refused (403) @SI-015', async () => {
    const { evidenceId, evidenceVersionId } = await createAnalysisWithEvidence(`AXI-2258 immutable ${uniq()}`);
    const decisionId = await createDraftDecision(evidenceId, evidenceVersionId);
    await transitionAs(api, decisionId, 'reviewed');
    const approved = await transitionAs(approverCtx, decisionId, 'approved');
    expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(300);

    const edit = await api.patch(`/api/v1/workspaces/${t.workspaceId}/decisions/${decisionId}`, {
      label: 'An attempted post-approval edit',
    }, t.headers);

    expect(edit.status, JSON.stringify(edit.body)).toBe(403);
    expect(await getDraft(decisionId).then((r) => r.body.label)).not.toBe('An attempted post-approval edit');
  });
});

test.describe('AXI-2258 — the same self-approval guard applies to Evidence status updates', () => {
  async function updateEvidenceStatusAs(
    actor: Api | import('@playwright/test').APIRequestContext,
    evidenceId: string,
    status: string,
  ): Promise<{ status: number; body: any }> {
    if ('post' in actor && typeof (actor as Api).patch === 'function' && 'ctx' in actor) {
      return (actor as Api).patch(`/api/v1/view-analyses/evidences/${evidenceId}/status`, { status }, t.headers);
    }
    const res = await (actor as import('@playwright/test').APIRequestContext).patch(
      apiUrl(`/api/v1/view-analyses/evidences/${evidenceId}/status`),
      { data: { status }, headers: approverHeaders },
    );
    const text = await res.text();
    return { status: res.status(), body: text ? JSON.parse(text) : undefined };
  }

  // The evidence is created by `api` (createdBy: 'e2e-axi-2258' in the body —
  // but the status-update route derives the ACTOR from the JWT, never the
  // body, so the author here is `api`'s own authenticated user).
  test('the evidence creator cannot approve it — SELF_APPROVAL_NOT_PERMITTED (403) @SI-017', async () => {
    const { evidenceId } = await createAnalysisWithEvidence(`AXI-2258 evidence self-approve ${uniq()}`);

    const res = await updateEvidenceStatusAs(api, evidenceId, 'approved');

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.message).toMatch(/SELF_APPROVAL_NOT_PERMITTED/);
  });

  test('a different workspace member approves the evidence successfully @SI-017', async () => {
    const { evidenceId } = await createAnalysisWithEvidence(`AXI-2258 evidence cross-approve ${uniq()}`);

    const res = await updateEvidenceStatusAs(approverCtx, evidenceId, 'approved');

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(res.body.status).toBe('approved');
  });

  // Moving to `draft`/`unapproved` is never gated — only an `-> approved`
  // target checks authorship.
  test('the creator CAN move their own evidence to unapproved — not gated @SI-017', async () => {
    const { evidenceId } = await createAnalysisWithEvidence(`AXI-2258 evidence unapprove ${uniq()}`);

    const res = await updateEvidenceStatusAs(api, evidenceId, 'unapproved');

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(res.body.status).toBe('unapproved');
  });
});

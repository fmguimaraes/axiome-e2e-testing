import { test, expect, request as apiRequest, type Page } from '@playwright/test';
import { workspaceHeader, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, createAnalysis, createSnapshot, frozenRenderPayload, uniq, type Tenant } from '../AXI-1233/harness/seed-axi1234';
import { apiUrl } from '../../config/env';

/**
 * This spec authenticates its own platform-admin `Api` client rather than the
 * shared `adminApi()` harness helper. `adminApi()` is pinned to the suite's
 * `config/roles.ts` "admin" identity (`test@axiomebio.com`), whose password is
 * a deliberately uncommitted, owner-provided secret (AXI-1895,
 * `docs/TEST-IDENTITY.md`) — unavailable to an unattended run against an
 * isolated sidecar stack that never had it provisioned. Every platform stack
 * (including a fresh sidecar) self-seeds its own bootstrap admin on boot
 * (`AdminBootstrapService`, `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD`)
 * with full platform-admin rights, which is sufficient for everything this
 * spec needs (org/workspace/project creation, workspace-member management) —
 * so this spec logs in as THAT identity, read from the same env vars the
 * platform itself defines, never a hardcoded credential.
 */
async function platformAdminApi(): Promise<Api> {
  const bootstrap = await apiRequest.newContext();
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() || 'admin@axiome.local';
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD?.trim() || 'admin';
  const res = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  if (!res.ok()) throw new Error(`platform admin login failed (${res.status()}) — set BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD`);
  const { accessToken } = await res.json();
  await bootstrap.dispose();
  const ctx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
  const parse = async (r: import('@playwright/test').APIResponse) => {
    const text = await r.text();
    let body: unknown;
    try { body = text.length ? JSON.parse(text) : undefined; } catch { body = { _raw: text }; }
    return { status: r.status(), body: body as any };
  };
  return {
    ctx,
    get: (path, headers) => ctx.get(apiUrl(path), { headers }).then(parse),
    post: (path, body, headers) => ctx.post(apiUrl(path), { data: body as any, headers }).then(parse),
    patch: (path, body, headers) => ctx.patch(apiUrl(path), { data: body as any, headers }).then(parse),
  };
}

/**
 * AXI-2303 (epic AXI-2060 — fast demo-deadline fix). `CreateDecisionDraftModal`
 * built `evidenceLinks` with only `{evidenceId}`/`{snapshotId, evidenceId}` — no
 * `evidenceVersionId` — so a decision the modal created could never match
 * AXI-2085's publish gate (`approvedEvidenceVersionIds`, matched by
 * `evidenceLinks[].evidenceVersionId`), even once approved: Publish always
 * refused `PUBLISH_REQUIRES_APPROVED_INTERPRETATION`. Fixed on both sides —
 * the modal now stamps `evidenceVersionId` on every link it builds
 * (`buildEvidenceLinksForSelection`), and `DecisionDraftsService.create` also
 * stamps it server-side for any caller that omits it.
 *
 * Scenario doc: manual-e2e/AXI-2060-Microbiote-IgG4-Study-Reproduction.md
 * (AXI-2303 section).
 *
 * This spec is READ/WRITE against the same reusable `AXI-1233 Freeze Render
 * Org/Workspace/Project` fixture tenant the sibling AXI-2085/AXI-2258 specs in
 * this file use — never project `4ff39166` or `b7b274bc`. The decision this
 * spec creates is authored by a throwaway self-registered `editor` workspace
 * member, through the REAL `CreateDecisionDraftModal` UI (the actual
 * regression surface — an API call that already supplies `evidenceVersionId`
 * would not exercise the bug this story fixes). It is approved by a SECOND
 * throwaway member (AXI-2258's self-approval guard refuses the decision's own
 * author) — the e2e harness's registered "admin" identity is
 * `test@axiomebio.com` (`config/roles.ts`, AXI-1895), not the product's local
 * dev-seed login `admin@cro-one.com`; this spec's approver is added to the
 * fixture workspace with role `admin` (the sibling AXI-2085 spec's own
 * pattern), which is the "admin approves" the coordinator's ask describes in
 * this harness's vocabulary.
 */

let api: Api;
let t: Tenant;
let authorUserId: string;
let authorEmail: string;
let authorPassword: string;
let approverUserId: string;
let approverHeaders: Record<string, string>;
let approverCtx: import('@playwright/test').APIRequestContext;

async function registerMember(label: string, role: 'editor' | 'admin'): Promise<{
  userId: string;
  email: string;
  password: string;
  headers: Record<string, string>;
  ctx: import('@playwright/test').APIRequestContext;
}> {
  const email = `axi2303-${label}-${uniq()}@axiome.local`;
  const password = 'Axi2303-e2e-pw!';
  const bootstrap = await apiRequest.newContext();
  await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password, firstName: 'AXI2303', lastName: label },
  });
  const loginRes = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  const { accessToken } = await loginRes.json();
  await bootstrap.dispose();
  const ctx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
  const me = await (await ctx.get(apiUrl('/api/v1/auth/me'))).json();
  const headers = workspaceHeader(t.workspaceId);
  const add = await api.post(`/api/v1/workspaces/${t.workspaceId}/members`, {
    userId: me.id,
    organizationId: t.orgId,
    role,
  }, t.headers);
  expect(add.status, `add ${label} as member: ${JSON.stringify(add.body)}`).toBeLessThan(300);
  return { userId: me.id, email, password, headers, ctx };
}

test.beforeAll(async () => {
  api = await platformAdminApi();
  t = await ensureTenant(api);
  const author = await registerMember('author', 'editor');
  authorUserId = author.userId;
  authorEmail = author.email;
  authorPassword = author.password;
  await author.ctx.dispose();
  const approver = await registerMember('approver', 'admin');
  approverUserId = approver.userId;
  approverHeaders = approver.headers;
  approverCtx = approver.ctx;
});

test.afterAll(async () => {
  await api.ctx.delete(apiUrl(`/api/v1/workspaces/${t.workspaceId}/members/${authorUserId}`), { headers: t.headers }).catch(() => undefined);
  await api.ctx.delete(apiUrl(`/api/v1/workspaces/${t.workspaceId}/members/${approverUserId}`), { headers: t.headers }).catch(() => undefined);
  await approverCtx?.dispose();
  await api?.ctx.dispose();
});

/** A fresh ViewAnalysis + one evidence (with a frozen chart) on it. */
async function createAnalysisWithEvidence(name: string): Promise<{ analysisId: string; evidenceId: string; evidenceVersionId: string }> {
  const analysisId = await createAnalysis(api, t, name);
  const specId = `spec-${uniq()}`;
  const snapshotId = await createSnapshot(api, t, analysisId, []);
  const res = await api.post('/api/v1/view-analyses/evidences', {
    viewAnalysisId: analysisId,
    chartEntries: [
      { chartArtifactId: specId, snapshotId, datasetVersionId: t.datasetId, frozenRender: frozenRenderPayload({ dataviewSpecId: specId, datasetVersionId: t.datasetId }) },
    ],
    title: name,
    createdBy: 'e2e-axi-2303',
  }, t.headers);
  expect(res.status, `createEvidence -> ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return { analysisId, evidenceId: res.body.id, evidenceVersionId: res.body.currentVersionId };
}

function seedWorkspaceScope(page: Page): Promise<void> {
  return page.addInitScript(([orgId, workspaceId, projectId]) => {
    localStorage.setItem('axiome-top-org', orgId as string);
    localStorage.setItem('axiome-active-workspace', workspaceId as string);
    localStorage.setItem('axiome-active-project', projectId as string);
  }, [t.orgId, t.workspaceId, t.projectId]) as unknown as Promise<void>;
}

async function signInAsAuthor(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(authorEmail);
  await page.locator('input[type="password"]').fill(authorPassword);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** AXI-2258: `reviewed -> approved` through the APPROVER actor, never the decision's own author. */
async function approveAsApprover(decisionId: string): Promise<{ status: number; body: any }> {
  const res = await approverCtx.post(
    apiUrl(`/api/v1/workspaces/${t.workspaceId}/decisions/${decisionId}/transition`),
    { data: { targetStatus: 'approved' }, headers: approverHeaders },
  );
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : undefined };
}

async function transition(decisionId: string, targetStatus: string): Promise<{ status: number; body: any }> {
  return api.post(`/api/v1/workspaces/${t.workspaceId}/decisions/${decisionId}/transition`, { targetStatus }, t.headers);
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
    publishedBy: 'e2e-axi-2303',
  }, t.headers);
}

async function getDecision(decisionId: string): Promise<any> {
  const res = await api.get(`/api/v1/workspaces/${t.workspaceId}/decisions/${decisionId}`, t.headers);
  expect(res.status, `read decision ${decisionId}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

async function bumpEvidenceVersion(evidenceId: string, analysisId: string): Promise<string> {
  const specId = `spec-${uniq()}`;
  const snapshotId = await createSnapshot(api, t, analysisId, []);
  const res = await api.patch(`/api/v1/view-analyses/evidences/${evidenceId}`, {
    chartEntries: [
      { chartArtifactId: specId, snapshotId, datasetVersionId: t.datasetId, frozenRender: frozenRenderPayload({ dataviewSpecId: specId, datasetVersionId: t.datasetId }) },
    ],
    performedBy: 'e2e-axi-2303',
  }, t.headers);
  expect(res.status, `bump evidence version: ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body.currentVersionId;
}

test.describe('AXI-2303 — an approved interpretation citing the evidence (via the Create Interpretation modal) unlocks publish', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // AC1, AC2: a decision built through the real modal carries evidenceVersionId
  // and, once approved, unlocks publish for that evidence version.
  test('the modal-authored decision carries evidenceVersionId; approving it unlocks Publish @SI-015 @SI-034', async ({ page }) => {
    const evidenceTitle = `AXI-2303 evidence ${uniq()}`;
    const { analysisId, evidenceId, evidenceVersionId } = await createAnalysisWithEvidence(evidenceTitle);
    const label = `AXI-2303 interpretation ${uniq()}`;

    await seedWorkspaceScope(page);
    await signInAsAuthor(page);
    await page.goto(`/projects/${t.projectId}/view-analyses/${analysisId}/decisions`);

    await page.getByRole('button', { name: 'Create Interpretation', exact: true }).click();
    await page.locator('input[placeholder="e.g., CD8+ T-cell phenotype classification"]').fill(label);
    const evidenceRow = page.locator('label', { hasText: evidenceTitle }).first();
    await evidenceRow.locator('input[type="checkbox"]').check();
    await page.locator('form button[type="submit"]').click();

    // The modal navigates to the new decision's detail page on success.
    await expect(page).toHaveURL(/\/decisions\/[^/]+/);
    const decisionId = page.url().match(/\/decisions\/([^/?]+)/)![1];

    const created = await getDecision(decisionId);
    expect(created.status).toBe('draft');
    expect(created.evidenceLinks).toContainEqual(
      expect.objectContaining({ evidenceId, evidenceVersionId }),
    );

    await approve(decisionId);
    const res = await publish(analysisId, [evidenceVersionId], []);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(res.body.status).toBe('published');
  });

  // AC3: the v1 approval does not carry over to a later evidence version — a
  // second, uncited evidence version still goes through AXI-2085's unmodified
  // gate.
  test('an approval against evidence v1 does not unlock publishing v2 @SI-015 @SI-017', async () => {
    const { analysisId, evidenceId, evidenceVersionId: v1 } = await createAnalysisWithEvidence(`AXI-2303 v1-v2 ${uniq()}`);
    const create = await api.post(`/api/v1/workspaces/${t.workspaceId}/decisions`, {
      label: `AXI-2303 v1 decision ${uniq()}`,
      type: 'biomarker_threshold',
      projectId: t.projectId,
      context: { intendedUse: 'RUO' },
      evidenceLinks: [{ evidenceId, evidenceVersionId: v1 }],
      evidenceValues: [],
    }, t.headers);
    expect(create.status, JSON.stringify(create.body)).toBeLessThan(300);
    await approve(create.body.id);

    const v2 = await bumpEvidenceVersion(evidenceId, analysisId);
    expect(v2).not.toBe(v1);

    const res = await publish(analysisId, [v2], []);

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.message).toMatch(/must carry at least one APPROVED interpretation/);
  });
});

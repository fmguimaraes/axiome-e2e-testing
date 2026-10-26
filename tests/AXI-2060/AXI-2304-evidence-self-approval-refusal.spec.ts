import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { ensureTenant, createAnalysis, createSnapshot, frozenRenderPayload, uniq, type Tenant } from '../AXI-1233/harness/seed-axi1234';
import type { Api } from '../AXI-1400/harness/api';
import { apiUrl } from '../../config/env';

/**
 * AXI-2304 (epic AXI-2060 — demo bug, 27/10): `EvidenceDetail.tsx`'s
 * `handleStatusChange` used to call `updateEvidenceStatus` with no try/catch,
 * so the backend's existing self-approval refusal (403
 * `SELF_APPROVAL_NOT_PERMITTED`, `evidence-approval-policy.ts`, AXI-2258) was
 * swallowed: the status pill silently stayed `draft` with no explanation.
 *
 * This is a FRONT-ONLY fix — the backend guard this spec exercises is
 * unchanged and already live on the shared demo backend. The spec drives the
 * browser against a WORKTREE Vite dev server carrying the fix (the shared
 * demo front-end at :5173 does not), via `BASE_URL`.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2304. Tags: @SI-034, @SI-015.
 *
 * Fixtures live in the reusable `AXI-1234 Freeze Render` org/workspace/
 * project (the same one AXI-2077/AXI-2081/AXI-2085/AXI-2086 already use) —
 * never project `4ff39166` or `b7b274bc`, and never the real Microbiote IgG4
 * demo project (`22585add`). Every analysis/evidence this spec creates is
 * uniquely named (`uniq()`) and throwaway.
 *
 * Design note (single browser actor, deliberately): the refusal
 * (`evidence-approval-policy.ts`) compares `currentVersion.createdBy` to
 * the ACTING user id — it has nothing to do with who is signed in to the
 * browser. `EvidenceDetail.tsx`'s `canManage` gate (needed to even open the
 * status menu) requires `user.userType === 'admin'`
 * (`AuthContext.tsx: apiUser.role === 'ADMIN'`), which a throwaway
 * self-registered actor does NOT have by default, and granting it would mean
 * promoting a fixture user to platform admin via `PATCH /users/:id` — a
 * privilege-grant call this spec deliberately avoids. So every browser
 * action below signs in as the already-admin `admin@cro-one.com` fixture
 * account; what varies between S1/S3 (refused) and S2 (accepted) is only the
 * `createdBy` on the evidence's current version — the admin's own id (self)
 * vs. a different, throwaway actor's id.
 *
 * `createdBy` is NOT a client-chosen body field on the HTTP route the browser
 * (and this spec) actually goes through: the gateway's evidence controller
 * strips any client-sent `createdBy` and stamps it from `@ActorId()` — the
 * CALLING token's own identity (`apps/gateway/src/proxy/view-analyses.
 * controller.ts`). So the "different actor" evidence for S2 is created with
 * the OTHER actor's OWN bearer token (`otherApi`, below) — never admin's —
 * or it would silently become another self-approval case.
 *
 * Own direct admin login (never `adminApi()`/the ROLES registry, AXI-1831
 * precedent): the `chromium` project's default `storageState` points at a
 * file only the `setup` project writes, and this spec runs with `--no-deps`
 * (it does its own sign-in, same as AXI-2295/AXI-2253) —
 * `test.use({ storageState: { cookies: [], origins: [] } })` below drops the
 * dependency on that file for both the browser context and any
 * `apiRequest.newContext()` call, which inherits the active project's `use`
 * config too.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin';

interface Actor {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

let api: Api;
let otherApi: Api;
let t: Tenant;
let admin: Actor;
/** A throwaway actor, never signed into the browser and never granted any
 *  UI permission — it authenticates only to create ITS OWN evidence via
 *  `otherApi` (so the gateway stamps `createdBy` as its own id), to play
 *  "a different actor" (AC2). */
let other: Actor;

/** Thin `Api` wrapper (get/post/patch -> {status, body}) over a bearer token — the
 *  shape `ensureTenant`/`createAnalysis`/`createSnapshot` expect. */
function buildApi(ctx: APIRequestContext): Api {
  const parse = async (res: import('@playwright/test').APIResponse) => {
    const text = await res.text();
    let body: unknown;
    try {
      body = text.length ? JSON.parse(text) : undefined;
    } catch {
      body = { _raw: text };
    }
    return { status: res.status(), body: body as any };
  };
  return {
    ctx,
    async get(path, headers) {
      return parse(await ctx.get(apiUrl(path), { headers }));
    },
    async post(path, body, headers) {
      return parse(await ctx.post(apiUrl(path), { data: body as any, headers }));
    },
    async patch(path, body, headers) {
      return parse(await ctx.patch(apiUrl(path), { data: body as any, headers }));
    },
  };
}

/** Log in (or self-register, for a throwaway email) and resolve the real user id. */
async function signInActor(email: string, password: string, selfRegister: boolean): Promise<Actor> {
  const bootstrap = await apiRequest.newContext();
  if (selfRegister) {
    await bootstrap.post(apiUrl('/api/v1/auth/register'), {
      data: { email, password, firstName: 'AXI2304', lastName: 'Actor' },
    });
  }
  const loginRes = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  expect(loginRes.ok(), `login ${email}: ${loginRes.status()} ${await loginRes.text()}`).toBeTruthy();
  const { accessToken, refreshToken } = await loginRes.json();

  const meCtx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
  const me = await (await meCtx.get(apiUrl('/api/v1/auth/me'))).json();
  await meCtx.dispose();
  await bootstrap.dispose();
  return { userId: me.id, accessToken, refreshToken };
}

/** Add a user as a workspace member so their own token is accepted on the
 *  create-evidence route. Idempotent: an "already a member" response on a
 *  re-run is tolerated, never asserted away. */
async function ensureWorkspaceMember(userId: string): Promise<void> {
  const res = await api.post(`/api/v1/workspaces/${t.workspaceId}/members`, {
    userId, organizationId: t.orgId, role: 'admin',
  }, t.headers);
  expect([200, 201, 204, 400, 409], `add member ${userId}: ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status);
}

/** A fresh ViewAnalysis + one evidence (with a frozen chart), created
 *  through `callerApi`'s OWN bearer token — the gateway stamps the
 *  version's `createdBy` from that token's identity, never from the body. */
async function createEvidenceAs(callerApi: Api, name: string): Promise<{ analysisId: string; evidenceId: string }> {
  const analysisId = await createAnalysis(callerApi, t, name);
  const specId = `spec-${uniq()}`;
  const snapshotId = await createSnapshot(callerApi, t, analysisId, []);
  const res = await callerApi.post('/api/v1/view-analyses/evidences', {
    viewAnalysisId: analysisId,
    chartEntries: [
      { chartArtifactId: specId, snapshotId, datasetVersionId: t.datasetId, frozenRender: frozenRenderPayload({ dataviewSpecId: specId, datasetVersionId: t.datasetId }) },
    ],
    title: `AXI-2304 ${uniq()}`,
  }, t.headers);
  expect(res.status, `createEvidence -> ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return { analysisId, evidenceId: res.body.id };
}

async function signInBrowser(page: Page, actor: Actor): Promise<void> {
  await page.addInitScript(
    ([access, refresh, org, ws]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [actor.accessToken, actor.refreshToken, t.orgId, t.workspaceId] as const,
  );
}

async function openEvidence(page: Page, analysisId: string, evidenceId: string): Promise<void> {
  await page.goto(`/projects/${t.projectId}/view-analyses/${analysisId}/evidences/${evidenceId}`);
  await expect(page.getByTestId('evidence-status-pill')).toBeVisible();
}

function statusPill(page: Page) {
  return page.getByTestId('evidence-status-pill');
}

function statusError(page: Page) {
  return page.getByTestId('evidence-status-change-error');
}

async function pickApproved(page: Page): Promise<void> {
  await statusPill(page).click();
  await page.getByTestId('evidence-status-option-approved').click();
}

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('AXI-2304 — evidence status change surfaces the self-approval refusal inline', { tag: ['@SI-034', '@SI-015'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 120000 });

  test.beforeAll(async () => {
    const adminCtx = await apiRequest.newContext();
    const loginRes = await adminCtx.post(apiUrl('/api/v1/auth/login'), {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(loginRes.ok(), `login ${ADMIN_EMAIL}: ${loginRes.status()} ${await loginRes.text()}`).toBeTruthy();
    const { accessToken, refreshToken } = await loginRes.json();
    const ctx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
    await adminCtx.dispose();
    api = buildApi(ctx);

    t = await ensureTenant(api);

    const meCtx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
    const me = await (await meCtx.get(apiUrl('/api/v1/auth/me'))).json();
    await meCtx.dispose();
    admin = { userId: me.id, accessToken, refreshToken };

    // Throwaway, never signed into the browser, never granted any UI
    // permission — it authenticates only to create its OWN evidence
    // (`otherApi`), to play "a different actor" (AC2).
    other = await signInActor(`axi2304-other-${uniq()}@axiome.local`, 'Axi2304-e2e-pw!', true);
    await ensureWorkspaceMember(other.userId);
    const otherCtx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${other.accessToken}` } });
    otherApi = buildApi(otherCtx);
  });

  test.afterAll(async () => {
    await otherApi?.ctx.dispose();
    await api?.ctx.dispose();
  });

  // AC1: the author's own approval attempt is refused inline; status stays draft.
  test('S1 — AC1: the author sees the server refusal and the pill stays Draft', async ({ page }) => {
    const { analysisId, evidenceId } = await createEvidenceAs(api, `AXI-2304 self-approval ${uniq()}`);

    await signInBrowser(page, admin);
    await openEvidence(page, analysisId, evidenceId);
    await expect(statusPill(page)).toContainText('Draft');

    await pickApproved(page);

    await expect(statusError(page)).toHaveText(
      'You created this evidence; a different actor must approve it.',
    );
    await expect(statusPill(page)).toContainText('Draft');
  });

  // AC3 (advisory, review bounce #1): reopening the menu clears the stale refusal.
  test('S3 — AC3 advisory: reopening the status menu clears the prior refusal', async ({ page }) => {
    const { analysisId, evidenceId } = await createEvidenceAs(api, `AXI-2304 self-approval reopen ${uniq()}`);

    await signInBrowser(page, admin);
    await openEvidence(page, analysisId, evidenceId);
    await pickApproved(page);
    await expect(statusError(page)).toBeVisible();

    // Reopen the menu (close, then open again) without picking anything.
    await statusPill(page).click();
    await statusPill(page).click();

    await expect(statusError(page)).toHaveCount(0);
  });

  // AC2: a different actor approves cleanly; no error shows.
  test('S2 — AC2: a different actor approves cleanly, no error shown', async ({ page }) => {
    const { analysisId, evidenceId } = await createEvidenceAs(otherApi, `AXI-2304 other-approval ${uniq()}`);

    await signInBrowser(page, admin);
    await openEvidence(page, analysisId, evidenceId);
    await expect(statusPill(page)).toContainText('Draft');

    await pickApproved(page);

    await expect(statusPill(page)).toContainText('Approved');
    await expect(statusError(page)).toHaveCount(0);
  });
});

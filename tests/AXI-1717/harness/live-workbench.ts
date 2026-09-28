import { expect, request as apiRequest, type Page } from '@playwright/test';
import { adminApi, type Api } from '../../AXI-1435/harness/api';
import {
  ensureTenant, ensureProject, ingestFixture, datasetVersionHash, ensureDefaultAnalysis, createViewAnalysis, bindEnvelope, ensureApprovedDiscoveryConfig,
} from '../../AXI-1507/harness/seed';
import { ensureAuthTokens, type AuthTokens } from '../../../config/auth';
import { ROLES } from '../../../config/roles';

/**
 * AXI-1722 (epic AXI-1717) — the LIVE workbench seed, lifted out of
 * `AXI-1721-step-resolver.spec.ts` so the row-binding, picker, cutoff-result and
 * association stories share ONE pre-Screen drive instead of re-deriving it.
 *
 * REAL BACKEND, LLM-FREE: the nine-step plan is a TEMPLATE instantiation
 * (`POST /discovery/plans`), never a planner call. Fixture: Riaz 2017 immune, 27
 * patients, `response` R/NR, `patient_id`, pre-treatment gene measurements.
 */

export const FIXTURE = 'riaz2017_immune_wide.csv';
export const MEASUREMENTS = ['CD27_pre', 'CD274_pre', 'CD8A_pre', 'CXCL9_pre', 'GZMB_pre', 'IFNG_pre', 'PDCD1_pre', 'STAT1_pre'];
export const SCREEN_OP = 'stats.screen_shortlist';
export const CUTOFF_OP = 'stats.cutoff_roc_youden';
export const SPLIT_OP = 'split.exploration_holdout';
export const FISHER_OP = 'stats.fisher_exact';
export const SETTLED = new Set(['SUCCEEDED', 'REUSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'CANCELLED']);

export interface Seeded {
  api: Api;
  t: Awaited<ReturnType<typeof ensureTenant>>;
  projectId: string;
  datasetId: string;
  /** The OPEN container: its plan declares no positive outcome class, so the cutoff's `positiveGroup` stays open (FR13). */
  viewAnalysisId: string;
  hash: string;
  instanceRunId: string;
  /** The DECLARED container: its plan declares `outcomePositiveLevel: 'R'`, so its own cutoff node binds `positiveGroup` (FR8). */
  declaredAnalysisId: string;
  declaredInstanceRunId: string;
}

/** Roles of the Riaz fixture: outcome = response (binary), subject = patient_id — the resolver's `role:` source. */
export const RIAZ_ROLES = {
  outcome: { state: 'declared', column: 'response', outcomeKind: 'binary' },
  subject: { state: 'declared', column: 'patient_id' },
  timepoint: { state: 'declared_uncaptured', reason: 'AXI-1717 e2e: pre-treatment only' },
  representation: { state: 'declared_uncaptured', reason: 'AXI-1717 e2e: bulk expression' },
  batch: { state: 'declared_uncaptured', reason: 'AXI-1717 e2e: none recorded' },
  site: { state: 'declared_uncaptured', reason: 'AXI-1717 e2e: single site' },
};

/**
 * The mock's Stratify step is the EXISTING statistical run-config modal, whose referent gate
 * needs a semantic profile whose field mappings match the subject key (`patient_id`). The
 * seeded `immuno_oncology` profile's aliases match the fixture's raw column name, so assigning
 * it to the project is enough — the same move the AXI-1435 harness makes. Idempotent.
 */
export async function ensureSubjectKeyMapped(api: Api, t: Awaited<ReturnType<typeof ensureTenant>>, projectId: string): Promise<void> {
  const matched = async (): Promise<boolean> => {
    const res = await api.get(`/api/v1/projects/${projectId}/field-mappings`, t.headers);
    const list: any[] = Array.isArray(res.body) ? res.body : res.body?.data ?? [];
    return list.some((m) => m.canonicalField === 'patient_id' && m.status === 'matched');
  };
  if (await matched()) return;
  const assigned = await api.patch(`/api/v1/projects/${projectId}/profile`, { profileId: 'immuno_oncology' }, t.headers);
  expect(assigned.status, `assign profile: ${JSON.stringify(assigned.body)}`).toBeLessThan(300);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await matched()) return;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error('the subject key (patient_id) never matched after assigning the immuno_oncology profile');
}

/**
 * Two containers on the same dataset, each with its own plan instance (D.8: one per analysis).
 * Screen R→NR over the measurements, no split taken. The OPEN one declares no positive outcome
 * class — the template records the cutoff analyses as declined and the cutoff step waits for the
 * author to NAME the class (FR12/FR13). The DECLARED one names `R`, so its cutoff node already
 * carries `positiveGroup` and the step binds it from upstream (FR8).
 *
 * `label` must be unique per run (a container holds at most ONE plan instance).
 */
export async function seedLiveWorkbench(label: string, projectName: string): Promise<Seeded> {
  const api = await adminApi();
  const t = await ensureTenant(api);
  const projectId = await ensureProject(api, t, projectName);
  const datasetId = await ingestFixture(api, t, FIXTURE);
  const hash = await datasetVersionHash(api, t, datasetId);
  await ensureApprovedDiscoveryConfig(api, t);
  await ensureDefaultAnalysis(api, t, projectId, datasetId); // links the dataset to the project (idempotent)
  await ensureSubjectKeyMapped(api, t, projectId);

  const instantiate = async (viewAnalysisId: string, questionKey: string, outcomePositiveLevel?: string): Promise<string> => {
    const bound = await bindEnvelope(api, t, viewAnalysisId);
    expect([200, 201], `envelope bind: ${JSON.stringify(bound.body)}`).toContain(bound.status);
    const planned = await api.post('/api/v1/discovery/plans', {
      viewAnalysisId, projectId, datasetId, datasetVersionHash: hash,
      questionKey, question: 'Which pre-treatment immune marker separates responders?',
      takeSplit: false, measurementColumns: MEASUREMENTS, comparisons: [{ from: 'R', to: 'NR' }], rankBy: 'qValue',
      outcomeColumn: 'response', patientKeyColumn: 'patient_id', ...(outcomePositiveLevel ? { outcomePositiveLevel } : {}),
    }, t.headers);
    expect(planned.status, `instantiate: ${JSON.stringify(planned.body)}`).toBe(201);
    expect(planned.body.instantiated, `refused: ${JSON.stringify(planned.body.reasons)}`).toBe(true);
    return planned.body.instance.runId as string;
  };
  const viewAnalysisId = await createViewAnalysis(api, t, projectId, datasetId, `${label} — (open)`);
  const instanceRunId = await instantiate(viewAnalysisId, label);
  const declaredAnalysisId = await createViewAnalysis(api, t, projectId, datasetId, `${label} — (declared R)`);
  const declaredInstanceRunId = await instantiate(declaredAnalysisId, `${label}-declared`, 'R');

  // AXI-1720 roles, confirmed — keyed by (workspace, dataset), so one confirmation serves both containers.
  // The roles route answers only for an analysis holding a discovery plan instance, hence after the plan.
  const rolesUrl = `/api/v1/discovery/analyses/${viewAnalysisId}/datasets/${datasetId}/roles`;
  const current = await api.get(rolesUrl, t.headers);
  expect(current.status, `GET roles: ${JSON.stringify(current.body)}`).toBe(200);
  if (!current.body.confirmed) {
    const put = await api.ctx.put(`${process.env.API_BASE_URL ?? 'http://localhost:3000'}${rolesUrl}`, { data: { roles: RIAZ_ROLES, confirm: true }, headers: t.headers });
    expect(put.status(), await put.text()).toBeLessThan(300);
  }
  // AXI-1807 item 6: every caller of this harness gets a container fresh off `instantiate`,
  // never one the platform has already driven. Assert it here, once, for both containers.
  await assertNothingHasRun(api, t, viewAnalysisId);
  await assertNothingHasRun(api, t, declaredAnalysisId);
  return { api, t, projectId, datasetId, viewAnalysisId, hash, instanceRunId, declaredAnalysisId, declaredInstanceRunId };
}

export const planUrl = (va: string) => `/api/v1/discovery/analyses/${va}/plan`;

/**
 * AXI-1807 item 6 — the harness sweep. Before AXI-1779's fix, `POST /discovery/plans`
 * EXECUTED d1-d10 on the caller's behalf, so every spec that seeded through this harness
 * inherited a container where several steps already claimed to be done. AXI-1779 changed
 * that: instantiating now only DECLARES the plan and starts nothing. `seedLiveWorkbench`
 * is the one place ~20 AXI-1717/1775 specs get their container from, so the "nothing has
 * run yet" invariant is asserted HERE, once, rather than trusted by each caller individually
 * — a caller that silently depended on a step already being settled fails at seed time with
 * a name, not deep inside its own assertions. Mirrors AXI-1790's per-node read (AC2/FR6).
 */
export async function assertNothingHasRun(api: Api, t: Awaited<ReturnType<typeof ensureTenant>>, viewAnalysisId: string): Promise<void> {
  const res = await api.get(planUrl(viewAnalysisId), t.headers);
  expect(res.status, `plan read: ${JSON.stringify(res.body)}`).toBe(200);
  // AXI-1807 advisory — `?? []` makes the loops below skip cleanly if `nodes`/`branches` were ever
  // ABSENT from the response, which would pass this assertion VACUOUSLY (the exact latent-green
  // shape this story exists to purge). A freshly-instantiated plan always declares its template
  // nodes, so assert the arrays are actually populated before trusting the per-item checks.
  expect((res.body.nodes ?? []).length, 'the plan read carries its declared nodes').toBeGreaterThan(0);
  for (const node of res.body.nodes ?? []) {
    expect(node, `node ${node.nodeId} of a freshly seeded container must claim no activity yet`)
      .toMatchObject({ status: null, runId: null });
  }
  for (const branch of res.body.branches ?? []) {
    for (const phase of branch.phases ?? []) {
      expect(phase.state, `phase ${phase.phase} of a freshly seeded container must not have started`).toBe('not_started');
    }
  }
}

export const stepUrl = (va: string, nodeRef: string, action: 'resolve' | 'submit') => `/api/v1/discovery/analyses/${va}/steps/${nodeRef}/${action}`;

/** AXI-1725 — the branch endpoints: `POST/GET …/branches`, `POST …/branches/:id/discard`. */
export const branchUrl = (va: string, branchId?: string) => `/api/v1/discovery/analyses/${va}/branches${branchId ? `/${branchId}/discard` : ''}`;

/** AXI-1750 (R12) — the governed holdout-decline record: `POST …/steps/:nodeRef/decline-holdout`. */
export const declineHoldoutUrl = (va: string, nodeRef: string) => `/api/v1/discovery/analyses/${va}/steps/${nodeRef}/decline-holdout`;

/** Poll the governed status until the step's OWN node (`<runId>__<nodeId>`) settles. */
export async function waitForNode(s: Seeded, runId: string, nodeId: string, attempts = 90): Promise<any> {
  let node: any = null;
  for (let i = 0; i < attempts; i++) {
    const st = (await s.api.get(`/api/v1/governed-execution/status?projectId=${s.projectId}&runId=${runId}`, s.t.headers)).body;
    node = (st?.nodes ?? []).find((n: any) => n.nodeId.endsWith(`__${nodeId}`)) ?? null;
    if (node && SETTLED.has(node.status)) return { node, status: st };
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`node ${nodeId} of run ${runId} did not settle: ${JSON.stringify(node)}`);
}

/** Submit a step through the resolver and wait for its node to SUCCEED; returns the governed run id. */
export async function submitStepAndWait(s: Seeded, viewAnalysisId: string, nodeRef: string, operationId: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await s.api.post(stepUrl(viewAnalysisId, nodeRef, 'submit'), { operationId, datasetId: s.datasetId, projectId: s.projectId, datasetVersionHash: s.hash, ...body }, s.t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.submitted, `refused: ${JSON.stringify(res.body.reasons)}`).toBe(true);
  const { node } = await waitForNode(s, res.body.runId, res.body.nodeId);
  expect(node.status, JSON.stringify(node)).toMatch(/SUCCEEDED|REUSED/);
  return res.body.runId as string;
}

/** The published library rule tagged `op:<operationId>` — the card the Screen step offers. */
export async function publishedRuleCode(s: Seeded, operationId: string): Promise<string> {
  const rules = await s.api.get('/api/v1/rules?limit=500', s.t.headers);
  const list: any[] = Array.isArray(rules.body) ? rules.body : rules.body?.rules ?? rules.body?.data ?? [];
  const rule = list.find((r) => (r.tags ?? []).includes(`op:${operationId}`) && r.status === 'published');
  expect(rule, `a published rule tagged op:${operationId}`).toBeTruthy();
  return rule.code as string;
}

/**
 * AXI-1818 (epic AXI-1717). The `admin` role's browser session — `access_token`
 * / `refresh_token` in `localStorage` — is minted exactly ONCE, by the auth
 * `setup` project (`tests/setup/auth.setup.ts`), and persisted to
 * `.auth/admin.json`; every test's fresh `page.context()` is restored from
 * that SAME file for the rest of the run. `JWT_EXPIRES_IN` (15m default,
 * `axiome-back/apps/user-service/src/config/configuration.ts`) is not set on
 * the `axiome-demo-backend` container, so a batch that runs longer than 15
 * minutes reaches the login screen for every test from then on: the page
 * loads, the app's own `apiRequest` 401-refresh (`axiome-front/src/lib/api/client.ts`)
 * never fires because it is never given a chance — the FIRST call the fresh
 * page makes (e.g. `/auth/me` on mount) already 401s with a token nobody
 * refreshed. Evidence: `axiome-e2e-testing/test-results/*​/error-context.md`
 * shows `heading "Welcome back"` where `driveToSplit`
 * (`tests/AXI-1717/harness/live-workbench.ts`) expects
 * `discovery-workbench`.
 *
 * FIX, same shape as `ShadowRunAuth`/`planWithRefresh` (AXI-1677,
 * `tests/AXI-1462/harness/shadow.ts`) but PROACTIVE rather than
 * reactive-on-401, because a browser page has no seam to intercept and retry
 * the app's own fetch calls: re-mint the admin tokens and push them into the
 * page's `localStorage` via `addInitScript` (so they land before the app's
 * own boot code runs) whenever the ELAPSED TIME since the last mint is
 * approaching `JWT_EXPIRES_IN` — never keyed to a test index, count, or
 * describe block, so it stays correct regardless of how the suite is
 * reshuffled or how many tests land in one window.
 */
const BROWSER_REAUTH_INTERVAL_MS = 8 * 60 * 1000; // safely under the 15m JWT_EXPIRES_IN default.
let browserAuthMintedAt = Date.now();
let refreshingBrowserAuth: Promise<AuthTokens> | null = null;

/** Mint a fresh admin token pair for the BROWSER session, coalescing concurrent callers. */
async function freshBrowserAuthTokens(): Promise<AuthTokens> {
  if (!refreshingBrowserAuth) {
    refreshingBrowserAuth = (async () => {
      const bootstrap = await apiRequest.newContext();
      const role = ROLES.find((r) => r.name === 'admin');
      if (!role) throw new Error('admin role missing from ROLES registry');
      const tokens = await ensureAuthTokens(bootstrap, role);
      await bootstrap.dispose();
      return tokens;
    })().finally(() => { refreshingBrowserAuth = null; });
  }
  return refreshingBrowserAuth;
}

/** The workspace/org the workbench reads from localStorage, plus (AXI-1818) a
 *  time-driven re-mint of the auth tokens `storageState` froze at suite setup. */
export async function primeWorkspace(page: Page, s: Seeded): Promise<void> {
  await page.addInitScript(([ws, org]) => {
    localStorage.setItem('axiome-active-workspace', ws);
    localStorage.setItem('axiome-top-org', org);
  }, [s.t.workspaceId, s.t.orgId] as const);

  if (Date.now() - browserAuthMintedAt >= BROWSER_REAUTH_INTERVAL_MS) {
    const tokens = await freshBrowserAuthTokens();
    browserAuthMintedAt = Date.now();
    await page.addInitScript(([access, refresh]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
    }, [tokens.accessToken, tokens.refreshToken] as const);
  }
}

/**
 * AXI-1818 test-only seam: force `primeWorkspace`'s next call to treat the
 * browser session as stale, without waiting out `BROWSER_REAUTH_INTERVAL_MS`
 * for real. Exercises the EXACT SAME re-mint code path `primeWorkspace` runs
 * mid-batch — this only fast-forwards the clock check, never bypasses the
 * mint/inject logic itself. Never called outside a spec.
 */
export function forceBrowserAuthStaleForTest(): void {
  browserAuthMintedAt = 0;
}

/**
 * Population → confirm → Continue → Stratify on `response` (every level) → the
 * Split node becomes visible, whatever its holdout state already is (decided
 * from a PRIOR session, or undecided). `analysisId` null = the AXI-1719
 * preview path.
 *
 * AXI-1760 (FR4) — lifted out of `driveToScreen` so a rehydration spec can
 * mount fresh, reach the Split node, and assert what renders WITHOUT ever
 * clicking take/decline in this session (that click is exactly what a
 * rehydration test must not need).
 */
export async function driveToSplit(page: Page, projectId: string, analysisId: string | null): Promise<void> {
  await page.goto(`/projects/${projectId}/discovery-workbench${analysisId ? `?analysisId=${analysisId}` : ''}`);
  await expect(page.getByTestId('discovery-workbench')).toBeVisible({ timeout: 30_000 });
  // AXI-1793 (FR8, EC2): a LIVE workbench restores what the server recorded on mount. Wait for
  // the read to settle (a front without the signal never reads `reading`, so this passes at once);
  // an instance the server already holds records for is restored — base confirmed, split decided —
  // and must not be driven through the confirm/stratify clicks a second time.
  if (analysisId) await expect(page.getByTestId('discovery-workbench')).not.toHaveAttribute('data-restore-status', 'reading', { timeout: 60_000 });
  if (analysisId && await page.getByTestId('population-confirmed').isVisible()) {
    await expect(page.getByTestId('workbench-split-node')).toBeVisible({ timeout: 30_000 });
    return;
  }
  const confirm = page.getByTestId('population-confirm');
  await expect(confirm).toBeEnabled({ timeout: 60_000 });
  await confirm.click();
  await page.getByTestId('population-continue').click();
  const field = page.getByTestId('stratify-partition-field');
  await expect(field).toBeVisible({ timeout: 30_000 });
  await field.getByRole('radio', { name: /response/i }).click();
  await page.getByTestId('stratify-select-all-levels').click();
  await page.getByRole('button', { name: 'Run rule' }).click();
  await expect(page.getByTestId('workbench-split-node')).toBeVisible({ timeout: 30_000 });
}

/**
 * Population → confirm → Continue → Stratify on `response` (every level) → decline the
 * holdout → the Screen node. `analysisId` null = the AXI-1719 preview path.
 */
export async function driveToScreen(page: Page, projectId: string, analysisId: string | null): Promise<void> {
  await driveToSplit(page, projectId, analysisId);
  // AXI-1793: restored with the holdout already decided — the Screen node is already on the canvas.
  if (analysisId && await page.getByTestId('split-holdout-decision').isVisible()) {
    await expect(page.getByTestId('workbench-screen-node')).toBeVisible({ timeout: 30_000 });
    return;
  }
  await page.getByTestId('split-decline-holdout').click();
  if (analysisId) {
    // AXI-1750 (R12): in LIVE mode the decline is a governed record with a
    // reason — the button opens a modal instead of declining immediately
    // (the PREVIEW path below still declines on the one click, unchanged).
    await page.getByTestId('split-decline-reason-input').fill('e2e: exploratory arm, holdout not needed');
    await page.getByTestId('split-decline-confirm').click();
  }
  await expect(page.getByTestId('workbench-screen-node')).toBeVisible({ timeout: 30_000 });
}

/**
 * Run the plan-step screen rule and wait for the LIVE rows to land on the result node.
 * AXI-1794 (FR15): the card opens the run-config modal ("Configure and run") and the run is
 * launched from its "Run rule" button. A front before AXI-1794 launches on the card click
 * alone and shows no modal, so the modal step is taken only when the modal appears.
 */
export async function runLiveScreen(page: Page, screenRuleCode: string): Promise<void> {
  await page.getByTestId('screen-choose-rule').click();
  await page.getByTestId(`screen-rule-run-${screenRuleCode}`).click();
  await confirmScreenRunConfig(page);
  const result = page.getByTestId(`workbench-screen-result-${screenRuleCode}`);
  await expect(result.getByTestId('screen-result-count')).toContainText(`${MEASUREMENTS.length} screened`, { timeout: 240_000 });
  await expect(result.getByTestId('screen-result-badge')).toHaveText('live');
}

/** AXI-1794 — confirm the screen's run-config modal if one opens; the modal closes once the launch lands. */
export async function confirmScreenRunConfig(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: /^Configure / });
  const opened = await dialog.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
  if (!opened) return;
  const run = dialog.getByRole('button', { name: 'Run rule' });
  await expect(run).toBeEnabled({ timeout: 30_000 });
  await run.click();
  await expect(dialog, 'the governed launch was refused (the modal stays open with its reason)').toBeHidden({ timeout: 60_000 });
}

/** AXI-1795 — the association attempt routes: `POST …/association-attempts/{archive|choose}`, `GET …/association-attempts/:runId`. */
export const associationAttemptsUrl = (va: string, tail: 'archive' | 'choose' | string) => `/api/v1/discovery/analyses/${va}/association-attempts/${tail}`;

/**
 * AXI-1795 (FR21) — a REAL settled cutoff proposal for `marker` on `va`: the live
 * Association consumes the analysis's first settled cutoff choice and refuses without
 * one (never a preview median). Screen first (the cutoff's upstream), then the cutoff.
 */
export async function seedCutoffProposal(s: Seeded, va: string, marker: string): Promise<{ screenRunId: string; cutoffRunId: string }> {
  const screenRunId = await submitStepAndWait(s, va, 'screen', SCREEN_OP);
  const cutoffRunId = await submitStepAndWait(s, va, 'cutoff', CUTOFF_OP, {
    selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker } },
  });
  return { screenRunId, cutoffRunId };
}

/**
 * AXI-1795 — run ONE association attempt (first outcome, first rule) and choose it with a
 * note. Live: the run is governed, so the radio enables only once the server's readout
 * states a result, and the note is required. Preview (a front before AXI-1795): the radio
 * is enabled at once and the note is optional — the same clicks serve both. A branch the
 * server already records as chosen (a restored workbench) is left as it is.
 */
export async function chooseLiveAssociation(page: Page, note = 'e2e: the one attempt this branch ran'): Promise<void> {
  const face = page.getByTestId('association-face').or(page.getByTestId('association-face-done'));
  await expect(face).toBeVisible({ timeout: 30_000 });
  if (await page.getByTestId('association-face-done').isVisible()) return;
  await page.getByTestId('association-expand').click();
  const modal = page.getByTestId('workbench-association-modal');
  if (await modal.locator('input[name="assoc-choose"]').count() === 0) {
    await modal.getByTestId('assoc-outcomes').getByRole('button').first().click();
    await modal.getByTestId('assoc-rules').getByRole('button').first().click();
    await modal.getByTestId('assoc-run').click();
    await expect(modal.getByTestId('assoc-run-error'), 'the governed association launch was refused').toHaveCount(0, { timeout: 30_000 });
  }
  const radio = modal.locator('input[name="assoc-choose"]:enabled').first();
  await expect(radio, 'no attempt with a readable server result').toBeVisible({ timeout: 240_000 });
  await radio.check();
  await modal.getByTestId('assoc-note').fill(note);
  await modal.getByTestId('assoc-choose').click();
  await expect(modal, 'the server refused the choice (the modal stays open with its reason)').toBeHidden({ timeout: 30_000 });
}

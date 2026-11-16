import { test, expect, request as apiRequest, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld, access } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';

/**
 * AXI-2581 (epic AXI-2433) — the Investigator Study page's review, signing and state 8
 * (Human-Guided FR101, FR102; Plan Before Data FR38 with OQ-C ruled 2026-11-16: a signature is
 * actor + timestamp + content hash, no re-authentication; FR39).
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md § "AXI-2581"
 * (AXI-2581.1 .. .5, all `automation: playwright`).
 *
 AXI-2581.2 is a UI walk on `/investigator` (the Study page, front half on AXI-2576): state 7 with
 * one card already reviewed "Needs a follow-up" (.4, API), "Sign the report" disabled with "Review all
 * 2 results first", "Question answered" on the other card, Sign, then state 8 "Report v1 signed",
 * "Signed by {name} on {dd/mm/yyyy}", "Download signed report" and "Open plan v2 draft" (the follow-up
 * draft does not take the page back to state 2). The rest is API-level, on the routes the page calls.
 *
 * World and setup are AXI-2579's: a private project, a v1 SAP with TWO primary T1 questions finalised
 * against a ready dataset, one SAP run evaluated to `completed`. The investigator (seeded Investigator
 * role, a self-registered user this spec signs in through the login page) is granted editor access
 * in .1; the viewer holds viewer access.
 *
 * Rights (Plan Before Data FR40, owner ruling 2026-11-16): recording a review and signing read
 * `sap:read` + `sap:review`. The world grants `sap:review` by ROLE, where it granted the interim
 * `sap:run` before: the Investigator (role 0105 — the gateway always unions the code's
 * INVESTIGATOR_PERMISSIONS) and the editor (legacy `editor` role, ROLE_PERMISSIONS) hold it; the
 * viewer does not. On a database whose seeded role rows predate seed step 19 the code fallback
 * still grants it to these two actors.
 *
 * Serial order: .5a (no access) -> .1 -> .4 -> .2 -> .3 -> .5b (viewer).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-065', '@SI-066', '@SI-010', '@SI-002'] };
const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const READY_WAIT_MS = 120_000;
const EVALUATION_WAIT_MS = 180_000;
const SETUP_TIMEOUT_MS = 8 * 60_000;

let world: PrivateProjectsWorld;
let editor: Actor;
let investigator: Actor;
let viewer: Actor;
let project: string;
let sap: any;
let t1Version: string;
let sapRunId: string;
let followUpQuestionId: string;
let uiQuestionId: string;
let followUpReviewId: string;
let signOff: any;
let investigatorLogin: { email: string; password: string; accessToken: string };

const base = (projectId: string) => apiUrl(`/api/v1/projects/${projectId}`);
const runsPath = (suffix = '') => `${base(project)}/saps/${sap.id}/runs${suffix}`;
const reviewsPath = () => runsPath(`/${sapRunId}/question-reviews`);
const signOffPath = (suffix = '') => runsPath(`/${sapRunId}/sign-off${suffix}`);
const amendmentPath = (reviewId: string) => `${reviewsPath()}/${reviewId}/amendment`;
const versionPath = (version: number) => `${base(project)}/saps/${sap.id}/versions/${version}`;
const requestId = (label: string) => `axi2581-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function pinNewestT1(): Promise<string> {
  const res = await editor.api.get(`${base(project)}/sap-templates`);
  expect(res.status(), await res.text()).toBe(200);
  const newest = (await res.json()).find((e: any) => e.templateId === 'T1' && e.isNewest);
  expect(newest, 'the catalog lists a newest T1').toBeTruthy();
  return newest.templateVersion;
}

function primaryQuestion(text: string) {
  return {
    text,
    role: 'primary',
    estimand: {
      population: 'All randomised subjects',
      variable: 'Score at week 12',
      intercurrentEvents: 'Treatment policy',
      populationSummary: 'Difference in medians',
      treatmentComparison: 'Arm A vs arm B',
    },
    template: { templateId: 'T1', templateVersion: t1Version },
    bindings: [
      { slot: 'groupingColumn', column: 'arm', semanticRole: 'grouping_two_levels' },
      { slot: 'outcome', column: 'score', semanticRole: 'continuous' },
    ],
    parameters: { alpha: 0.05, sidedness: 'two_sided' },
    decisionCriterion: { kind: 'p_at_or_below_alpha' },
    sensitivityAnalyses: [],
  };
}

async function privateProject(): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2581 signing ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id;
  expect((await access.visibility(editor, id, 'private')).status()).toBe(200);
  return id;
}

async function uploadDataset(): Promise<string> {
  const datasets = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`);
  const init = await editor.api.post(datasets, {
    data: { organizationId: world.orgId, originalFilename: `axi2581-${Date.now()}.csv`, contentType: 'text/csv' },
  });
  expect(init.status(), await init.text()).toBeLessThan(300);
  const { dataset: created, presignedUrl } = await init.json();
  const rows = Array.from({ length: 16 }, (_, i) => {
    const arm = i % 2 === 0 ? 'A' : 'B';
    const score = arm === 'A' ? 20 + i * 0.7 : 5 + i * 0.3;
    return `S${i + 1},${arm},${score.toFixed(1)}`;
  });
  const put = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/csv' },
    body: `subject_id,arm,score\n${rows.join('\n')}\n`,
  });
  expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
  const finalize = await editor.api.patch(`${datasets}/${created.id}/finalize`);
  expect(finalize.status(), await finalize.text()).toBeLessThan(300);
  return created.id;
}

async function readyIngestion(datasetId: string): Promise<string> {
  const path = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets/${datasetId}`);
  let id = '';
  await expect
    .poll(
      async () => {
        const res = await editor.api.get(path);
        const latest = res.ok() ? (await res.json()).latestIngestion : null;
        if (latest?.status === 'ready') id = latest.id;
        return latest?.status ?? 'none';
      },
      { timeout: READY_WAIT_MS, intervals: [2_000, 5_000] },
    )
    .toBe('ready');
  return id;
}

async function finaliseSap(datasetId: string): Promise<any> {
  const draft = await (await editor.api.post(`${base(project)}/saps/draft`)).json();
  const titled = await editor.api.put(`${base(project)}/saps/${draft.sapId}/draft`, {
    data: { basedOnRevision: draft.revision, title: 'AXI-2581 signing plan' },
  });
  expect(titled.status(), await titled.text()).toBe(200);
  const first = await editor.api.post(`${base(project)}/saps/${draft.sapId}/draft/questions`, {
    data: {
      basedOnRevision: (await titled.json()).revision,
      analysisDatasetId: datasetId,
      question: primaryQuestion('Does arm A change the score compared with arm B?'),
    },
  });
  expect(first.status(), await first.text()).toBe(201);
  const added = await editor.api.post(`${base(project)}/saps/${draft.sapId}/draft/questions`, {
    data: {
      basedOnRevision: (await first.json()).revision,
      analysisDatasetId: datasetId,
      question: primaryQuestion('Is the week-12 score higher in arm A than in arm B?'),
    },
  });
  expect(added.status(), await added.text()).toBe(201);
  const complete = await added.json();
  await expect
    .poll(
      async () => {
        const report = await (await editor.api.get(`${base(project)}/saps/${draft.sapId}/draft/completeness`)).json();
        return report.results.filter((r: any) => r.status === 'fail').map((r: any) => r.checkId);
      },
      { timeout: READY_WAIT_MS, intervals: [2_000, 5_000] },
    )
    .toEqual([]);
  const finalised = await editor.api.post(`${base(project)}/saps/${draft.sapId}/draft/finalise`, {
    data: { basedOnRevision: complete.revision, basedOnVersion: null },
  });
  expect(finalised.status(), await finalised.text()).toBe(201);
  return finalised.json();
}

async function completedRun(id: string): Promise<any> {
  let latest: any = null;
  await expect
    .poll(
      async () => {
        const res = await editor.api.get(runsPath(`/${id}`));
        latest = res.ok() ? await res.json() : null;
        return latest?.status ?? `http ${res.status()}`;
      },
      { timeout: EVALUATION_WAIT_MS, intervals: [3_000, 5_000] },
    )
    .not.toBe('running');
  return latest;
}

async function reviewsOf(actor: Actor): Promise<any> {
  const res = await actor.api.get(reviewsPath());
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function review(questionId: string, outcome: 'answered' | 'follow_up'): Promise<any> {
  const res = await investigator.api.post(reviewsPath(), { data: { questionId, outcome } });
  expect(res.status(), await res.text()).toBe(201);
  const recorded = await res.json();
  expect(recorded.exercisedRight, 'reviews are recorded under sap:review (FR40)').toBe('sap:review');
  return recorded;
}

/** dd/mm/yyyy in LOCAL time — the page formats in the browser's zone, which is this host's. */
function ddmmyyyy(iso: string): string {
  const d = new Date(iso);
  return [d.getDate(), d.getMonth() + 1].map((n) => String(n).padStart(2, '0')).join('/') + `/${d.getFullYear()}`;
}

/**
 * The investigator, self-registered HERE (not through `world.actor`) so the spec keeps his
 * credentials for the real login page. Disposed in afterAll.
 */
async function investigatorActor(): Promise<Actor> {
  const email = `axi2581-investigator-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const password = 'AXI2581-e2e-pw!';
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password, firstName: 'AXI2581', lastName: 'Investigator' },
  });
  expect(registered.status(), await registered.text()).toBeLessThan(300);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  expect(login.status(), await login.text()).toBeLessThan(300);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': world.workspaceId },
  });
  const me = await api.get(apiUrl('/api/v1/auth/me'));
  expect(me.status(), await me.text()).toBe(200);
  investigatorLogin = { email, password, accessToken };
  return { userId: (await me.json()).id, api };
}

/**
 * Real login page, then the study keys, then ONE full load of /investigator (AXI-2324's signIn: the
 * WorkspaceContext drops `axiome-active-workspace` on a hard load that precedes session restore).
 */
async function openStudyPage(page: Page): Promise<void> {
  await silenceTours(investigatorLogin.accessToken);
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(investigatorLogin.email);
  await page.locator('input[type="password"]').fill(investigatorLogin.password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.evaluate(([orgId, workspaceId, projectId]) => {
    localStorage.setItem('axiome-top-org', orgId as string);
    localStorage.setItem('axiome-active-workspace', workspaceId as string);
    localStorage.setItem('axiome-active-project', projectId as string);
  }, [world.orgId, world.workspaceId, project]);
  await page.goto('/investigator');
  await expect(page.getByTestId('investigator-home')).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  test.setTimeout(SETUP_TIMEOUT_MS);
  world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  investigator = await investigatorActor();
  viewer = await world.actor('viewer');
  await world.addMember(editor, 'editor');
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  await world.addMember(viewer, 'viewer');
  project = await privateProject();
  expect((await access.grant(editor, project, viewer.userId, 'viewer')).status()).toBeLessThan(300);
  t1Version = await pinNewestT1();
  const dataset = await uploadDataset();
  const linked = await editor.api.post(`${base(project)}/datasets`, { data: { datasetId: dataset } });
  expect(linked.status(), await linked.text()).toBeLessThan(300);
  const ingestion = await readyIngestion(dataset);
  sap = await finaliseSap(dataset);
  const started = await editor.api.post(runsPath(), {
    data: { datasetVersionId: ingestion, clientRequestId: requestId('run') },
  });
  expect(started.status(), await started.text()).toBe(201);
  sapRunId = (await started.json()).sapRunId;
  const run = await completedRun(sapRunId);
  expect(run.status, 'the SAP run completes before it can be signed').toBe('completed');
  expect(run.questions.length, 'the plan holds two questions').toBe(2);
  followUpQuestionId = run.questions[0].questionId;
  uiQuestionId = run.questions[1].questionId;
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2581 — Investigator Study page: review, signing and state 8', TAGS, () => {
  test('FR101 — AXI-2581.5: a user without access to the private project can neither sign nor download; nothing is written', async () => {
    // Act
    const sign = await investigator.api.post(signOffPath());
    const download = await investigator.api.get(signOffPath('/report'));

    // Assert
    expect([403, 404], await sign.text()).toContain(sign.status());
    expect(download.status(), await download.text()).toBe(404);
    expect((await reviewsOf(editor)).signOff).toBeNull();
  });

  test('FR101, FR38 — AXI-2581.1: signing is refused 409 SAP_RUN_NOT_FULLY_REVIEWED while a question is unreviewed', async () => {
    // Arrange — now granted the project
    expect((await access.grant(editor, project, investigator.userId, 'editor')).status()).toBeLessThan(300);

    // Act
    const res = await investigator.api.post(signOffPath());

    // Assert
    expect(res.status(), await res.text()).toBe(409);
    const body = await res.json();
    expect(body.errorCode).toBe('SAP_RUN_NOT_FULLY_REVIEWED');
    expect(body.errors).toHaveLength(2);
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'questionId', message: expect.stringContaining(followUpQuestionId) }),
        expect.objectContaining({ field: 'questionId', message: expect.stringContaining(uiQuestionId) }),
      ]),
    );
    expect((await reviewsOf(investigator)).signOff).toBeNull();
  });

  test('FR102, FR39 — AXI-2581.4: "Needs a follow-up" creates the plan v2 draft holding the question and leaves v1 unchanged', async () => {
    // Arrange
    const before = await editor.api.get(versionPath(1));
    expect(before.status(), await before.text()).toBe(200);
    const v1Before = await before.json();
    const followUp = await review(followUpQuestionId, 'follow_up');
    followUpReviewId = followUp.reviewId;

    // Act
    const res = await investigator.api.post(amendmentPath(followUp.reviewId));

    // Assert — a draft for v2 based on v1, the follow-up persisted in it
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.draft.sapId).toBe(sap.id);
    expect(body.draft.basedOnVersion).toBe(1);
    expect(body.followUpQuestionId, 'the follow-up question is in the draft').toBeTruthy();
    const draftQuestionIds = (body.draft.plan?.questions ?? []).map((q: any) => q.questionId);
    expect(draftQuestionIds).toContain(body.followUpQuestionId);
    // v1 is byte-identical
    const after = await editor.api.get(versionPath(1));
    expect(after.status(), await after.text()).toBe(200);
    expect(await after.json()).toEqual(v1Before);
  });

  test('FR101, FR102, FR38 — AXI-2581.2: on the Study page the Investigator answers the last question and signs; state 7 -> 8 with "Signed by {name} on {dd/mm/yyyy}"', async ({ page }) => {
    test.setTimeout(3 * 60_000);
    // Arrange — state 7: one card reviewed (follow-up, .4), one not
    await openStudyPage(page);
    const status = page.getByTestId('study-status-block');
    const sign = page.getByTestId('study-primary-action');
    const followUpCard = page.locator(`[data-testid="study-result-card"][data-question-id="${followUpQuestionId}"]`);
    const uiCard = page.locator(`[data-testid="study-result-card"][data-question-id="${uiQuestionId}"]`);
    await expect(status).toHaveAttribute('data-study-state', '7', { timeout: 60_000 });
    await expect(followUpCard.getByTestId('study-result-reviewed-line')).toHaveText('Needs a follow-up · moved to plan v2 draft');
    await expect(followUpCard.getByTestId('study-review-answered')).toHaveCount(0);
    await expect(page.getByTestId('study-results')).toContainText('1 of 2 reviewed');
    await expect(sign).toHaveText('Sign the report');
    await expect(sign).toBeDisabled();
    await expect(sign).toHaveAttribute('title', 'Review all 2 results first');

    // Act — "Question answered" on the last card, then "Sign the report"
    await uiCard.getByTestId('study-review-answered').click();
    await expect(uiCard.getByTestId('study-result-reviewed-line')).toHaveText(/^Answered · confirmed by .+, \d{2}\/\d{2}$/);
    await expect(uiCard.getByTestId('study-review-answered')).toHaveCount(0);
    await expect(sign).toBeEnabled();
    await sign.click();

    // Assert — state 8 on the page
    await expect(status).toHaveAttribute('data-study-state', '8', { timeout: 30_000 });
    await expect(status).toContainText('Report v1 signed');
    await expect(status).toContainText(`on ${ddmmyyyy(new Date().toISOString())}.`);
    await expect(status).toContainText('1 follow-up moved to plan v2 draft.');
    await expect(page.getByTestId('study-primary-action')).toHaveText('Download signed report');
    await expect(page.getByTestId('study-secondary-action')).toHaveText('Open plan v2 draft');
    await expect(page.getByTestId('study-review-error')).toHaveCount(0);
    await expect(page.locator('[data-testid="study-review-answered"], [data-testid="study-review-follow_up"]')).toHaveCount(0);

    // Assert — the sign-off record behind it: signer from the token, plan version, both reviews
    const state8 = await reviewsOf(investigator);
    signOff = state8.signOff;
    expect(signOff).toMatchObject({
      sapRunId,
      sapId: sap.id,
      planVersion: 1,
      signerUserId: investigator.userId,
      exercisedRight: 'sap:review',
      contentHashVersion: 1,
    });
    const answered = state8.questions.find((q: any) => q.questionId === uiQuestionId).latest;
    expect(answered).toMatchObject({ outcome: 'answered', reviewerUserId: investigator.userId, exercisedRight: 'sap:review' });
    expect([...signOff.reviewIds].sort()).toEqual([followUpReviewId, answered.reviewId].sort());
    expect(signOff.contentHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(status).toContainText(`Signed by ${signOff.signerName} on `);
    expect(ddmmyyyy(signOff.signedAt)).toBe(ddmmyyyy(new Date().toISOString()));
  });

  test('FR101, FR38 — AXI-2581.3: the signed report downloads byte-identical to the stored report; signing is terminal', async () => {
    // Act
    const signed = await investigator.api.get(signOffPath('/report'));
    const stored = await investigator.api.get(runsPath(`/${sapRunId}/report`));
    const again = await investigator.api.post(signOffPath());
    const lateReview = await investigator.api.post(reviewsPath(), { data: { questionId: uiQuestionId, outcome: 'follow_up' } });

    // Assert — the frozen report with its hashes
    expect(signed.status(), await signed.text()).toBe(200);
    expect(stored.status(), await stored.text()).toBe(200);
    expect(await signed.body()).toEqual(await stored.body());
    expect(signed.headers()['x-report-hash']).toBe(signOff.reportHash);
    expect(signed.headers()['x-sign-off-content-hash']).toBe(signOff.contentHash);
    expect(signed.headers()['content-disposition']).toContain(`sap-run-report-${sapRunId}-signed.md`);
    // terminal: no second signature, no review after signing
    expect(again.status(), await again.text()).toBe(409);
    expect((await again.json()).errorCode).toBe('SAP_RUN_ALREADY_SIGNED');
    expect(lateReview.status(), await lateReview.text()).toBe(409);
    expect((await lateReview.json()).errorCode).toBe('SAP_RUN_SIGNED');
    expect((await reviewsOf(investigator)).signOff).toEqual(signOff);
  });

  test('FR101, FR40 — AXI-2581.5: a viewer (no sap:review) can read the sign-off and download, but signing and reviewing are 403', async () => {
    // Act
    const sign = await viewer.api.post(signOffPath());
    const record = await viewer.api.post(reviewsPath(), { data: { questionId: uiQuestionId, outcome: 'answered' } });
    const download = await viewer.api.get(signOffPath('/report'));

    // Assert
    expect(sign.status(), await sign.text()).toBe(403);
    expect(record.status(), await record.text()).toBe(403);
    expect(download.status(), await download.text()).toBe(200);
    expect((await reviewsOf(viewer)).signOff).toEqual(signOff);
  });
});

import { expect, test, request as apiRequest, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ROLES } from '../../config/roles';
import { PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { signInAs, uiActor, type UiActor } from '../AXI-2265/AXI-2269-helpers';
import { silenceTours } from '../AXI-1904/harness/tours';
import { askQuestion, choose, gotoSettled } from '../AXI-2308/harness/new-analysis';
import { SapApiStub, apiCallOf, pinNewestT1, type ApiCall, uploadArmScoreDataset, t1Version } from './harness/sap-api-stub';

/** AXI-2308/AXI-2322 FR4 — the server's own Investigator workspace role, not an `editor`. */
const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';

/**
 * AXI-2558 (epic AXI-2433 §7) — the plan-mode Estimand step rebuilt onto structured, chip-based
 * controls, one per ICH E9(R1) attribute (Population, Variable/endpoint, Groups compared,
 * Intercurrent events, Population-level summary), each carrying a source tag ("from the
 * analysis" / "from your data" / "default"). Reuses the Analysis Template Library's shared
 * `ColumnChipPicker` (AXI-2557) — never forked. "Groups compared" replaces "Treatment comparison"
 * on the investigator surface only. A "Learn more" link opens a new static help page. FR93: the
 * structured picks still serialize deterministically into the five flat `SapEstimand` strings —
 * no backend contract change.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md`
 * § AXI-2558 (AXI-2558.1 … AXI-2558.5, AXI-2558.7; AXI-2558.6 is `automation: manual`, source
 * inspection). AXI-2558.7 was added on review bounce 1 (data loss) — see `estimandSource.ts`.
 *
 * E2E CONTRACT — same as AXI-2447's spec: every route real on the demo gateway; the wizard's LLM
 * sites run on the stack's recorded transport (NFR7), with no recording for this fixture, so the
 * intent and the analysis are chosen explicitly. Fixture: `subject_id,arm,score` (12 rows).
 *
 * STATUS: run headless against a frontend-only dev server (port 5182) pointed at the W5
 * validation backend (port 3001) — see the story's bounce-1 rework report for the result.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 240_000 });

const QUESTION = 'Does the score differ between the two arms?';

let world: PrivateProjectsWorld;
let editor: UiActor;
let investigator: UiActor;
/** The seeded platform admin's own tokens (not a workspace-scoped fixture actor): `userType ===
 *  'admin'` bypasses `help:view` entirely (`featureVisibility.ts`), which no workspace role a
 *  throwaway fixture actor can be given otherwise carries. */
let adminTokens: { accessToken: string; refreshToken: string };
let call: ApiCall;
let datasetD: string;
let t1Subtitle: string;

interface Fixture {
  projectId: string;
  name: string;
  stub: SapApiStub;
}

async function newProject(label: string): Promise<Fixture> {
  const name = `E2E AXI-2558 ${label} ${Date.now()}`;
  const res = await editor.api.post(apiUrl('/api/v1/projects'), { data: { name, workspaceId: world.workspaceId } });
  expect(res.status(), await res.text()).toBe(201);
  const projectId = (await res.json()).id;
  const link = await editor.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId: datasetD } });
  expect(link.status(), await link.text()).toBeLessThan(300);
  return { projectId, name, stub: new SapApiStub(projectId, editor.userId, datasetD) };
}

async function draftOf(projectId: string): Promise<any> {
  const res = await call('GET', `/projects/${projectId}/sap-draft`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function signIn(page: Page, activeProject?: string): Promise<void> {
  await page.addInitScript(([org, p]) => {
    localStorage.setItem('axiome-top-org', org as string);
    if (p) localStorage.setItem('axiome-active-project', p as string);
  }, [world.orgId, activeProject ?? ''] as const);
  await signInAs(page, editor, world.workspaceId);
}

/** The real platform admin — `userType === 'admin'` bypasses `help:view` (`editor` lacks it). */
async function signInAsAdmin(page: Page, activeProject: string): Promise<void> {
  await page.addInitScript(
    ([access, refresh, org, workspace, p]) => {
      localStorage.setItem('access_token', access as string);
      localStorage.setItem('refresh_token', refresh as string);
      localStorage.setItem('axiome-active-workspace', workspace as string);
      localStorage.setItem('axiome-top-org', org as string);
      localStorage.setItem('axiome-active-project', p as string);
    },
    [adminTokens.accessToken, adminTokens.refreshToken, world.orgId, world.workspaceId, activeProject] as const,
  );
}

/** The investigator workspace role (FR4) — `surface` resolves to "investigator", never "team". */
async function signInAsInvestigator(page: Page, activeProject: string): Promise<void> {
  await page.addInitScript(([org, p]) => {
    localStorage.setItem('axiome-top-org', org as string);
    localStorage.setItem('axiome-active-project', p as string);
  }, [world.orgId, activeProject] as const);
  await signInAs(page, investigator, world.workspaceId);
}

async function throughAnalysis(page: Page): Promise<void> {
  await askQuestion(page, QUESTION);
  await expect(page.getByTestId('na-step-intent')).toBeVisible();
  await choose(page, 'na-choice-compare_groups');
  await expect(page.getByTestId('na-step-template')).toBeVisible();
  await expect(page.getByTestId('na-choice-T1')).toBeVisible({ timeout: 60_000 });
  await choose(page, 'na-choice-T1');
  await settleAnalysis(page);
  await expect(page.getByTestId('na-step-role')).toBeVisible();
}

async function settleAnalysis(page: Page): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    const step = await page.locator('[data-testid^="na-step-"]').first().getAttribute('data-testid');
    if (step === 'na-step-read') await choose(page, 'na-read-confirm');
    else if (step === 'na-step-decide') await choose(page, 'na-decide-next');
    else return;
    await page.waitForTimeout(300);
  }
}

async function next(page: Page, from: string, to: string): Promise<void> {
  await expect(page.getByTestId(`na-step-${from}`)).toBeVisible();
  await choose(page, 'na-plan-next');
  await expect(page.getByTestId(`na-step-${to}`)).toBeVisible();
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  world = await PrivateProjectsWorld.create();
  editor = await uiActor('editor', world.workspaceId);
  investigator = await uiActor('investigator', world.workspaceId);
  await world.addMember(editor, 'editor');
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  // AXI-2558.5 needs the Estimand step's "Learn more" anchor, which `HelpAnchor` withholds
  // without `help:view` (deny-by-default, found live: `editor` does not carry it in this
  // deployment's seed, so the anchor never rendered and the test's click hung). The platform
  // admin's own login (same identity `ROLES.find(r => r.name === 'admin')` authenticates as
  // for every other spec's `setup` project) bypasses the check by `userType`, independent of
  // workspace role — no throwaway fixture actor can be given that bypass.
  // `PrivateProjectsWorld.create()` auto-adds this same identity as a workspace member (role
  // `admin`) on creation. Unlike the AXI-2267/AXI-2268 isolation specs, this spec never tests the
  // admin's absence from the workspace, so `world.leaveWorkspace()` is deliberately NOT called:
  // found live, once that membership is dropped `WorkspaceGuard` denies the SAME identity even
  // `GET`/`POST .../members` on the workspace ("Workspace not found", fail-closed on non-members),
  // so a dropped admin can never be re-added by itself — there is no recovery path.
  const adminRole = ROLES.find((r) => r.name === 'admin')!;
  const adminLogin = await apiRequest.newContext();
  adminTokens = await (
    await adminLogin.post(apiUrl('/api/v1/auth/login'), { data: { email: adminRole.email, password: adminRole.password } })
  ).json();
  await adminLogin.dispose();
  await silenceTours(editor.accessToken);
  await silenceTours(investigator.accessToken);
  await silenceTours(adminTokens.accessToken);
  call = apiCallOf(editor.api);
  datasetD = await uploadArmScoreDataset(world, editor.api, 'axi2558-D');
  const catalog = await editor.api.get(apiUrl('/api/v1/guided-analysis/opening-templates'));
  expect(catalog.status(), await catalog.text()).toBe(200);
  const body = await catalog.json();
  const t1 = (body.templates ?? body).find((t: { templateId: string }) => t.templateId === 'T1');
  t1Subtitle = t1.methodSubtitle;
  // pinNewestT1 needs a project to read `/sap-templates` off — a throwaway one, never reused.
  const warmUp = await newProject('warm-up');
  await pinNewestT1(call, warmUp.projectId);
});

test.afterAll(async () => {
  await editor?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2558 structured Estimand step @SI-066 @SI-030', () => {
  test('FR92 FR93 AXI-2558.1 all five fields pre-fill with a source tag; Next needs no typing @SI-066', async ({ page }) => {
    // Arrange
    const { projectId, stub } = await newProject('prefill');
    await stub.seedDraft(call, []);
    await signIn(page);
    await gotoSettled(page, `/projects/${projectId}/sap/questions/new`);
    await throughAnalysis(page);

    // Act
    await next(page, 'role', 'estimand');

    // Assert — every field pre-filled, each with its own source tag
    await expect(page.getByTestId('na-plan-population-text')).toContainText('All patients in the dataset');
    await expect(page.getByTestId('na-plan-prefilled-population')).toHaveText('from your data');
    await expect(page.getByTestId('na-plan-estimand-variable').getByRole('button', { name: 'score' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('na-plan-prefilled-variable')).toHaveText('from the analysis');
    await expect(page.getByTestId('na-plan-estimand-treatmentComparison').getByRole('button', { name: 'arm' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('na-plan-prefilled-treatmentComparison')).toHaveText('from the analysis');
    await expect(page.getByTestId('na-plan-prefilled-intercurrentEvents')).toHaveText('default');
    await expect(page.getByTestId('na-plan-estimand-populationSummary')).toContainText(t1Subtitle);
    await expect(page.getByTestId('na-plan-prefilled-populationSummary')).toHaveText('from the analysis');

    // Act — Next needs no typing at all
    await choose(page, 'na-plan-next');

    // Assert
    await expect(page.getByTestId('na-step-parameters')).toBeVisible();
  });

  test('FR92 AXI-2558.2 a chip edit records the edit and drops that field\'s source tag @SI-066', async ({ page }) => {
    // Arrange
    const { projectId, stub } = await newProject('chip-edit');
    await stub.seedDraft(call, []);
    await signIn(page);
    await gotoSettled(page, `/projects/${projectId}/sap/questions/new`);
    await throughAnalysis(page);
    await next(page, 'role', 'estimand');

    // Act — restrict Population to arm: A, a structured (not free-text) edit
    await page.getByTestId('na-plan-estimand-population').getByRole('button', { name: 'arm', exact: true }).click();
    await page.getByTestId('na-plan-estimand-population').getByRole('button', { name: 'A', exact: true }).click();

    // Assert — the tag disappears on that field only
    await expect(page.getByTestId('na-plan-prefilled-population')).toHaveCount(0);
    await expect(page.getByTestId('na-plan-prefilled-variable')).toBeVisible();

    // Act — finish and save
    for (const [from, to] of [['estimand', 'parameters'], ['parameters', 'sensitivity'], ['sensitivity', 'ready']] as const) {
      await next(page, from, to);
    }
    await choose(page, 'na-plan-save');
    // AXI-2553 (merged after this spec was authored): Ready now returns to the plan with
    // `?highlight=<questionId>` — accept either, matching AXI-2447's spec update for the same change.
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sap(\\?highlight=[^&]*)?$`));

    // Assert — stored into the SAME flat string (FR93 — no new wire shape)
    const stored = (await draftOf(projectId)).plan.questions[0].estimand;
    expect(stored.population).toContain('restricted to arm: A');
  });

  test('FR90 AXI-2558.3 "Groups compared" on the investigator surface only @SI-066', async ({ page }) => {
    // Arrange — a project with an open draft, opened on the investigator mirror route by an
    // actual Investigator-role user (an `editor` is redirected off `/investigator/*` by
    // `SurfaceGate`, never reaching the page — bounce-fix-adjacent defect found live)
    const { projectId, stub } = await newProject('investigator-label');
    await stub.seedDraft(call, []);
    await signInAsInvestigator(page, projectId);
    await gotoSettled(page, `/investigator/projects/${projectId}/sap/questions/new`);
    await throughAnalysis(page);
    await next(page, 'role', 'estimand');

    // Assert — the investigator surface reads "Groups compared", never "Treatment comparison".
    // Scoped to the field's own frame: the page also carries a plain-language summary paragraph
    // that legitimately contains the words "Groups compared" as running prose.
    await expect(page.getByTestId('na-plan-estimand-treatmentComparison').getByText('Groups compared', { exact: true })).toBeVisible();
    await expect(page.getByTestId('na-plan-estimand-treatmentComparison').getByText('Treatment comparison', { exact: true })).toHaveCount(0);
  });

  test('FR92 AXI-2558.4 Population-level summary is read-only; "Change" returns to the Analysis step @SI-066', async ({ page }) => {
    // Arrange
    const { projectId, stub } = await newProject('change-method');
    await stub.seedDraft(call, []);
    await signIn(page);
    await gotoSettled(page, `/projects/${projectId}/sap/questions/new`);
    await throughAnalysis(page);
    await next(page, 'role', 'estimand');

    // Act
    await page.getByTestId('na-plan-estimand-change-method').click();

    // Assert — back to the Analysis (template) step, not a free-text field in place
    await expect(page.getByTestId('na-step-template')).toBeVisible();
  });

  test('FR91 AXI-2558.5 "Learn more" opens the plain-words help page @SI-066', async ({ page }) => {
    // Arrange — the real platform admin (userType bypass for help:view); it stays the fixture
    // workspace's auto-added member throughout this spec (see `beforeAll`'s comment).
    const { projectId, stub } = await newProject('help-page');
    await stub.seedDraft(call, []);
    await signInAsAdmin(page, projectId);
    await gotoSettled(page, `/projects/${projectId}/sap/questions/new`);
    await throughAnalysis(page);
    await next(page, 'role', 'estimand');

    // Act
    const [helpPage] = await Promise.all([
      page.context().waitForEvent('page').catch(() => null),
      page.getByRole('link', { name: /learn more/i }).click(),
    ]);
    const target = helpPage ?? page;
    if (helpPage) await helpPage.waitForLoadState('domcontentloaded');

    // Assert — a new tab's first cold Vite module load can exceed the default 5s (AXI-2552's own
    // report notes the same on a freshly restarted dev server)
    await expect(target.getByRole('heading', { name: /the estimand, in plain words/i })).toBeVisible({ timeout: 30_000 });
    // Scoped to the doc body: the help nav sidebar's own truncated preview text for this same
    // topic also contains "ICH E9(R1)" — found live, `getByText` alone is a strict-mode violation.
    await expect(target.getByTestId('help-doc').getByText(/ICH E9\(R1\)/)).toBeVisible();
  });

  test('FR93 AXI-2558.7 opening an existing draft question with a non-default estimand renders every stored value; saving untouched is lossless (B2)', async ({ page }) => {
    // Arrange — a stored question with a Population restriction, a Groups comparison and a
    // "Treatment change" intercurrent event (review bounce 1's own example, reproduced live)
    const { projectId, stub } = await newProject('round-trip');
    const storedEstimand = {
      population: 'All patients in the dataset (n = 12), restricted to arm: A',
      variable: 'score',
      treatmentComparison: 'arm: A vs B',
      intercurrentEvents: 'Treatment change — strategy: Treatment policy (analyse regardless)',
      populationSummary: t1Subtitle,
    };
    const seeded = await stub.seedDraft(call, [{
      text: 'Does the score differ between the two arms?',
      role: 'primary',
      estimand: storedEstimand,
      template: { templateId: 'T1', templateVersion: t1Version },
      bindings: [
        { slot: 'groupingColumn', column: 'arm', semanticRole: 'grouping_two_levels' },
        { slot: 'outcome', column: 'score', semanticRole: 'continuous' },
      ],
      parameters: { alpha: 0.05, sidedness: 'two_sided' },
      decisionCriterion: { kind: 'p_at_or_below_alpha' },
      sensitivityAnalyses: [],
    }]);
    const questionId = seeded.plan.questions[0].questionId;
    await signIn(page);

    // Act
    await gotoSettled(page, `/projects/${projectId}/sap/questions/${questionId}`);
    await expect(page.getByTestId('na-step-ready')).toBeVisible({ timeout: 60_000 });
    await choose(page, 'na-back'); // sensitivity
    await choose(page, 'na-back'); // parameters
    await choose(page, 'na-back'); // estimand
    await expect(page.getByTestId('na-step-estimand')).toBeVisible();

    // Assert — every field renders the STORED value, not the fresh pre-fill
    await expect(page.getByTestId('na-plan-population-text')).toContainText('restricted to arm: A');
    await expect(page.getByTestId('na-plan-estimand-population').getByRole('button', { name: 'arm' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('na-plan-estimand-variable').getByRole('button', { name: 'score' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('na-plan-estimand-treatmentComparison').getByRole('button', { name: 'arm' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('na-plan-estimand-intercurrent-kind')).toHaveValue('treatment_change');
    await expect(page.getByTestId('na-plan-estimand-intercurrent-strategy')).toHaveValue('Treatment policy (analyse regardless)');
    // An edit shows no source tag on any field — every value is the author's own stored text
    for (const field of ['population', 'variable', 'treatmentComparison', 'intercurrentEvents', 'populationSummary']) {
      await expect(page.getByTestId(`na-plan-prefilled-${field}`)).toHaveCount(0);
    }

    // Act — save with nothing touched
    await choose(page, 'na-plan-next'); // estimand -> parameters
    await choose(page, 'na-plan-next'); // parameters -> sensitivity
    await choose(page, 'na-plan-next'); // sensitivity -> ready
    await choose(page, 'na-plan-save');
    // AXI-2553 (merged after this spec was authored): Ready now returns to the plan with
    // `?highlight=<questionId>` — accept either, matching AXI-2447's spec update for the same change.
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sap(\\?highlight=[^&]*)?$`));

    // Assert — lossless: the stored estimand is byte-identical to what was seeded
    const after = (await draftOf(projectId)).plan.questions.find((q: { questionId: string }) => q.questionId === questionId);
    expect(after.estimand).toEqual(storedEstimand);
  });
});

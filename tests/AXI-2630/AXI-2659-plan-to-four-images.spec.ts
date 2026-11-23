import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { apiUrl, API_BASE_URL, BASE_URL } from '../../config/env';
import { connectHandoverClient, type HandoverClient } from '../AXI-2598/harness/http';
import { silenceTours } from '../AXI-1904/harness/tours';

/**
 * AXI-2659 (epic AXI-2630 — the MAG4 "plan to four images" walk; FR58-FR60, AC37, AC38; SI-042).
 * The LAST story of the AXI-2630/AXI-2631 effort: new project -> protocol -> four v2 questions
 * (Q1 T2, Q2 T2, Q3 T1, Q4 T5, the exact table of
 * `fixtures/handover/mag4-new-model-preset.json` §5) -> variable declaration -> each question
 * PLANNED THROUGH THE REAL "Plan a question" UI (workflow card, data chips, estimand, Save) ->
 * finalise -> upload + link both reference files -> launch all four -> wait for all four to
 * finish -> open each result page (a real chart renders) -> the Investigator study home shows
 * all four images, each opening its own result -> reload, same four images still show.
 *
 * PRODUCT-SCOPE GAP, confirmed live, not fixed here (filed separately — see the story report for
 * the Jira key): the generic "Plan a question" UI has NO stratification control. T2's "groups"
 * choice is `options: []` (AXI-2659/AXI-2674 fixed the resulting permanent Save-block, but the
 * choice itself is still never offered as a UI slot or input), and there is no `stratifyBy` slot
 * anywhere on this page. Image 1's reference section 20 is a Dunn run over EXACTLY 3 strata
 * (ENT059 / CER229 / CER215+234) crossing EXACTLY 3 groups (HD / IgG4-RD / SD) — a browser-planned
 * Q1 can only bind `group`/`pct` and compares EVERY level the data carries (AL, HD, IL, IgG4-RD,
 * SD — 5 groups, unstratified). This spec plans Q1 that way, deliberately, and asserts only what
 * the UI can actually produce today (the T2/Kruskal-Wallis-shaped analysis launches, finishes,
 * and renders a chart with real statistics) — never the exact section-20 Dunn values, and never
 * an API-level shortcut to fabricate the 3-stratum subset. Images 2-4 (plain slot-only templates,
 * no stratification in the reference either) are unaffected by this gap.
 *
 * AXI-2659.3b (a second, SEPARATE real-UI step, not an API shortcut): `organ_involvement` and
 * `phenotype_cluster` land from "Add from standard fields" with no declared levels at all
 * (`levels: []`) — only `disease_group` ships pre-baked levels in this profile — so the manual
 * "Add a custom variable, or edit a field by hand" editor is used to declare their real levels
 * (read from the two reference CSVs) before Q2/Q3 are planned; without it the Plan-a-question
 * page offers no `groupingColumn` candidate for either field at all.
 *
 * Reviewer-required coverage (AXI-2674): Q1 and Q2 (both template T2) each assert `pq-save`
 * reaches an ENABLED state while planning, through the real browser — the exact scenario a
 * permanently-empty-options "groups" choice used to block forever.
 *
 * E2E CONTRACT: real w5val stack (BASE_URL :5174, API_BASE_URL :3001), no stub/double anywhere
 * in this file. Two identities: the PROVISIONING identity (project creation + the one semantic-
 * profile-extension admin call, both outside Investigator rights — AXI-2322) and the INVESTIGATOR
 * identity, who does every other step, in the browser.
 */

const WS = process.env.HANDOVER_WORKSPACE_ID ?? '';
const INV_EMAIL = process.env.E2E_INVESTIGATOR_EMAIL ?? '';
const INV_PASSWORD = process.env.E2E_INVESTIGATOR_PASSWORD ?? '';
const PROV_EMAIL = process.env.HANDOVER_PROVISIONER_EMAIL ?? '';
const PROV_PASSWORD = process.env.HANDOVER_PROVISIONER_PASSWORD ?? '';
const PROFILE_ID = 'immune_mediated_microbiota';

const SCREEN_DIR = path.resolve(process.cwd(), 'reports/AXI-2659/screenshots');
fs.mkdirSync(SCREEN_DIR, { recursive: true });
let shotN = 0;
async function shot(page: Page, name: string): Promise<void> {
  shotN += 1;
  await page.screenshot({ path: path.join(SCREEN_DIR, `${String(shotN).padStart(2, '0')}-${name}.png`), fullPage: true }).catch(() => {});
}

// The nine project-extension fields the preset's T2 file needs (AXI-2648's nine-field pack) —
// `canonicalFieldSource: 'extension'` rows of fixtures/handover/mag4-new-model-preset.json.
const EXTENSION_FIELDS = [
  'igg4_coating_ent_059', 'igg4_coating_cer_228', 'igg4_coating_mag4_27', 'igg4_coating_mag4_22',
  'igg4_coating_mag4_13', 'igg4_coating_cer_215_et_234', 'igg4_coating_cer_229',
  'cell_count_eosinophils', 'cell_count_plasmablasts',
];

// Every canonical field the four questions below bind, platform + extension — declared as
// variables through the real "Add from standard fields" drawer (never a manual/API shortcut).
const PLATFORM_FIELDS = [
  'disease_group', 'reference_microbiota', 'coating_pct', 'organ_involvement', 'phenotype_cluster',
  'serum_immunoglobulin', 'disease_activity_index', 'tissue_cell_density', 'cell_frequency_pct',
];

// Every field the preset declares `grouping_two_levels`/`grouping_three_plus_levels` — the
// standard-fields drawer's "Type…" picker only appears when the catalog states no expected kind
// for a field (`field.expectedKind === null`); harmless to check a field not actually prompted.
const GROUP_FIELDS = new Set(['disease_group', 'reference_microbiota', 'organ_involvement', 'phenotype_cluster']);

interface QuestionPlan {
  key: string; // Q1..Q4, display order == creation order (primary, secondary, secondary, exploratory)
  text: string;
  role: 'primary' | 'secondary' | 'exploratory';
  templateId: 'T1' | 'T2' | 'T5';
  // slot -> canonicalField short names (as declared above) to bind. 'select-all' means use the
  // multi-slot's own "Select all" control rather than naming fields one by one.
  slots: Array<{ slot: string; fields: string[] | 'select-all' }>;
}

const QUESTIONS: QuestionPlan[] = [
  {
    key: 'Q1', role: 'primary', templateId: 'T2',
    text: 'Does the IgG4 anti-microbiota reference level differ between HD, IgG4-RD and SD, per reference?',
    slots: [{ slot: 'groupingColumn', fields: ['disease_group'] }, { slot: 'outcome', fields: ['coating_pct'] }],
  },
  {
    key: 'Q2', role: 'secondary', templateId: 'T2',
    text: 'Does the ENT-059 reference level differ across the four ACR/EULAR 2019 clusters?',
    // AXI-2659.3b declares phenotype_cluster's 4 levels through the manual spec editor first —
    // without that, the standard-fields drawer alone leaves it with no known levels and the
    // "Plan a question" page never offers it as a groupingColumn candidate at all.
    slots: [{ slot: 'groupingColumn', fields: ['phenotype_cluster'] }, { slot: 'outcome', fields: ['igg4_coating_ent_059'] }],
  },
  {
    key: 'Q3', role: 'secondary', templateId: 'T1',
    text: 'Does the ENT-059 reference level differ between patients with and without pancreato-biliary involvement?',
    slots: [{ slot: 'groupingColumn', fields: ['organ_involvement'] }, { slot: 'outcome', fields: ['igg4_coating_ent_059'] }],
  },
  {
    key: 'Q4', role: 'exploratory', templateId: 'T5',
    text: 'How does each IgG4 anti-microbiota reference correlate with the clinical and biological variables?',
    slots: [{ slot: 'references', fields: 'select-all' }, { slot: 'y', fields: 'select-all' }],
  },
];

async function rawLogin(email: string, password: string): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const res = await fetch(apiUrl('/api/v1/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  expect(res.ok, `login ${email}: HTTP ${res.status}`).toBeTruthy();
  const { accessToken, refreshToken } = await res.json();
  const me = await (await fetch(apiUrl('/api/v1/auth/me'), { headers: { Authorization: `Bearer ${accessToken}` } })).json();
  return { accessToken, refreshToken, userId: me.id };
}

async function signInBrowser(page: Page, tokens: { accessToken: string; refreshToken: string }, orgId: string, projectId: string | null): Promise<void> {
  await page.addInitScript(
    ([access, refresh, org, ws, proj]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      if (proj) localStorage.setItem('axiome-active-project', proj);
      // The investigator surface's `/investigator` index route (InvestigatorHome) lands on a
      // DIFFERENT remembered choice — sessionStorage, read by `lib/investigatorScope/lastStudy.ts`
      // (`axiome-investigator-last-workspace`/`-project`), never the `axiome-active-*`
      // localStorage keys above (those are the team surface's own, unrelated concept). With two+
      // projects in this workspace (every prior run of this very spec leaves one behind) and no
      // stored choice, the count rule's tie-break is alphabetical-first — the pre-existing
      // "CeRAINOM-IgG4…" demo project, never our freshly created "E2E AXI-2659 …" one. Without
      // this, every `/investigator` navigation silently lands on the WRONG project's Study page.
      sessionStorage.setItem('axiome-investigator-last-workspace', ws);
      if (proj) sessionStorage.setItem('axiome-investigator-last-project', proj);
    },
    [tokens.accessToken, tokens.refreshToken, orgId, WS, projectId] as const,
  );
}

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 20 * 60_000 });

let provisioner: HandoverClient;
let investigator: HandoverClient;
let orgId: string;
let projectId: string;
let invTokens: { accessToken: string; refreshToken: string; userId: string };
const fieldIdByCanonical = new Map<string, string>();

test.beforeAll(async () => {
  test.skip(!WS || !INV_EMAIL || !INV_PASSWORD || !PROV_EMAIL || !PROV_PASSWORD, 'HANDOVER_WORKSPACE_ID / E2E_INVESTIGATOR_* / HANDOVER_PROVISIONER_* not configured');
  provisioner = await connectHandoverClient({ label: 'provisioner', apiBaseUrl: API_BASE_URL, email: PROV_EMAIL, password: PROV_PASSWORD, workspaceId: WS });
  investigator = await connectHandoverClient({ label: 'investigator', apiBaseUrl: API_BASE_URL, email: INV_EMAIL, password: INV_PASSWORD, workspaceId: WS });
  const ws = await (await provisioner.get(`/api/v1/workspaces/${WS}`)).body;
  orgId = String(ws.ownerOrganizationId);
  invTokens = await rawLogin(INV_EMAIL, INV_PASSWORD);
  await silenceTours(invTokens.accessToken);
});

test.afterAll(async () => {
  await provisioner?.get('/api/v1/auth/me').catch(() => {});
});

test.describe('AXI-2659 plan to four images @SI-042', () => {
  test('AXI-2659.0 provisioning: a new project, the project extension pack (admin-only, outside Investigator rights)', async () => {
    const create = await provisioner.post('/api/v1/projects', { name: `E2E AXI-2659 ${Date.now()}`, workspaceId: WS, semanticProfileId: PROFILE_ID });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    projectId = String(create.body.id);

    const registry_id = `canonical_fields.project.${projectId}.v1`;
    const fields = EXTENSION_FIELDS.map((f) => `project.${projectId}.${f}`);
    const ext = await provisioner.post(`/api/v1/semantic-profiles/projects/${projectId}/extensions`, { packs: [{ registry_id, fields }] });
    expect(ext.status, JSON.stringify(ext.body)).toBe(201);

    const read = await investigator.get(`/api/v1/projects/${projectId}`);
    expect(read.status, 'the Investigator can read the provisioned project').toBe(200);
  });

  test('AXI-2659.1 protocol, through the real Protocol page', async ({ page }) => {
    await signInBrowser(page, invTokens, orgId, projectId);
    await page.goto(`${BASE_URL}/investigator/projects/${projectId}/study/protocol`);
    await expect(page.getByTestId('project-protocol-page')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('protocol-title').fill('AXI-2659 — MAG4 IgG4 anti-microbiota references');
    await page.getByTestId('protocol-objective').fill('Describe how IgG4 antibodies against microbiota references relate to clinical and biological features of IgG4-related disease.');
    await page.getByTestId('protocol-study-population').fill('Patients with IgG4-related disease in the MAG4 cohort (synthetic data).');
    await page.getByTestId('protocol-save').click();
    await expect(page.getByTestId('protocol-unsaved')).toHaveCount(0, { timeout: 15_000 });
    await shot(page, 'protocol-saved');
  });

  test('AXI-2659.2 four questions added as stubs, in role/creation order Q1..Q4', async ({ page }) => {
    await signInBrowser(page, invTokens, orgId, projectId);
    await page.goto(`${BASE_URL}/investigator/projects/${projectId}/sap`);
    await expect(page.getByTestId('project-sap-page')).toBeVisible({ timeout: 30_000 });

    for (let i = 0; i < QUESTIONS.length; i++) {
      const q = QUESTIONS[i];
      const opener = i === 0 ? page.getByTestId('sap-plan-add-primary-question') : page.getByTestId('sap-plan-add-question');
      await opener.click();
      await expect(page.getByTestId('sap-add-question-modal')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('sap-add-question-text').fill(q.text);
      if (i > 0) await page.getByTestId(`sap-add-question-role-${q.role}`).click();
      await page.getByTestId('sap-add-question-submit').click();
      await expect(page.getByTestId('sap-add-question-modal')).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByTestId(`sap-plan-questions-row-${q.key}`)).toBeVisible({ timeout: 15_000 });
    }
    await shot(page, 'four-question-stubs');
  });

  test('AXI-2659.3 variables declared through "Add from standard fields"', async ({ page }) => {
    await signInBrowser(page, invTokens, orgId, projectId);
    await page.goto(`${BASE_URL}/investigator/projects/${projectId}/sap`);
    await expect(page.getByTestId('project-sap-page')).toBeVisible({ timeout: 30_000 });
    // AXI-2657: the plan's timing is chosen once the questions exist — "Before the data exists"
    // puts the Variables card in DECLARED mode (standard-fields drawer); the default (neither
    // radio checked) offers no "Add from standard fields" at all.
    const declaredTiming = page.getByTestId('sap-plan-timing-declared');
    if (!(await declaredTiming.isChecked())) await declaredTiming.check();
    await page.getByTestId('sap-variables-add-standard').click();
    await expect(page.getByTestId('sap-standard-fields-drawer')).toBeVisible({ timeout: 15_000 });

    const wanted = [...PLATFORM_FIELDS, ...EXTENSION_FIELDS.map((f) => `project.${projectId}.${f}`)];
    for (const canonical of wanted) {
      const box = page.getByTestId(`sap-standard-field-${canonical}-check`);
      await expect(box).toBeVisible({ timeout: 15_000 });
      await box.check();
      const kind = page.getByTestId(`sap-standard-field-${canonical}-kind`);
      if (await kind.count() > 0) await kind.selectOption(GROUP_FIELDS.has(canonical) ? 'group' : 'measurement');
    }
    await expect(page.getByTestId('sap-standard-fields-add')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('sap-standard-fields-add').click();
    await expect(page.getByTestId('sap-standard-fields-drawer')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId('sap-variables-table')).toBeVisible({ timeout: 15_000 });
    await shot(page, 'variables-declared');

    // Read the fieldIds the server assigned (never guessed): a plain state READ, not a second
    // way of declaring anything — the declaration itself happened entirely through the drawer
    // above. `canonicalField` on an extension field comes back fully qualified
    // (`project.<id>.<key>`); indexed here by its short key so QUESTIONS can name fields plainly.
    const draft = await (await investigator.get(`/api/v1/projects/${projectId}/sap-draft`)).body;
    const prefix = `project.${projectId}.`;
    for (const f of draft.plan?.dataSpecification?.fields ?? []) {
      const canonical = String(f.canonicalField ?? '');
      const short = canonical.startsWith(prefix) ? canonical.slice(prefix.length) : canonical;
      fieldIdByCanonical.set(short, String(f.fieldId));
    }
    expect(fieldIdByCanonical.size, JSON.stringify(draft.plan?.dataSpecification?.fields)).toBe(wanted.length);
  });

  // AXI-2659 live finding: the "Add from standard fields" drawer's binary measurement/group
  // "Type…" picker (AXI-2674's `-kind` select) carries no level-count information, so every
  // grouping field it adds lands with `levels: []` except the one platform field whose levels
  // ship pre-baked in the profile (`disease_group`) — the real, intended lever for a declared
  // (pre-data) grouping field's levels is the SEPARATE manual "Add a custom variable, or edit a
  // field by hand" editor (`sap-spec-table`), which both fields already added above pass through
  // (same `dataSpecification.fields` array) and which has its own per-row Levels input and Role
  // select. Declares `organ_involvement` (binary) and `phenotype_cluster` (4 ACR/EULAR clusters)
  // here, through that real UI, from the two reference files' own observed values — never an API
  // shortcut. This directly unblocks Q2 (phenotype_cluster as a 3+-group `groupingColumn`
  // candidate) and Q3 (organ_involvement as a 2-group `groupingColumn` candidate).
  test('AXI-2659.3b declare levels for organ_involvement and phenotype_cluster through the manual spec editor', async ({ page }) => {
    await signInBrowser(page, invTokens, orgId, projectId);
    await page.goto(`${BASE_URL}/investigator/projects/${projectId}/sap`);
    await expect(page.getByTestId('project-sap-page')).toBeVisible({ timeout: 30_000 });

    const manualEditor = page.getByTestId('sap-variables-manual-editor');
    if (!(await manualEditor.getAttribute('open'))) {
      await page.locator('[data-testid="sap-variables-manual-editor"] summary').click();
    }
    await expect(page.getByTestId('sap-spec-table')).toBeVisible({ timeout: 15_000 });

    const rowCount = await page.locator('[data-testid^="sap-spec-field-"][data-testid$="-name"]').count();
    const rowIndexOf = async (canonical: string): Promise<number> => {
      for (let i = 0; i < rowCount; i++) {
        const v = await page.getByTestId(`sap-spec-field-${i}-name`).inputValue();
        if (v === canonical) return i;
      }
      throw new Error(`no spec row found for canonical field "${canonical}"`);
    };

    const organIdx = await rowIndexOf('organ_involvement');
    await page.getByTestId(`sap-spec-field-${organIdx}-levels`).fill('0, 1');

    const clusterIdx = await rowIndexOf('phenotype_cluster');
    await page.getByTestId(`sap-spec-field-${clusterIdx}-role`).selectOption('grouping_three_plus_levels');
    await page.getByTestId(`sap-spec-field-${clusterIdx}-levels`).fill('C1, C2, C3, C4');

    // `reference_microbiota` isn't bound by any of the four questions, but the plan's own
    // completeness gate ("Groups declare at least 2 levels") checks every declared grouping
    // field, not only the ones a question uses — finalise stays blocked otherwise. Its 3 real
    // strata (the image-1 reference's own ENT059/CER229/CER215+234) declared here for the same
    // reason as above; this does NOT reopen the stratifyBy gap (that is a per-question choice
    // list on the workflow catalog, unrelated to a field's own declared levels).
    const referenceIdx = await rowIndexOf('reference_microbiota');
    await page.getByTestId(`sap-spec-field-${referenceIdx}-role`).selectOption('grouping_three_plus_levels');
    await page.getByTestId(`sap-spec-field-${referenceIdx}-levels`).fill('ENT 059, CER 229, CER 215 et 234');

    await shot(page, 'levels-declared-manual-editor');
    await expect(page.getByTestId('sap-spec-save')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('sap-spec-save').click();
    await expect(page.getByTestId('sap-spec-save')).toBeDisabled({ timeout: 15_000 });

    const draft = await (await investigator.get(`/api/v1/projects/${projectId}/sap-draft`)).body;
    const roles = new Map<string, string>((draft.plan?.dataSpecification?.fields ?? []).map((f: { canonicalField: string; semanticRole: string }) => [f.canonicalField, f.semanticRole]));
    expect(roles.get('organ_involvement')).toBe('grouping_two_levels');
    expect(roles.get('phenotype_cluster')).toBe('grouping_three_plus_levels');
  });

  for (const q of QUESTIONS) {
    test(`AXI-2659.4 plan ${q.key} (${q.templateId}) through the "Plan a question" UI`, async ({ page }) => {
      await signInBrowser(page, invTokens, orgId, projectId);
      await page.goto(`${BASE_URL}/investigator/projects/${projectId}/sap`);
      await page.getByTestId(`sap-plan-questions-row-${q.key}`).click();
      await expect(page.getByTestId('plan-question-page')).toBeVisible({ timeout: 30_000 });

      await page.getByTestId(`pq-workflow-card-${q.templateId}`).click();
      await expect(page.getByTestId('pq-workflow-chosen')).toBeVisible({ timeout: 15_000 });

      for (const binding of q.slots) {
        const block = page.getByTestId(`pq-input-${binding.slot}`);
        await expect(block).toBeVisible({ timeout: 15_000 });
        // `match()` (per-template candidate resolution) runs after the workflow is chosen; the
        // slot's chips/Select-all populate once it resolves — never clicked before they exist.
        await expect(block.locator('[data-testid^="pq-chip-"]')).not.toHaveCount(0, { timeout: 20_000 });
        if (binding.fields === 'select-all') {
          await block.getByRole('button', { name: 'Select all' }).click();
        } else {
          for (const canonical of binding.fields) {
            const fieldId = fieldIdByCanonical.get(canonical);
            expect(fieldId, `no fieldId read for canonical field "${canonical}"`).toBeTruthy();
            const chip = page.getByTestId(`pq-chip-${binding.slot}-${fieldId}`);
            await expect(chip).toBeVisible({ timeout: 15_000 });
            await chip.click();
          }
        }
      }

      // AXI-2659 live finding (supersedes the pre-session assumption): the "groups" choice DOES
      // render on T2 (it is not skipped) but is a `<select>` with exactly one, unusable option —
      // the empty placeholder — never the data's actual group levels. That is the product-scope
      // gap this story's report names precisely: the catalog declares this choice with an empty
      // `options` array, so there is no way, anywhere in the Plan-a-question UI, to keep fewer
      // than "every group of the column" (i.e. no stratification/subsetting control for ANY
      // template). Pin that exact shape here rather than assume no block renders at all.
      if (q.templateId === 'T2') {
        const groupsChoice = page.getByTestId('pq-choice-groups').first();
        await expect(groupsChoice).toBeVisible({ timeout: 10_000 });
        const groupsOptions = await groupsChoice.locator('select option').allInnerTexts();
        expect(groupsOptions, 'the "groups" choice is expected to expose only the empty placeholder today (AXI-2674 scope gap)').toEqual(['—']);
      }

      await page.getByTestId('pq-estimand-edit').click();
      await expect(page.getByTestId('pq-estimand-editor')).toBeVisible({ timeout: 10_000 });
      // The editor no longer has an Apply step: each change is written as it is made, and Done
      // closes the editor (`pq-intercurrent-done`, EstimandSection.tsx). Default = "not applicable".
      await page.getByTestId('pq-intercurrent-done').click();
      await expect(page.getByTestId('pq-estimand-editor')).toBeHidden({ timeout: 10_000 });

      // Reviewer-required coverage (AXI-2674): Save reaches ENABLED for a T2 question while
      // planning — the exact scenario the empty-options "groups" choice used to block forever.
      await expect(page.getByTestId('pq-save')).toBeEnabled({ timeout: 15_000 });
      await shot(page, `${q.key}-${q.templateId}-ready-to-save`);
      await page.getByTestId('pq-save').click();
      await expect(page).toHaveURL(new RegExp(`/investigator/projects/${projectId}/sap`), { timeout: 20_000 });
      await expect(page.getByTestId(`sap-plan-questions-status-${q.key}`)).toHaveText(/Complete/, { timeout: 15_000 });
    });
  }

  test('AXI-2659.5 finalise the plan', async ({ page }) => {
    await signInBrowser(page, invTokens, orgId, projectId);
    await page.goto(`${BASE_URL}/investigator/projects/${projectId}/sap`);
    const open = page.getByTestId('sap-finalise-open');
    await expect(open).toBeEnabled({ timeout: 20_000 });
    await open.click();
    await expect(page.getByTestId('sap-finalise-dialog')).toBeVisible({ timeout: 10_000 });
    const reason = page.getByTestId('sap-finalise-reason');
    if (await reason.count() > 0) await reason.fill('AXI-2659 — first structured version of the MAG4 plan-to-four-images rehearsal.');
    await page.getByTestId('sap-finalise-confirm').click();
    await expect(page.getByTestId('sap-finalise-dialog')).toHaveCount(0, { timeout: 20_000 });
    await shot(page, 'plan-finalised');
  });

  test('AXI-2659.6 upload + link both reference files through the real Uploads page', async ({ page }) => {
    await signInBrowser(page, invTokens, orgId, projectId);
    await page.goto(`${BASE_URL}/investigator/uploads`);
    await expect(page.getByTestId('investigator-uploads')).toBeVisible({ timeout: 30_000 });

    const file1 = path.resolve(process.cwd(), 'fixtures/handover/final_tableau1_long_synthetic.csv');
    const file2 = path.resolve(process.cwd(), 'fixtures/handover/final_tableau2_synthetic.csv');

    // Content-hash dedup is workspace-wide, not project-scoped — repeated runs of this very spec
    // against the same two fixture files hit "This file is already uploaded…" and the real
    // "Use the existing file" link (never a second raw upload of bytes already on the server).
    // The duplicate-file banner renders async (a server round-trip after `setInputFiles`), so a
    // same-tick `count()` check races it and misses the link every time — wait for it instead,
    // and treat "never showed up" as "this upload wasn't a duplicate", not an error.
    const useExisting = async (): Promise<void> => {
      const link = page.getByTestId('upload-duplicate-use-existing');
      try {
        await link.waitFor({ state: 'visible', timeout: 10_000 });
        await link.click();
      } catch {
        // no duplicate banner — direct upload, nothing to do.
      }
    };

    await page.getByTestId('upload-input').setInputFiles(file1);
    await useExisting();
    await expect.poll(async () => page.getByTestId(/^upload-status-/).first().innerText().catch(() => ''), {
      timeout: 120_000, message: 'tableau1 never reached a terminal status',
    }).toMatch(/Ready|Check/);

    await page.getByTestId('upload-input-header').setInputFiles(file2);
    await useExisting();
    await expect.poll(async () => page.getByTestId(/^upload-row-/).count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => {
      const rows = await page.getByTestId(/^upload-status-/).allInnerTexts();
      return rows.filter((t) => /Ready|Check/.test(t)).length;
    }, { timeout: 120_000, message: 'tableau2 never reached a terminal status' }).toBeGreaterThanOrEqual(2);
    await shot(page, 'both-files-uploaded');

    // Ingestion/semantic-column-profiling finishing is a SEPARATE readiness signal from the
    // upload row's own "Ready" status; the per-question data-readiness resolver the Study page's
    // "Run" gate reads needs the profile's `normalize` pass too. That pass is an admin-only call
    // (`mapping:confirm_binding`) with no Investigator-surface control anywhere on this app (the
    // same gap AXI-2647 recorded) — triggered here as pure infrastructure, never as a stand-in
    // for any Investigator UI action this story owns.
    for (let i = 0; i < 20; i++) {
      const normalize = await provisioner.post(`/api/v1/semantic-profiles/projects/${projectId}/normalize`);
      if (normalize.status === 200 && ((normalize.body?.totals?.filled ?? 0) + (normalize.body?.totals?.created ?? 0) > 0)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  });

  test('AXI-2659.7 launch all four from the Study home, wait for all four to finish', async ({ page }) => {
    await signInBrowser(page, invTokens, orgId, projectId);
    await page.goto(`${BASE_URL}/investigator`);
    await expect(page.getByTestId('investigator-home')).toBeVisible({ timeout: 30_000 });

    // The primary action is "Run plan vN" once the data check is ok (pageState 5/9); poll by
    // reloading — the same page a human would refresh — rather than a second, API-only readiness
    // read standing in for this UI's own gate. The SPA can still be mid client-side navigation
    // when a reload fires, which aborts that reload's own navigation (net::ERR_ABORTED / frame
    // detached); a plain `goto` of the same URL avoids racing an in-flight `history` transition,
    // and a failed navigation is treated as "not ready yet" rather than a test failure.
    await expect.poll(async () => {
      try {
        await page.goto(`${BASE_URL}/investigator`, { waitUntil: 'load' });
      } catch {
        return null;
      }
      const btn = page.getByTestId('study-primary-action');
      return (await btn.count()) > 0 ? await btn.textContent() : null;
    }, { timeout: 180_000, message: 'the Study page never reached a launchable state' }).toMatch(/Run plan/);

    await page.getByTestId('study-primary-action').click();
    await expect(page.getByTestId('study-launch-progress')).toBeVisible({ timeout: 15_000 }).catch(() => {});
    await shot(page, 'launch-all-clicked');

    await expect.poll(async () => {
      try {
        await page.goto(`${BASE_URL}/investigator`, { waitUntil: 'load' });
      } catch {
        return -1;
      }
      const verdicts = await page.getByTestId(/^study-question-verdict-/).allInnerTexts().catch(() => []);
      return verdicts.length;
    }, { timeout: 15 * 60_000, message: 'not all four questions produced a verdict in time' }).toBeGreaterThanOrEqual(4);
    await shot(page, 'all-four-finished-on-study-home');
  });

  for (const q of QUESTIONS) {
    test(`AXI-2659.8 ${q.key} result page renders a real chart`, async ({ page }) => {
      await signInBrowser(page, invTokens, orgId, projectId);
      await page.goto(`${BASE_URL}/investigator`);
      await expect(page.getByTestId('study-results')).toBeVisible({ timeout: 30_000 });
      // The result card's own "Open result" affordance resolves the latest run id async
      // (`openStudyResult`) — give it room, then land on the result page either way it opens.
      const openLink = page.getByText(q.text, { exact: false }).first();
      await expect(openLink).toBeVisible({ timeout: 20_000 });
      await openLink.click();
      await expect(page).toHaveURL(new RegExp(`/investigator/projects/${projectId}/runs/`), { timeout: 30_000 });
      const chart = page.getByTestId('rp-chart').or(page.getByTestId('rp-figure'));
      await expect(chart.first()).toBeVisible({ timeout: 30_000 });
      await shot(page, `${q.key}-result-chart`);
    });
  }

  test('AXI-2659.9 the Study home shows all four images; each opens its own result; reload keeps all four', async ({ page }) => {
    await signInBrowser(page, invTokens, orgId, projectId);
    await page.goto(`${BASE_URL}/investigator`);
    await expect(page.getByTestId('study-results')).toBeVisible({ timeout: 30_000 });
    for (const q of QUESTIONS) await expect(page.getByText(q.text)).toBeVisible({ timeout: 15_000 });
    await shot(page, 'study-home-four-images-before-reload');

    await page.reload();
    await expect(page.getByTestId('study-results')).toBeVisible({ timeout: 30_000 });
    for (const q of QUESTIONS) await expect(page.getByText(q.text)).toBeVisible({ timeout: 15_000 });
    await shot(page, 'study-home-four-images-after-reload');
  });
});

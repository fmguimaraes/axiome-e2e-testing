import { test, expect, type Page, type Locator } from '@playwright/test';
import { adminApi, sleep, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, createAnalysis, createSnapshot, uniq, type Tenant } from './harness/seed-axi1234';

/**
 * AXI-1877 (epic AXI-1233) — the LIVE capture site for frozen chart renders,
 * driven in a real browser (review-gate rework: the prior pass shipped only
 * `AXI-1234-freeze-render.spec.ts`, which is API-only with hand-built
 * `frozenRender` payloads and so exercises NONE of this story's diff — not
 * `VisualizationCard`'s `buildFrozenRenderPayload` call, not
 * `ProjectViewAnalysisDetail`'s `handleCreateEvidenceFromChart` /
 * `handleAddToExistingEvidence` wiring, not `AddToEvidenceModal`).
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1234-Freeze-Rendered-Chart-At-
 * Citation-Time.md` §4.1/§4.2 (re-tagged `automation: playwright` by this
 * story once this spec is green).
 *
 * Flow driven for real, through the gallery (`ProjectViewAnalysisDetail`'s
 * default `all-charts` sub-tab → `DatasetVisualizations` →
 * `VisualizationCard`): open a live-rendered chart card's overflow menu →
 * click "Add to evidence" → the `AddToEvidenceModal` → submit. Three
 * scenarios, covering BOTH wiring branches the diff exposes:
 *
 *   A. §4.1 AC1 — "Create New" (`handleCreateEvidenceFromChart`): the first
 *      live click on chart #1 freezes a `dvi_…` fingerprint and marks the
 *      `EvidenceChart` `frozen: true`.
 *   B. §4.2 — re-citing the IDENTICAL live render (same chart #1, same
 *      snapshot, unchanged screen) into a SECOND new Evidence is idempotent:
 *      the same `dvi_…` fingerprint, not a second distinct one.
 *   C. §4.2 — "Add to Existing" (`handleAddToExistingEvidence`): citing a
 *      DIFFERENT live-rendered chart (#2) into evidence A freezes a
 *      SECOND, DISTINCT `dvi_…` fingerprint, proving the second wiring
 *      branch independently freezes its own render rather than reusing the
 *      first entry's.
 *
 * REAL BACKEND, LLM-FREE: reuses AXI-1234's own seeding harness (admin
 * token, additive org/workspace/project/dataset, one fresh ViewAnalysis +
 * snapshot per run — `uniq()`-safe, never collides with a parallel run).
 * The chart cards themselves are the dataset's AUTO-origin candidates
 * (`de_small.csv`'s differential-expression columns yield ~30 of them, so
 * the gallery always has at least two to click) — never hand-built, same
 * "pick the platform's own candidate, never author one" discipline the
 * rest of the suite follows for recommended charts.
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });

let api: Api;
let t: Tenant;
let analysisId: string;
let page: Page;

test.beforeAll(async ({ browser }) => {
  api = await adminApi();
  t = await ensureTenant(api);
  analysisId = await createAnalysis(api, t, `AXI-1877 live capture ${uniq()}`);
  await createSnapshot(api, t, analysisId, []);

  const context = await browser.newContext();
  page = await context.newPage();
  // The app reads the active org/workspace from localStorage, not the URL
  // (mirrors AXI-1435's `seedWorkspaceScope`) — the default `chromium`
  // project already injects the admin's auth via `storageState`.
  await context.addInitScript(
    ([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [t.workspaceId, t.orgId] as const,
  );
  await page.goto(`/projects/${t.projectId}/view-analyses/${analysisId}`);
  // `all-charts` is the default sub-tab, which mounts `DatasetVisualizations`
  // (the gallery `VisualizationCard`s live here) with no extra navigation.
  await expect(page.locator('h4[title]').first()).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await page?.context().close();
  await api?.ctx.dispose();
});

/** A gallery chart card, located by its position among cards carrying a
 *  rendered `h4[title]` header (the card's own title attribute — never a
 *  hand-picked title string, since the auto-candidate titles are not
 *  guaranteed unique). */
function cardAt(index: number): Locator {
  // Walk up from the title itself to the NEAREST ancestor carrying the
  // card's own wrapper classes, rather than filtering `div.group` broadly —
  // a page-level `:has()` filter can resolve to an outer wrapper that also
  // happens to carry a `group` utility class, whose much larger bounding box
  // then makes an unrelated element (the chart's own clickable container)
  // intercept clicks meant for this card's overflow button.
  // `ancestor::` walks in DOCUMENT order (root → leaf), so a trailing `[1]`
  // would select the OUTERMOST match (the whole gallery grid, which also
  // carries a `group` utility class elsewhere) rather than the nearest one —
  // exactly the trap that made a distant chart's own clickable container
  // intercept clicks meant for THIS card's overflow button. `.last()` on the
  // unindexed axis picks the nearest ancestor instead.
  const title = page.locator('h4[title]').nth(index);
  return title.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " group ")]').last();
}

/** Waits for the card's Plotly figure to actually be drawn — the ingredient
 *  `buildFrozenRenderPayload` needs (`chartConfig`) is only populated once
 *  the chart has rendered; clicking "Add to evidence" before that would
 *  legitimately resolve a legacy (unfrozen) citation, same as AXI-1234's
 *  scope note describes for an un-rendered chart. */
async function waitForChartRendered(card: Locator): Promise<void> {
  await expect(card.locator('svg.main-svg').first()).toBeVisible({ timeout: 30_000 });
}

/** Opens a card's overflow menu and clicks "Add to evidence" — the single
 *  entry point `VisualizationCard`'s `onAddToEvidence` call site wires.
 *  "Open"/"More actions" live in a `pointer-events-none` footer overlay
 *  that only becomes hit-testable via the real CSS `group-hover` on the
 *  card's ancestor (`group-hover:pointer-events-auto`) — a synthetic mouse
 *  click (even `force: true`, which still hit-tests through the real DOM)
 *  is unreliable here because the hover has to land and settle on the
 *  CARD, not the button, before the button is hit-testable at all. A
 *  native `element.click()` dispatch bypasses hit-testing/pointer-events
 *  entirely while still firing the real DOM `click` event React's
 *  delegated listener picks up, so it is deterministic regardless of the
 *  hover/opacity choreography. */
async function clickAddToEvidence(card: Locator): Promise<void> {
  await card.getByTitle('More actions').evaluate((el) => (el as HTMLElement).click());
  const menuItem = card.getByRole('menuitem', { name: 'Add to evidence' });
  await menuItem.waitFor({ state: 'attached' });
  await menuItem.evaluate((el) => (el as HTMLElement).click());
}

/** Submits the modal's "Create New" path, naming the Evidence so it can be
 *  found again in the "Add to Existing" picker (test C). Absorbs the
 *  optional empty-framing soft warning (AXI-908/AXI-914) — this tenant has
 *  no Review Question/assumptions, so it always fires; "Continue anyway" is
 *  the same non-blocking path a real user takes. */
async function createNewEvidence(evidenceTitle: string): Promise<void> {
  await page.getByRole('button', { name: 'Create New' }).click();
  await page.getByPlaceholder('Evidence title').fill(evidenceTitle);
  await page.getByTestId('create-evidence-submit').click();
  const continueAnyway = page.getByTestId('empty-framing-continue');
  if (await continueAnyway.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await continueAnyway.click();
  }
  await expect(page.getByTestId('create-evidence-submit')).not.toBeVisible({ timeout: 15_000 });
}

/** Submits the modal's "Add to Existing" path, selecting the Evidence whose
 *  title this spec itself gave it. */
async function addToExistingEvidence(evidenceTitle: string): Promise<void> {
  await page.getByRole('button', { name: 'Add to Existing' }).click();
  await page.getByText(evidenceTitle, { exact: true }).click();
  await page.getByRole('button', { name: 'Add to Evidence' }).click();
  await expect(page.getByRole('button', { name: 'Add to Evidence' })).not.toBeVisible({ timeout: 15_000 });
}

async function evidencesFor(): Promise<any[]> {
  const res = await api.get(`/api/v1/view-analyses/${analysisId}/evidences?page=1&limit=100`, t.headers);
  expect(res.status).toBe(200);
  const body: any = res.body;
  return Array.isArray(body) ? body : (body.data ?? body.items ?? []);
}

async function fetchEvidence(evidenceId: string): Promise<any> {
  const res = await api.get(`/api/v1/view-analyses/evidences/${evidenceId}`, t.headers);
  expect(res.status).toBe(200);
  return res.body;
}

/** Polls until the evidences list grows past `beforeIds`, returning the one
 *  new entry — the UI gives no evidence id back to the test directly. */
async function newestEvidenceSince(beforeIds: Set<string>): Promise<any> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const list = await evidencesFor();
    const added = list.find((e) => !beforeIds.has(e.id));
    if (added) return added;
    await sleep(500);
  }
  throw new Error('no new evidence appeared within 20s of the live create');
}

const TITLE_A = `AXI-1877 evidence A ${uniq()}`;
const TITLE_B = `AXI-1877 evidence B ${uniq()}`;

let evidenceAId: string;
let fingerprintA: string;

test('§4.1 AC1 — live click on a rendered chart card (Create New) freezes a dvi_ fingerprint and marks EvidenceChart.frozen true', async () => {
  const card = cardAt(0);
  await waitForChartRendered(card);

  const before = new Set((await evidencesFor()).map((e) => e.id));
  await clickAddToEvidence(card);
  await createNewEvidence(TITLE_A);

  const created = await newestEvidenceSince(before);
  evidenceAId = created.id;
  const fingerprint = created.currentVersion.chartArtifactIds[0];
  expect(fingerprint, 'the live capture site must freeze to a dvi_ fingerprint, not forward the raw spec id').toMatch(/^dvi_/);
  fingerprintA = fingerprint;

  const fetched = await fetchEvidence(evidenceAId);
  expect(fetched.currentVersion.charts[0].chartArtifactId).toBe(fingerprint);
  expect(fetched.currentVersion.charts[0].frozen, 'EvidenceChart.frozen must be true for a live capture-site citation').toBe(true);
});

test('§4.2 — re-citing the IDENTICAL live render (same chart, same snapshot, Create New again) is idempotent, not a second distinct fingerprint', async () => {
  const card = cardAt(0);
  await waitForChartRendered(card);

  const before = new Set((await evidencesFor()).map((e) => e.id));
  await clickAddToEvidence(card);
  await createNewEvidence(TITLE_B);

  const created = await newestEvidenceSince(before);
  const fingerprint = created.currentVersion.chartArtifactIds[0];
  expect(fingerprint).toMatch(/^dvi_/);
  expect(fingerprint, 'citing the same render twice from the live UI must resolve to the SAME fingerprint').toBe(fingerprintA);
});

test('§4.2 — "Add to Existing" on a DIFFERENT live chart freezes a second, distinct dvi_ fingerprint onto evidence A', async () => {
  const card = cardAt(1);
  await waitForChartRendered(card);

  await clickAddToEvidence(card);
  await addToExistingEvidence(TITLE_A);

  const fetched = await fetchEvidence(evidenceAId);
  const fingerprints: string[] = fetched.currentVersion.chartArtifactIds;
  expect(fingerprints.length, 'the Add to Existing live path must append a second chart entry').toBe(2);
  const secondFingerprint = fingerprints.find((f) => f !== fingerprintA);
  expect(secondFingerprint, 'the second entry must be a dvi_ fingerprint').toMatch(/^dvi_/);
  expect(secondFingerprint, 'a different live-rendered chart must freeze to a DIFFERENT fingerprint').not.toBe(fingerprintA);

  const secondChart = fetched.currentVersion.charts.find((c: any) => c.chartArtifactId === secondFingerprint);
  expect(secondChart.frozen, 'the Add to Existing branch must also mark EvidenceChart.frozen true').toBe(true);
});

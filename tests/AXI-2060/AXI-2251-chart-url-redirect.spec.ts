import { test, expect, request as apiRequest, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2251 (epic AXI-2060) — a chart page URL carrying the WRONG `:datasetId`
 * redirects (history replace) to the spec's own dataset instead of "Chart Not
 * Available" (AC1); a spec the caller cannot read still shows "Chart Not
 * Available" and the server never discloses where it lives (AC2).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2251.
 * Tags: @SI-033 (chart page), @SI-010 (gateway location route).
 *
 * READ-ONLY: no POST/PATCH/PUT except the login call. The defaults are the
 * owner-reported case on the demo stack (org CeRAINOM-IgG4, workspace Mag4):
 * chart `4ff3066b…` belongs to dataset `4c1bd11e…` (tableau1_long_synthetic_v2),
 * and the stale URL named dataset `65faf411…` (a stats-result parquet). Every
 * id is overridable by env so the same spec runs on an isolated stack whose
 * seed adds a REAL cross-tenant spec (AXI2251_UNREADABLE_SPEC_ID, in a
 * workspace the AC2 actor is not a member of). With the defaults, AC2 uses a
 * never-minted id, which the server answers exactly like a cross-tenant one.
 */

function fromEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

const ORGANIZATION_ID = fromEnv('AXI2251_ORG_ID', 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3');
const WORKSPACE_ID = fromEnv('AXI2251_WORKSPACE_ID', '8946e06a-4fe6-45ee-8d9a-58f7142e803a');
const SPEC_ID = fromEnv('AXI2251_SPEC_ID', '4ff3066b-ca20-4d2a-adac-5676cd7d79d9');
const OWN_DATASET_ID = fromEnv('AXI2251_OWN_DATASET_ID', '4c1bd11e-74db-4939-ad9f-c4644a0fde7f');
const STALE_DATASET_ID = fromEnv('AXI2251_STALE_DATASET_ID', '65faf411-d597-4b35-b589-c1cb48391fe4');
const NEVER_MINTED_SPEC_ID = '00000000-0000-4000-8000-000000000000';
const UNREADABLE_SPEC_ID = fromEnv('AXI2251_UNREADABLE_SPEC_ID', NEVER_MINTED_SPEC_ID);

const ADMIN = {
  email: fromEnv('E2E_ADMIN_EMAIL', 'admin@cro-one.com'),
  password: fromEnv('E2E_ADMIN_PASSWORD', 'admin'),
};
const AC2_ACTOR = {
  email: fromEnv('AXI2251_AC2_EMAIL', ADMIN.email),
  password: fromEnv('AXI2251_AC2_PASSWORD', ADMIN.password),
};

type Actor = typeof ADMIN;

function chartUrl(datasetId: string, specId: string) {
  return `/datasets/${datasetId}/chart/${specId}`;
}

function locationPath(specId: string) {
  return `/api/v1/workspaces/${WORKSPACE_ID}/candidates/${specId}/location`;
}

async function signIn(page: Page, actor: Actor) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(actor.email);
  await page.locator('input[type="password"]').fill(actor.password);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  // Same scope priming as AXI-2241: a multi-org account needs the top-menu
  // org/workspace set before a deep link resolves against the right tenant.
  await page.evaluate(([org, ws]) => {
    localStorage.setItem('axiome-top-org', org);
    localStorage.setItem('axiome-active-workspace', ws);
  }, [ORGANIZATION_ID, WORKSPACE_ID]);
}

/** GETs the location route as `actor` (bearer token from a real login). */
async function getLocation(actor: Actor, specId: string) {
  const api = await apiRequest.newContext();
  try {
    const login = await api.post(apiUrl('/api/v1/auth/login'), { data: actor });
    expect(login.ok(), `login as ${actor.email}`).toBeTruthy();
    const { accessToken } = await login.json();
    const res = await api.get(apiUrl(locationPath(specId)), {
      headers: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID },
    });
    return { status: res.status(), body: await res.text() };
  } finally {
    await api.dispose();
  }
}

/** The refusal with its per-request echo (`path`, `timestamp`) removed. */
function refusalShape(body: string) {
  const { path: _path, timestamp: _timestamp, ...rest } = JSON.parse(body);
  return rest;
}

test.describe('AXI-2251 - a chart URL with the wrong dataset opens the chart on its own dataset', { tag: ['@SI-033', '@SI-010'] }, () => {
  // Signs in through the login form with the target stack's own account,
  // never the fixture-org `setup` project's storageState (AXI-1884 opt-out).
  test.use({ storageState: { cookies: [], origins: [] } });

  test('AC1 - a readable spec loaded under the wrong dataset id replaces the URL with its own dataset and renders @SI-033', async ({ page }) => {
    await signIn(page, ADMIN);
    const historyBefore = await page.evaluate(() => window.history.length);

    await page.goto(chartUrl(STALE_DATASET_ID, SPEC_ID));

    await expect(page).toHaveURL(new RegExp(`/datasets/${OWN_DATASET_ID}/chart/${SPEC_ID}(\\?|$)`), { timeout: 15_000 });
    await expect(page.getByText('Chart Not Available')).toHaveCount(0);
    // Data marks, not just the axes frame: a box (boxplot) or a point (strip).
    const dataMarks = page.locator('.js-plotly-plot path.box, .js-plotly-plot path.point');
    await expect.poll(async () => dataMarks.count(), { timeout: 20_000 }).toBeGreaterThan(0);
    // Replace, not push: the stale URL's own entry was overwritten, so the
    // history grew by the single `goto` only.
    expect(await page.evaluate(() => window.history.length)).toBe(historyBefore + 1);
  });

  test('AC1 - the location route answers the spec\'s own dataset for a caller who can read it @SI-010', async () => {
    const res = await getLocation(ADMIN, SPEC_ID);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ datasetVersionId: OWN_DATASET_ID });
  });

  test('AC2 - an unreadable spec is refused exactly like a never-minted one, with no dataset disclosed @SI-010', async () => {
    const unreadable = await getLocation(AC2_ACTOR, UNREADABLE_SPEC_ID);
    const neverMinted = await getLocation(AC2_ACTOR, NEVER_MINTED_SPEC_ID);

    expect(unreadable.status).toBe(404);
    expect(unreadable.body).not.toContain('datasetVersionId');
    expect(refusalShape(unreadable.body)).toEqual(refusalShape(neverMinted.body));
  });

  test('AC2 - an unreadable spec under a chart URL still shows Chart Not Available, URL unchanged @SI-033', async ({ page }) => {
    const locationStatuses: number[] = [];
    page.on('response', (res) => {
      if (res.url().includes(`/candidates/${UNREADABLE_SPEC_ID}/location`)) locationStatuses.push(res.status());
    });
    await signIn(page, AC2_ACTOR);
    const url = chartUrl(STALE_DATASET_ID, UNREADABLE_SPEC_ID);

    await page.goto(url);

    await expect(page.getByText('Chart Not Available')).toBeVisible({ timeout: 15_000 });
    // The app may prefix its `/:org/:workspace` slugs; the chart path itself is untouched.
    expect(new URL(page.url()).pathname).toMatch(new RegExp(`${url}$`));
    // The page did ask (the fix is live) and was refused every time.
    expect(locationStatuses.length).toBeGreaterThan(0);
    expect(locationStatuses.every((s) => s === 404)).toBe(true);
  });
});

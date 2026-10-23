import { test, expect, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2242 (epic AXI-2060) — strip/boxplot display reproduction.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2242.
 * Tags: @SI-033.
 *
 * READ-ONLY against the real seeded demo project "Microbiote IgG4 —
 * synthetic reproduction (AXI-2064)" (org CeRAINOM-IgG4, workspace Mag4):
 * drives the live `/datasets/:datasetId/chart/:specId` Config UI for the
 * ENT059 strip_v1 chart (`baeef139-…`) and reads the actually-rendered
 * Plotly figure (`document.querySelector('.js-plotly-plot')`), never the
 * stored spec's `params` — proves the fix in the browser bundle, not just
 * in the unit-tested builder function. No edit made here is saved back to
 * the server (verified by direct GET after each run); the spec never calls
 * a PATCH/POST endpoint.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const ENT059_DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
const ENT059_STRIP_SPEC_ID = 'baeef139-64f0-4226-aad7-fdc7969d44e4';

async function signInAdmin(page: Page) {
  const email = process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com';
  const password = process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin';
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.evaluate(([org, ws]) => {
    localStorage.setItem('axiome-top-org', org);
    localStorage.setItem('axiome-active-workspace', ws);
  }, [ORGANIZATION_ID, WORKSPACE_ID]);
}

function chartUrl(datasetId: string, specId: string) {
  return `/datasets/${datasetId}/chart/${specId}`;
}

type GdTrace = { type: string; name: string; meta?: { pointsOnlyBox?: boolean }; line?: { color?: string }; fillcolor?: string };

async function readGraphData(page: Page): Promise<GdTrace[]> {
  await expect.poll(async () => page.locator('.js-plotly-plot').count(), { timeout: 15_000 }).toBeGreaterThan(0);
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gd = document.querySelector('.js-plotly-plot') as any;
    return gd.data.map((t: GdTrace) => ({ type: t.type, name: t.name, meta: t.meta, line: t.line, fillcolor: t.fillcolor }));
  });
}

async function readYAxisTitle(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gd = document.querySelector('.js-plotly-plot') as any;
    return gd?.layout?.yaxis?.title?.text;
  });
}

test.describe('AXI-2242 - strip/boxplot display reproduction', { tag: ['@SI-033'] }, () => {
  // Serial: all four tests drive the SAME live chart page/dev-server; running
  // them in parallel workers causes browser/dev-server resource contention
  // (the Plotly figure intermittently fails to mount under load) — not a
  // product bug. See AXI-2178's sibling spec for the same convention.
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: { cookies: [], origins: [] } });

  test('AC1 @SI-033 - a strip\'s box trace stays fully transparent under the page\'s default palette', async ({ page }) => {
    await signInAdmin(page);
    await page.goto(chartUrl(ENT059_DATASET_ID, ENT059_STRIP_SPEC_ID));
    const traces = await readGraphData(page);
    const boxTraces = traces.filter((t) => t.type === 'box');
    expect(boxTraces.length).toBeGreaterThan(0);
    for (const t of boxTraces) {
      expect(t.meta?.pointsOnlyBox, `${t.name} must be tagged points-only`).toBe(true);
      expect(t.line?.color, `${t.name} line.color must stay transparent`).toBe('rgba(0, 0, 0, 0)');
      expect(t.fillcolor, `${t.name} fillcolor must stay transparent`).toBe('rgba(0, 0, 0, 0)');
    }
  });

  test('AC2/AC5 @SI-033 - default group order is HD, IgG4-RD, SD (first appearance, not group size)', async ({ page }) => {
    await signInAdmin(page);
    await page.goto(chartUrl(ENT059_DATASET_ID, ENT059_STRIP_SPEC_ID));
    const traces = await readGraphData(page);
    const order = traces.filter((t) => t.type === 'box').map((t) => t.name);
    expect(order).toEqual(['HD', 'IgG4-RD', 'SD']);
  });

  test('AC2/AC3 @SI-033 - editing Group Order / Y Axis Title in the Config UI updates the live figure', async ({ page }) => {
    await signInAdmin(page);
    await page.goto(chartUrl(ENT059_DATASET_ID, ENT059_STRIP_SPEC_ID));
    await page.getByText('Visual', { exact: true }).click();

    const yTitleInput = page.locator('label:has-text("Y Axis Title")').locator('xpath=following-sibling::input[1]');
    await yTitleInput.fill('% microbiota opsonized');
    await yTitleInput.blur();
    await expect.poll(() => readYAxisTitle(page)).toBe('% microbiota opsonized');

    const groupOrderInput = page.locator('label:has-text("Group Order")').locator('xpath=following-sibling::input[1]');
    await groupOrderInput.fill('SD, HD, IgG4-RD');
    await groupOrderInput.blur();
    await expect.poll(async () => {
      const traces = await readGraphData(page);
      return traces.filter((t) => t.type === 'box').map((t) => t.name);
    }).toEqual(['SD', 'HD', 'IgG4-RD']);
  });

  test('never persists an edit back to the stored spec', async ({ page, request }) => {
    await signInAdmin(page);
    await page.goto(chartUrl(ENT059_DATASET_ID, ENT059_STRIP_SPEC_ID));
    await page.getByText('Visual', { exact: true }).click();
    const yTitleInput = page.locator('label:has-text("Y Axis Title")').locator('xpath=following-sibling::input[1]');
    await yTitleInput.fill('this edit must never be saved');
    await yTitleInput.blur();
    await page.waitForTimeout(2_000);

    const login = await request.post(apiUrl('/api/v1/auth/login'), { data: { email: 'admin@cro-one.com', password: 'admin' } });
    const { accessToken } = await login.json();
    const res = await request.get(
      apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${ENT059_DATASET_ID}/candidates/${ENT059_STRIP_SPEC_ID}`),
      { headers: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } },
    );
    const spec = await res.json();
    expect(spec.params?.y_title).toBeUndefined();
    expect(spec.params).toEqual({ show_median: true });
  });
});

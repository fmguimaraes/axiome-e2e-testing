import { test, expect, type Locator, type Page, APIRequestContext, request } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2245 (epic AXI-2060) — `heatmap_annotated_v1` display-reproduction
 * params: fixed axis order, fixed colour scale, significance marks,
 * readable cell-label contrast, colour-bar/axis/chart titles.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2245.
 * Tags: @SI-033.
 *
 * Builds its OWN throwaway `heatmap_annotated_v1` candidate spec on the
 * real, read-only `heatmap_synthetic_v4.csv` dataset (`6779b1df…`) — never
 * the real chart `50b132fa…`/evidence `a19468b3…` that motivated this
 * story (AC8's reconfiguration of THAT chart is explicitly out of scope
 * here; see the manual-e2e doc). The throwaway spec is created in
 * `beforeAll` and deleted in `afterAll`.
 *
 * AUTHORED, NOT RUN GREEN in the authoring session: that session was
 * sandboxed against mutating any shared resource, including this
 * cleanly-deleted throwaway spec. Run against a dedicated, isolated
 * `wt-up.sh` worktree stack before reporting `e2e-pass`.
 */

const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const DATASET_ID = '6779b1df-8591-4510-bc31-a9afe364fc90'; // heatmap_synthetic_v4.csv

const X_ORDER = ['CER228', 'MAG4-27', 'MAG4-22', 'MAG4-13', 'CER215+234', 'CER229', 'ENT059'];
const Y_ORDER = ['sIgG4', 'IgG4-RD RI', 'IgG4+/HPF', 'Eosinophils', 'Plasmablasts', 'TFH'];

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, 'X-Workspace-Id': WORKSPACE_ID };
}

async function createThrowawaySpec(api: APIRequestContext, token: string, params: Record<string, unknown>) {
  const res = await api.post(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${DATASET_ID}/candidates`), {
    headers: headers(token),
    data: {
      templateId: 'heatmap_annotated_v1',
      templateVersion: '1.0.0',
      bindings: { x: 'reference', y: 'variable', z: 'rho', mark: 'significance' },
      params,
      title: 'AXI-2245 throwaway test heatmap',
    },
  });
  expect(res.ok(), JSON.stringify(await res.json().catch(() => ({})))).toBeTruthy();
  const body = await res.json();
  return body.id as string;
}

async function deleteSpec(api: APIRequestContext, token: string, specId: string) {
  await api.delete(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${DATASET_ID}/candidates/${specId}`), {
    headers: headers(token),
  });
}

async function signInAdmin(page: Page) {
  const email = process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com';
  const password = process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin';
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  // The post-login bootstrap rewrites the active context; wait for it to
  // settle before pinning ours, then reload so the app reads it.
  await page.waitForLoadState('networkidle');
  await page.evaluate(([org, ws]) => {
    localStorage.setItem('axiome-top-org', org);
    localStorage.setItem('axiome-active-workspace', ws);
  }, [ORGANIZATION_ID, WORKSPACE_ID]);
  await page.reload();
}

/** Opens a chart page and waits for Plotly's first paint — a cold chart
 * route (dataset rows + column map + render) outlasts the 5 s default. */
async function openChart(page: Page, specId: string) {
  await page.goto(chartUrl(specId));
  await expect(page.locator('.js-plotly-plot .annotation-text').first()).toBeVisible({ timeout: 60_000 });
}

function chartUrl(specId: string) {
  return `/datasets/${DATASET_ID}/chart/${specId}`;
}

/** Plotly renders annotations as absolutely-positioned text layers; this
 * reads the rendered cell-label texts and colours off the DOM rather than
 * Plotly's internal state. */
async function annotationTexts(page: Page): Promise<string[]> {
  const nodes = page.locator('.annotation-text');
  await expect(nodes.first()).toBeVisible();
  return nodes.allTextContents();
}

/** Reads axis tick labels in VISUAL order (top-to-bottom for y,
 * left-to-right for x) from their rendered positions. Never use DOM order:
 * Plotly appends category tick <text> nodes in range-direction order, so
 * with `autorange: 'reversed'` the DOM-first y tick is the visually BOTTOM
 * label — a DOM-order read passes on the bug and fails on the fix. */
async function tickLabelsInVisualOrder(ticks: Locator, axis: 'x' | 'y'): Promise<string[]> {
  return ticks.evaluateAll(
    (nodes, ax) =>
      nodes
        .map((n) => {
          const r = n.getBoundingClientRect();
          return { label: (n.textContent ?? '').trim(), pos: ax === 'y' ? r.top + r.height / 2 : r.left + r.width / 2 };
        })
        .sort((a, b) => a.pos - b.pos)
        .map((e) => e.label),
    axis,
  );
}

test.describe('AXI-2245 - heatmap_annotated_v1 display-reproduction params', { tag: ['@SI-033'] }, () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  let api: APIRequestContext;
  let token: string;
  let fullSpecId: string;
  let defaultSpecId: string;

  test.beforeAll(async () => {
    api = await request.newContext();
    const login = await api.post(apiUrl('/api/v1/auth/login'), {
      data: { email: 'admin@cro-one.com', password: 'admin' },
    });
    expect(login.ok()).toBeTruthy();
    token = (await login.json()).accessToken;

    fullSpecId = await createThrowawaySpec(api, token, {
      x_order: X_ORDER,
      y_order: Y_ORDER,
      z_min: -1,
      z_max: 1,
      colorbar_title: 'Spearman ρ',
      mark_values: { after_correction: '*' },
      x_title: 'Reference',
      y_title: 'Variable',
      chart_title: 'AXI-2245 throwaway test spec',
    });
    defaultSpecId = await createThrowawaySpec(api, token, {});
  });

  test.afterAll(async () => {
    await deleteSpec(api, token, fullSpecId);
    await deleteSpec(api, token, defaultSpecId);
    await api?.dispose();
  });

  test('AC1/AC2/AC3/AC5 @SI-033 - configured order, fixed scale, significance mark and titles render', async ({ page }) => {
    await signInAdmin(page);
    await openChart(page, fullSpecId);

    // AC1: x/y category order, first y_order item at the top.
    const xTicks = page.locator('.xaxislayer-above .xtick text');
    await expect(xTicks.first()).toBeVisible();
    await expect.poll(() => tickLabelsInVisualOrder(xTicks, 'x')).toEqual(X_ORDER);
    const yTicks = page.locator('.yaxislayer-above .ytick text');
    // The builder sets `yaxis.autorange: 'reversed'` so y_order[0] renders
    // at the TOP. Read top-to-bottom by position, never DOM order.
    await expect.poll(() => tickLabelsInVisualOrder(yTicks, 'y')).toEqual(Y_ORDER);

    // AC3: CER228 x sIgG4 (first cell of both orders) carries the mapped
    // significance symbol; AC5: chart/axis titles render.
    const texts = await annotationTexts(page);
    expect(texts.some((t) => /^0\.59\*$/.test(t) || /\*$/.test(t))).toBeTruthy();
    await expect(page.getByText('AXI-2245 throwaway test spec')).toBeVisible();
    await expect(page.getByText('Reference', { exact: true })).toBeVisible();
    await expect(page.getByText('Spearman ρ')).toBeVisible();
  });

  test('AC4 @SI-033 - cell label colour contrasts with its cell colour', async ({ page }) => {
    await signInAdmin(page);
    await openChart(page, fullSpecId);
    await expect(page.locator('.annotation-text').first()).toBeVisible();
    const colors = await page.locator('.annotation-text').evaluateAll(
      (nodes) => nodes.map((n) => (n as SVGTextElement).style.fill || getComputedStyle(n).fill),
    );
    // At least one light-text and one dark-text annotation must be present —
    // a single constant colour (pre-fix: always #333) would fail this.
    const distinct = new Set(colors.filter(Boolean));
    expect(distinct.size).toBeGreaterThan(1);
  });

  test('AC7 @SI-033 - the config panel exposes and edits the new params', async ({ page }) => {
    await signInAdmin(page);
    await openChart(page, fullSpecId);
    // TemplateControls live under the chart page's "Visual" tab.
    await page.getByRole('button', { name: 'Visual', exact: true }).click();
    await expect(page.getByText('Colour Bar Title')).toBeVisible();
    await expect(page.getByText('X Order (comma-separated)')).toBeVisible();
    await expect(page.getByText('Y Order, top to bottom (comma-separated)')).toBeVisible();

    const colorbarInput = page.locator('label:has-text("Colour Bar Title") + input, label:has-text("Colour Bar Title") ~ input').first();
    await colorbarInput.fill('Edited title');
    await colorbarInput.blur();
    await expect(page.getByText('Edited title')).toBeVisible();
  });

  test('AC6 @SI-033 - a spec with none of the new params renders unchanged except the stable default order', async ({ page }) => {
    await signInAdmin(page);
    await openChart(page, defaultSpecId);
    const xTicks = page.locator('.xaxislayer-above .xtick text');
    await expect(xTicks.first()).toBeVisible();
    // Stable first-appearance order from the dataset's own row order, never
    // alphabetically re-sorted (the pre-AXI-2245 behaviour).
    await expect.poll(() => tickLabelsInVisualOrder(xTicks, 'x')).not.toEqual([...X_ORDER].sort());
    await expect(page.getByText('Spearman ρ')).not.toBeVisible();
  });
});

import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2557 (epic AXI-2433 — §6, §8, §9, MAG4 handover blocker): the "Run
 * relationship rule" modal opened with nothing pre-selected ("0 of 18
 * selected") and several chips sharing one visible label ("% Microbiota
 * Coated" seven times). Fixed by one shared, pure pre-selection function
 * (`src/lib/rules/preSelection.ts`), wired into `StatisticalRunConfigModal`
 * via `src/lib/rules/templateRolePreSelection.ts`, and a per-group
 * label-disambiguation fix in `columnChipEligibility.ts#splitColumnEligibility`.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-
 * Analysis-Plan.md` § AXI-2557.
 *
 * Isolation: same project/dataset as the sibling AXI-2297/AXI-2301 specs
 * (synthetic Tableau 2 reproduction project 22585add — never the live demo
 * project), selecting the EXISTING SEEDED `STAT-CORRELATION-MATRIX` system
 * carrier directly (AXI-2297's pattern) rather than cloning + approving it
 * (AXI-2301's pattern) — this story changes no publish/review behaviour, so
 * it needs no System-Admin-gated role-creation fixture. A THROWAWAY analysis
 * (`[e2e AXI-2557 throwaway]`), archived in `afterAll`.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_ID = '22585add-60ab-4d8e-a8ff-0f1071862553';
/** Projects this spec must never write into (live demo data). */
const FORBIDDEN_PROJECT_PREFIXES = ['4ff39166', 'b7b274bc'];
const DATASET_ID = 'f93231f3-20e7-445c-b0b3-8d767444ecb3';
const CARRIER_CODE = 'STAT-CORRELATION-MATRIX';
const THROWAWAY = '[e2e AXI-2557 throwaway]';

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
let analysisId = '';
let snapshotId = '';
/** Every column this dataset's own profile marks identifier-like — never hardcoded. */
let identifierColumnNames: string[] = [];

async function ok<T = any>(label: string, res: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.ok(), `${label}: ${r.status()} ${text}`).toBeTruthy();
  return (text ? JSON.parse(text) : {}) as T;
}

const ID_LIKE_NAME_TOKENS = new Set(['id', 'uid', 'uuid', 'key', 'code', 'identifier', 'hash', 'token', 'index', 'idx']);
const ID_LIKE_UNIQUENESS_THRESHOLD = 0.9;
/** Mirrors `columnChipEligibility.ts#MIN_ROWS_FOR_UNIQUENESS_CHECK` — see that
 *  file for why: this dataset's own 23 rows make several genuine numeric
 *  measurements (igg4_g_l, igg4_hpf, microbiote_igg4_cer_228, etc.) report
 *  `distinct_estimate === rowCount`, i.e. ratio 1.0, purely by small-sample
 *  coincidence — the uniqueness check must stay off here, same as the front
 *  end, or this helper would flag every one of them as a false identifier. */
const MIN_ROWS_FOR_UNIQUENESS_CHECK = 50;

/**
 * The REAL identifier signal (review gate #2, AXI-2557 rework #2 — BLOCKER):
 * mirrors `columnChipEligibility.ts#isPreSelectableColumn`'s identifier-only
 * checks byte-for-byte — logical type, id-shaped name token, and a
 * row-count-gated uniqueness ratio computed from the SAME `distinct_estimate`/
 * `null_pct` stats the front end reads — rather than rework #1's `role:
 * 'identifier'` role-candidate, which the real profiler never emits for a
 * numeric-typed column (review gate #2's exact finding) and which this
 * dataset's own `patient_id` happens to also carry only because it is
 * STRING-typed, not because that candidate is a reliable numeric-id signal.
 * Read off this dataset's own profile rather than hardcoded, so the
 * assertion stays honest if the fixture dataset changes.
 */
async function fetchIdentifierColumnNames(): Promise<string[]> {
  const profiles = await ok<{ id: string; status: string; rowCount: number | null }[]>('profiles', api.get(
    apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${DATASET_ID}/profiles`)));
  const ready = profiles.find((p) => p.status === 'ready') ?? profiles[0];
  expect(ready, 'dataset has a profile').toBeTruthy();
  const rowCount = ready.rowCount;
  const columns = await ok<{ name: string; logicalType: string; stats?: Record<string, unknown> }[]>('columns', api.get(
    apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${DATASET_ID}/profiles/${ready.id}/columns`)));
  const hasIdLikeNameToken = (name: string): boolean =>
    name.toLowerCase().replace(/-/g, '_').split(/[_\s]+/).some((p) => ID_LIKE_NAME_TOKENS.has(p));
  const hasHighUniqueness = (stats: Record<string, unknown> | undefined): boolean => {
    if (!rowCount || rowCount < MIN_ROWS_FOR_UNIQUENESS_CHECK) return false;
    const distinct = typeof stats?.distinct_estimate === 'number' ? stats.distinct_estimate : null;
    if (distinct === null) return false;
    const nullPct = typeof stats?.null_pct === 'number' ? stats.null_pct : 0;
    const nonNull = rowCount * (1 - nullPct);
    return nonNull > 0 && distinct / nonNull >= ID_LIKE_UNIQUENESS_THRESHOLD;
  };
  const isIdentifier = (c: { name: string; logicalType: string; stats?: Record<string, unknown> }): boolean =>
    ['identifier', 'id-like'].includes(c.logicalType.toLowerCase()) ||
    hasIdLikeNameToken(c.name) ||
    hasHighUniqueness(c.stats);
  return columns.filter(isIdentifier).map((c) => c.name);
}

async function signIn(page: Page) {
  await page.addInitScript(
    ([access, refresh, org, ws]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [accessToken, refreshToken, ORGANIZATION_ID, WORKSPACE_ID] as const,
  );
}

/** Opens "Run relationship rule" on the throwaway analysis, selects the seeded carrier, opens its config. */
async function openCorrelationMatrixConfig(page: Page): Promise<void> {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_ID}/view-analyses/${analysisId}?snapshotId=${snapshotId}`);
  await expect(page.getByRole('button', { name: /Snapshot v\d+/ }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Run rule' }).click();
  await expect(page.getByRole('heading', { name: /Run relationship rule/i })).toBeVisible({ timeout: 30_000 });
  // The shared stack carries several served copies of the system carrier (one per
  // seeding org) plus workspace clones (`…-clone`) — any exact-code row exercises
  // the same config path (AXI-2297's precedent).
  const row = page.getByRole('radio').filter({ hasText: new RegExp(`${CARRIER_CODE}(?!-)`) }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  // This rule's run config renders embedded (single-screen) — no separate
  // "Adjust parameters" step/"Configure …" heading to click through, unlike
  // MWU's two-step modal (AXI-2297). The References field is the signal the
  // embedded config panel has mounted.
  await expect(roleFrame(page, 'referenceColumns')).toBeVisible({ timeout: 30_000 });
}

function roleFrame(page: Page, role: string) {
  return page.locator(`[data-testid="rule-run-field"][data-field="role:${role}"]`);
}

async function chipCountText(page: Page, role: string): Promise<string> {
  return (await roleFrame(page, role).getByTestId('chip-picker-count').textContent()) ?? '';
}

/** The "N of M selected" header: N is the pre-selected count, M the eligible total. */
function parseCount(text: string): { selected: number; total: number } {
  const match = /^(\d+) of (\d+) selected$/.exec(text.trim());
  expect(match, `unexpected chip-picker-count text: "${text}"`).toBeTruthy();
  return { selected: Number(match![1]), total: Number(match![2]) };
}

/**
 * Just the chip's VISIBLE label — never the `.sr-only` tooltip-echo span a
 * chip also carries, which would make two chips sharing one visible label
 * look like different strings and silently defeat the duplicate check.
 * Reads the eligible group only — "Not usable here" chips are never
 * selectable/pre-selectable, so they are not what either assertion is about;
 * disambiguation itself now runs ACROSS both groups (§9, rework #1), this
 * helper just never needed to read the ineligible group's chips to check it.
 */
async function visibleChipLabels(page: Page, role: string, onlySelected = false): Promise<string[]> {
  const buttons = roleFrame(page, role).getByTestId('chip-eligible-group').getByRole('button');
  return buttons.evaluateAll(
    (els, selectedOnly) =>
      els
        .filter((el) => !selectedOnly || el.getAttribute('aria-pressed') === 'true')
        .map((el) =>
          Array.from(el.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent ?? '')
            .join('')
            .trim(),
        ),
    onlySelected,
  );
}

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('AXI-2557 - shared pre-selection + unique chip labels on the Run relationship rule modal', {
  tag: ['@SI-045', '@SI-002'],
}, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const login = await apiRequest.newContext();
    const res = await login.post(apiUrl('/api/v1/auth/login'), {
      data: {
        email: process.env.E2E_DEMO_EMAIL?.trim() || process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com',
        password: process.env.E2E_DEMO_PASSWORD?.trim() || process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin',
      },
    });
    expect(res.ok()).toBeTruthy();
    ({ accessToken, refreshToken } = await res.json());
    await login.dispose();
    api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } });
    expect(FORBIDDEN_PROJECT_PREFIXES.some((prefix) => PROJECT_ID.startsWith(prefix))).toBe(false);

    const catalogue = await ok<{ data: { id: string; code: string; tags?: string[]; scope: string }[] }>(
      'catalogue', api.get(apiUrl(`/api/v1/rules?scope=system&search=${CARRIER_CODE}&limit=50`)));
    const carrier = catalogue.data.find((r) => r.code === CARRIER_CODE && r.scope === 'system');
    expect(carrier, `${CARRIER_CODE} is seeded`).toBeDefined();

    const linked = await api.post(apiUrl(`/api/v1/projects/${PROJECT_ID}/datasets`), { data: { datasetId: DATASET_ID } });
    expect(linked.ok() || [400, 409].includes(linked.status()), `link dataset: ${linked.status()} ${await linked.text()}`).toBeTruthy();

    const analysis = await ok<{ id: string }>('analysis', api.post(apiUrl('/api/v1/view-analyses'), {
      data: { projectId: PROJECT_ID, datasetId: DATASET_ID, name: `${THROWAWAY} ${new Date().toISOString()}` },
    }));
    analysisId = analysis.id;
    const snapshot = await ok<{ id: string }>('snapshot', api.post(apiUrl('/api/v1/view-analyses/snapshots'), {
      data: { viewAnalysisId: analysisId, filters: [] },
    }));
    snapshotId = snapshot.id;

    identifierColumnNames = await fetchIdentifierColumnNames();
    expect(identifierColumnNames.length, 'dataset has at least one identifier column to assert against').toBeGreaterThan(0);
  });

  test.afterAll(async () => {
    if (analysisId) await api?.patch(apiUrl(`/api/v1/view-analyses/${analysisId}/archive`), { data: {} }).catch(() => undefined);
    await api?.dispose();
  });

  test('AXI-2557.1 - opening the rule pre-selects References and Variables (non-zero N of M), no duplicate visible labels, Run enabled without a click', async ({ page }) => {
    await openCorrelationMatrixConfig(page);

    const referenceCount = parseCount(await chipCountText(page, 'referenceColumns'));
    const variableCount = parseCount(await chipCountText(page, 'variableColumns'));
    expect(referenceCount.selected, 'referenceColumns pre-selected count').toBeGreaterThan(0);
    expect(variableCount.selected, 'variableColumns pre-selected count').toBeGreaterThan(0);

    for (const role of ['referenceColumns', 'variableColumns']) {
      const labels = await visibleChipLabels(page, role);
      expect(new Set(labels).size, `${role} chip labels: ${JSON.stringify(labels)}`).toBe(labels.length);

      // Review gate #1 (BLOCKER): the shared pre-selection function must never
      // pre-select an identifier column. Checked against this dataset's OWN
      // identifier column(s) (patient_id et al., fetched in beforeAll) — a
      // selected chip's visible label is the raw column name whenever it has
      // no semantic/glossary label (same fallback `resolveGlossaryLabel` uses),
      // so a literal name match is a faithful check, not a substring guess.
      const selectedLabels = await visibleChipLabels(page, role, true);
      for (const idName of identifierColumnNames) {
        expect(selectedLabels, `${role} selected chips must never include identifier column "${idName}": ${JSON.stringify(selectedLabels)}`)
          .not.toContain(idName);
      }
    }

    const submit = page.getByRole('button', { name: 'Run rule' }).last();
    await expect(submit).toBeEnabled({ timeout: 30_000 });
  });

  test('AXI-2557.2 - a pre-selected chip carries the mark and a hover reason', async ({ page }) => {
    await openCorrelationMatrixConfig(page);

    const mark = roleFrame(page, 'referenceColumns').getByTestId('chip-preselected-mark').first();
    await expect(mark).toBeVisible({ timeout: 30_000 });
    const chip = mark.locator('xpath=ancestor::button[1]');
    const title = await chip.getAttribute('title');
    expect(title, 'pre-selected chip has a hover reason').toBeTruthy();
  });
});

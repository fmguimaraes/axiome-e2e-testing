import { test, expect, type Page, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2528 (epic AXI-2422 — Analysis Template Library; closes the FR27/EC14
 * gap AXI-2426 left `automation: manual`). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2422-Analysis-Template-Library.md` § AXI-2528.
 *
 * AXI-2426 added the kernel's output-conformance check (a nested LIST-of-STRUCT
 * column such as `rocCoordinates` counts as ONE declared column) with "no
 * caller wired in" — there was no running UI surface that actually RECEIVED a
 * nested object in a result-table cell, so every scenario in that story was
 * `automation: manual`. AXI-2528 is that caller:
 * `StatisticalTableResult.tsx`'s `formatCell` now dispatches an object-typed
 * cell value to `describeNestedCellValue`
 * (`src/lib/rules/statisticalResult.ts`) and renders "N points (fields)" with
 * the full value as a hover tooltip, instead of the default
 * `String(value)` → the literal `'[object Object]'`.
 *
 * This spec drives the REAL `StatisticalTableResult` component inside the REAL
 * provenance-tree page (`/projects/:id/view-analyses/:id/provenance` →
 * `ReportProvenanceInspector` → "View statistical result"), the only mount
 * point this component has. Reaching it with a genuinely MATERIALIZED
 * `stats.cutoff_roc_youden` run would need a live bio-compute execution this
 * story's scope does not touch (AXI-1416's own spec declined that path for the
 * same reason — "manual residue" — needing "a real, ingested statistical
 * referent with a SUCCEEDED run materialized on it"). Instead, the THREE
 * network calls this component's data boundary makes — the provenance graph,
 * the operation registry, and the rule-run detail/table reads — are stubbed
 * with `page.route` to a deterministic `rocCoordinates`-shaped payload, while
 * everything else (auth, the page shell, the ReactFlow graph, the inspector,
 * the real `formatCell`/`describeNestedCellValue` render path) is the genuine
 * app. This is deterministic and Playwright-assertable without a bio-compute
 * dependency, and isolates exactly the regression AXI-2448 (kernel) and
 * AXI-2528 (this story) fixed.
 *
 * Auth: the default local admin (`admin@cro-one.com` / `admin` —
 * `docs/local-dev-and-debug.md`), whose membership already carries a
 * workspace with the seeded `admin` role (so `view-analysis:view` resolves
 * without provisioning a fresh actor/workspace for a page whose data is
 * entirely mocked here anyway).
 */

const OPERATION_ID = 'stats.e2e_axi2528_roc_stub';
const RUN_ID = 'e2e-axi2528-roc-run-1';

// Real backend records under the seeded "AXI-1921 Round-Trip Validation" workspace
// (axiome-e2e-testing's AXI-1911 round-trip fixture data) — the provenance-tree page
// looks up the project and view-analysis themselves (unmocked), so a synthetic
// placeholder id 404s before the mocked provenance-graph/operations/table routes
// below are ever reached. Only those three network calls are stubbed; the project
// and view-analysis records are genuinely read from the running backend.
const WORKSPACE_ID = 'bb38e131-7c84-4545-9f6e-13cf04b453cb';
const PROJECT_ID = 'ec1a47ba-0366-43ee-82e8-72d3926f08ab';
const VIEW_ANALYSIS_ID = '6fcf4942-f309-4e58-b287-8dc94d0fb3e2';
const ROC_COORDINATES = [
  { fpr: 0, tpr: 0, threshold: 1 },
  { fpr: 0.1, tpr: 0.52, threshold: 0.8 },
  { fpr: 1, tpr: 1, threshold: 0 },
];

interface AdminSession {
  accessToken: string;
  refreshToken: string;
  workspaceId: string;
  organizationId: string;
}

async function adminSession(): Promise<AdminSession> {
  const ctx = await apiRequest.newContext();
  const loginRes = await ctx.post(apiUrl('/api/v1/auth/login'), {
    data: { email: 'admin@cro-one.com', password: 'admin' },
  });
  if (!loginRes.ok()) {
    throw new Error(`admin login failed (${loginRes.status()}): ${await loginRes.text()}`);
  }
  const tokens = await loginRes.json();
  // The provenance-tree page looks up the project/view-analysis themselves (unmocked),
  // so the active workspace must be the one that actually owns PROJECT_ID/VIEW_ANALYSIS_ID
  // below — not just "any workspace the admin belongs to".
  const wsRes = await ctx.get(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}`), {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!wsRes.ok()) {
    throw new Error(`workspace ${WORKSPACE_ID} not reachable (${wsRes.status()}): ${await wsRes.text()}`);
  }
  const workspace = await wsRes.json();
  await ctx.dispose();
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    workspaceId: workspace.id,
    organizationId: workspace.ownerOrganizationId ?? workspace.memberOrganizationIds?.[0],
  };
}

/** Seed the real session + active org/workspace the app reads from localStorage (mirrors
 *  `tests/AXI-2265/AXI-2269-helpers.ts#signInAs` / `AXI-1419`'s `seedWorkspaceScope`). */
async function signIn(page: Page, session: AdminSession): Promise<void> {
  await page.addInitScript(
    ([access, refresh, ws, org]) => {
      localStorage.setItem('access_token', access as string);
      localStorage.setItem('refresh_token', refresh as string);
      localStorage.setItem('axiome-active-workspace', ws as string);
      localStorage.setItem('axiome-top-org', org as string);
    },
    [session.accessToken, session.refreshToken, session.workspaceId, session.organizationId] as const,
  );
}

/** The synthetic provenance graph: Dataset → (governed) MaterializedView STATISTICAL
 *  run → result Snapshot. The `stats.` prefix is what keeps the MaterializedView node
 *  from being collapsed into its snapshot (`reportProvenanceTransform.ts#isGovernedRuleExecution`). */
function provenanceGraph() {
  return {
    nodes: [
      { id: 'n-ds', nodeType: 'Dataset', referenceId: 'ds-axi2528', metadata: { title: 'AXI-2528 input dataset' } },
      {
        id: 'n-mv',
        nodeType: 'MaterializedView',
        referenceId: RUN_ID,
        metadata: { ruleRunId: RUN_ID, operationId: OPERATION_ID },
      },
      { id: 'n-snap', nodeType: 'ViewAnalysisSnapshot', referenceId: 'snap-axi2528', metadata: { version: 1 } },
    ],
    edges: [
      { id: 'e-1', sourceNodeId: 'n-ds', targetNodeId: 'n-mv', edgeType: 'input_to' },
      { id: 'e-2', sourceNodeId: 'n-mv', targetNodeId: 'n-snap', edgeType: 'derived_from' },
    ],
  };
}

async function mockStatisticalResultSurface(page: Page): Promise<void> {
  await page.route('**/api/v1/view-analyses/*/provenance-graph', (r) => r.fulfill({ status: 200, json: provenanceGraph() }));
  await page.route('**/api/v1/view-analyses/*/snapshots*', (r) => r.fulfill({ status: 200, json: { data: [] } }));
  await page.route('**/api/v1/view-analyses/*/dataset-links', (r) => r.fulfill({ status: 200, json: [] }));
  await page.route('**/api/v1/view-analyses/*/consolidated-node', (r) => r.fulfill({ status: 200, json: { latestConsolidatedNodeId: null } }));

  await page.route('**/api/v1/rule-runs/operations*', (r) =>
    r.fulfill({
      status: 200,
      json: {
        operations: [
          {
            operationId: OPERATION_ID,
            label: 'AXI-2528 ROC stub',
            submitToken: null,
            runKind: 'STATISTICAL',
            parameters: [],
            columnRoles: [],
            preconditions: [],
            output: { cardinality: 'ONE', shapedBy: null, shapes: {} },
            defaultChart: null,
          },
        ],
      },
    }));

  // Exact match (no trailing path) — the run DETAIL read, distinct from the `/table` read below.
  await page.route(`**/api/v1/rule-runs/${RUN_ID}`, (r) =>
    r.fulfill({
      status: 200,
      json: {
        id: RUN_ID,
        status: 'SUCCEEDED',
        summaryJson: { complete_pairs: 3, computed_rows: 1 },
        operationId: OPERATION_ID,
        runKind: 'STATISTICAL',
      },
    }));

  await page.route(`**/api/v1/rule-runs/${RUN_ID}/table*`, (r) =>
    r.fulfill({
      status: 200,
      json: {
        columns: ['marker', 'cutoff', 'auc', 'rocCoordinates'],
        rows: [{ marker: 'il6', cutoff: 1.2, auc: 0.81, rocCoordinates: ROC_COORDINATES }],
        totalRows: 1,
        page: 1,
        limit: 50,
      },
    }));
}

let session: AdminSession;

test.beforeAll(async () => {
  session = await adminSession();
});

test.describe('AXI-2528 — StatisticalTableResult renders a nested LIST-of-STRUCT cell', { tag: ['@SI-035', '@SI-017'] }, () => {
  test('AC — a rocCoordinates cell shows "N points (fields)" with a tooltip, never "[object Object]"', async ({ page }) => {
    // Arrange
    await signIn(page, session);
    await mockStatisticalResultSurface(page);

    // Act — open the provenance tree, select the governed STATISTICAL run node,
    // click through to its statistical-result consumer.
    await page.goto(`/projects/${PROJECT_ID}/view-analyses/${VIEW_ANALYSIS_ID}/provenance`);
    const node = page.locator('.react-flow__node').filter({ hasText: OPERATION_ID });
    await expect(node).toBeVisible({ timeout: 30_000 });
    await node.click();

    const openResult = page.getByRole('button', { name: 'View statistical result' });
    await expect(openResult).toBeVisible({ timeout: 10_000 });
    await openResult.click();

    // Assert — the modal's table cell summarizes the nested array instead of
    // coercing it to the default `String(value)`.
    const cell = page.locator('td', { hasText: '3 points (fpr, tpr, threshold)' });
    await expect(cell).toBeVisible({ timeout: 15_000 });

    // The full value is still inspectable via the cell's title tooltip.
    await expect(cell).toHaveAttribute('title', JSON.stringify(ROC_COORDINATES));

    // The regression this story fixes: the literal string never appears anywhere
    // in the rendered modal.
    const modalText = await page.locator('.fixed.inset-0').innerText();
    expect(modalText).not.toContain('[object Object]');
  });
});

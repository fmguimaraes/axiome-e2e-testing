import { test, expect, Page, Route } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import { ensureTenant1603 } from '../AXI-1603/harness/planner';

/**
 * AXI-1736 - Front consumes GET /guided-analysis/shapes, the interval/family member fields, and
 * the dataset semantic-declaration form (epic AXI-1687, SI-046). Offline: the browser drives the
 * REAL front end from the AXI-1736 worktree (Vite, BASE_URL) and every planner, governed and
 * discovery response is synthetic via `page.route`. No planner, provider key or Anthropic call is
 * made; `E2E_LIVE_LLM` is never read. The tenant fixture is API setup only (no LLM).
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section FE1736.
 * Contracts mocked: back AXI-1729 (`GET /guided-analysis/shapes`, run-status `family.members[]`
 * additive fields) and AXI-1730 (`discovery/datasets/:id/semantic-declaration[/revisions]`).
 */

type Tenant = Awaited<ReturnType<typeof ensureTenant1603>>;
const DATASET = '55555555-5555-4555-8555-555555555555';

async function seedWorkspaceScope(page: Page, t: Tenant): Promise<void> {
  await page.addInitScript(([ws, org]) => {
    localStorage.setItem('axiome-active-workspace', ws);
    localStorage.setItem('axiome-top-org', org);
  }, [t.workspaceId, t.orgId] as const);
}

const ok = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function node(id: string) {
  return {
    id, nodeType: 'compare_groups', stepLabel: `Compare ${id}`, clinicalQuestion: '', why: 'mock', dependsOn: [], params: {},
    expectedEvidence: { effect_measure: 'difference in medians', report_ci: true }, visualisation: null,
    proposedClaimCeiling: 'exploratory', familyId: 'F1', operation: { operationId: 'stats.mann_whitney_u' },
  };
}

async function interceptPlan(page: Page, over: Record<string, unknown>): Promise<void> {
  await page.route('**/api/v1/guided-analysis/plan', async (route: Route) => {
    const q = route.request().postDataJSON().envelope.question as string;
    await ok(route, {
      status: 'draft', envelopeHash: 'sha256:mock', plannerSawData: false, planner: 'compiled', promptId: null, promptVersion: null,
      promptTitle: null, plannerFallback: false, correlationId: 'axi1736-mock', attemptCount: 1, intentUnsupported: false,
      plan: {
        planId: 'PL-mock-1736', revision: 1, question: q, sendData: false,
        reasoning: { restatedQuestion: q, whyThisApproach: 'mock', whatThisWillNotEstablish: 'mock', alternativesConsidered: [] },
        datasetsUsed: [], datasetsAvailableNotUsed: [], declaredFamily: null, nodes: [node('n1')], attemptCount: 1, intentUnsupported: false, ...over,
      },
    }, 201);
  });
}

async function ask(page: Page, t: Tenant, question: string): Promise<void> {
  await page.goto(`/guided-analysis?projectId=${t.projectId}`);
  await expect(page.getByTestId('ga-question')).toBeVisible({ timeout: 25_000 });
  await page.getByTestId('ga-question').fill(question);
  await page.getByTestId('ga-send').click();
}

async function mockFamilyRun(page: Page, members: unknown[]): Promise<void> {
  await page.route('**/api/v1/governed-execution/submit', (r) => ok(r, { runId: 'GR-1736', viewAnalysisId: 'va-mock' }, 201));
  await page.route('**/api/v1/governed-execution/status**', (r) => ok(r, {
    runId: 'GR-1736', status: 'COMPLETED', runStatus: 'ok', degraded: false, degradeReasons: [], failReason: null,
    counts: { plannedTests: 2, evaluableTests: 2, subjectsInScope: 10, completePairs: 0 },
    nodes: ['a', 'b'].map((id) => ({ nodeId: `GR-1736__${id}`, status: 'SUCCEEDED', inputFingerprint: null, artifactHash: null, error: null })),
    family: { familyId: 'F1', familySize: 2, familyCorrectionApplied: false, members },
  }));
}

const familyPlan = { nodes: [node('a'), node('b')], declaredFamily: { id: 'F1', correction: 'FDR', familySize: 2, memberNodeIds: ['a', 'b'], summary: 's' } };

test.describe.configure({ mode: 'parallel', timeout: 120_000 });
let api: Api;
let tenant: Tenant;
test.beforeAll(async () => { api = await adminApi(); tenant = await ensureTenant1603(api); });
test.afterAll(async () => { await api?.ctx.dispose(); });

test.describe('AXI-1736 front consumes shapes, member fields and the declaration form', { tag: ['@SI-046'] }, () => {
  test('FE1736.1 AC73 the supported-shape list is exactly what GET /guided-analysis/shapes served @SI-046', async ({ page }) => {
    await seedWorkspaceScope(page, tenant);
    const served = Array.from({ length: 9 }, (_, i) => ({ shape: `shape_${i}`, description: `Served shape description ${i}` }));
    await page.route('**/api/v1/guided-analysis/shapes', (r) => ok(r, served));
    await interceptPlan(page, { nodes: [], intentUnsupported: true, unsupportedReason: 'no_shape' });
    await ask(page, tenant, 'AXI-1736 FE1736.1 probe');
    const list = page.getByTestId('ga-supported-shapes');
    await expect(list).toBeVisible({ timeout: 20_000 });
    await expect(list.getByRole('listitem')).toHaveCount(9);
    await expect(list).toContainText('Served shape description 8');
  });

  test('FE1736.2 AC73 a failed shapes call says so and shows no remembered list @SI-046', async ({ page }) => {
    await seedWorkspaceScope(page, tenant);
    await page.route('**/api/v1/guided-analysis/shapes', (r) => ok(r, { message: 'down' }, 503));
    await interceptPlan(page, { nodes: [], intentUnsupported: true, unsupportedReason: 'no_shape' });
    await ask(page, tenant, 'AXI-1736 FE1736.2 probe');
    await expect(page.getByTestId('ga-supported-shapes-state')).toHaveAttribute('data-state', 'error', { timeout: 20_000 });
    await expect(page.getByTestId('ga-supported-shapes')).toHaveCount(0);
  });

  test('FE1736.3 AC75 AC76 served member facts: interval, omnibus badge, unit statement; null is "not computed" @SI-046', async ({ page }) => {
    await seedWorkspaceScope(page, tenant);
    await interceptPlan(page, familyPlan);
    await mockFamilyRun(page, [
      { nodeId: 'GR-1736__a', proposedClaimCeiling: 'exploratory', operationId: 'stats.unpaired_ttest', interval: { low: 'ciLow', high: 'ciHigh' }, effect: null, omnibus: false, screenHoldout: null, unitStatement: "Read at the declared level 'ng/mL' (unit)." },
      { nodeId: 'GR-1736__b', proposedClaimCeiling: 'exploratory', operationId: 'stats.kruskal_wallis', interval: null, effect: null, omnibus: true, screenHoldout: null, unitStatement: 'No unit or representation level is declared for this measure.' },
    ]);
    await ask(page, tenant, 'AXI-1736 FE1736.3 probe');
    await page.getByTestId('plan-run').click({ timeout: 20_000 });
    const rows = page.getByTestId('ga-family-row');
    await expect(rows).toHaveCount(2, { timeout: 20_000 });
    await expect(rows.nth(0).getByTestId('ga-member-interval')).toContainText('ciLow to ciHigh');
    await expect(rows.nth(0).getByTestId('ga-member-unit')).toContainText("Read at the declared level 'ng/mL' (unit).");
    await expect(rows.nth(0).getByTestId('ga-badge-omnibus')).toHaveCount(0);
    await expect(rows.nth(1).getByTestId('ga-badge-omnibus')).toBeVisible();
    await expect(rows.nth(1).getByTestId('ga-member-interval')).toContainText('No interval for this test');
    await expect(rows.nth(1).getByTestId('ga-member-effect')).toContainText('not computed');
    await expect(rows.nth(1).getByTestId('ga-member-screen-holdout')).toContainText('not computed');
  });

  test('FE1736.4 AC76 an older back end (member fields absent) reads "not served", never a claim @SI-046', async ({ page }) => {
    await seedWorkspaceScope(page, tenant);
    await interceptPlan(page, familyPlan);
    await mockFamilyRun(page, [
      { nodeId: 'GR-1736__a', proposedClaimCeiling: 'exploratory' },
      { nodeId: 'GR-1736__b', proposedClaimCeiling: 'exploratory' },
    ]);
    await ask(page, tenant, 'AXI-1736 FE1736.4 probe');
    await page.getByTestId('plan-run').click({ timeout: 20_000 });
    const row = page.getByTestId('ga-family-row').first();
    await expect(row.getByTestId('ga-member-interval')).toContainText('not served', { timeout: 20_000 });
    await expect(row.getByTestId('ga-member-effect')).toContainText('not served');
    await expect(row.getByTestId('ga-member-unit')).toContainText('not served');
    await expect(page.getByTestId('ga-badge-omnibus')).toHaveCount(0);
  });

  test('FE1736.5 FR38 FR39 dataset Semantics tab: undeclared reading, declare sends {declaration} only, revision list pages @SI-046', async ({ page }) => {
    await seedWorkspaceScope(page, tenant);
    const dsUrl = `**/api/v1/workspaces/${tenant.workspaceId}/datasets/${DATASET}`;
    await page.route(dsUrl, (r) => ok(r, {
      id: DATASET, workspaceId: tenant.workspaceId, organizationId: tenant.orgId, originalFilename: 'mock.csv', displayName: 'Mock dataset',
      contentType: 'text/csv', sizeBytes: 10, availability: 'AVAILABLE', lockStatus: 'UNLOCKED', uploadedBy: 'u',
      uploadInitiatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    const sdBase = `**/api/v1/discovery/datasets/${DATASET}/semantic-declaration`;
    let current: unknown = null;
    const puts: unknown[] = [];
    const rec = (revision: number) => ({ id: `r${revision}`, datasetId: DATASET, revision, declaration: { scopeRoles: [] }, identityHash: 'abcdef0123456789', declaredBy: 'u', declaredAt: new Date().toISOString() });
    await page.route(sdBase, async (r) => {
      if (r.request().method() === 'PUT') {
        puts.push(r.request().postDataJSON());
        current = rec(1);
        return ok(r, { record: current, mintedNewRevision: true });
      }
      return ok(r, current);
    });
    const revisionPages: string[] = [];
    await page.route(`${sdBase}/revisions**`, (r) => {
      const p = Number(new URL(r.request().url()).searchParams.get('page'));
      revisionPages.push(String(p));
      return ok(r, { items: [rec(current ? (p === 1 ? 2 : 1) : 0)].filter((x) => x.revision > 0), total: current ? 11 : 0, page: p, limit: 10 });
    });
    await page.goto(`/datasets/${DATASET}`);
    await page.getByRole('button', { name: 'Semantics' }).click({ timeout: 30_000 });
    await expect(page.getByTestId('sd-none')).toBeVisible();
    await expect(page.getByTestId('sd-revisions-empty')).toBeVisible();
    await page.getByTestId('sd-edit').click();
    await page.getByTestId('sd-save').click();
    await expect(page.getByTestId('sd-notice')).toHaveText('Saved as revision 1.');
    expect(puts).toEqual([{ declaration: { scopeRoles: [] } }]);
    await expect(page.getByTestId('sd-current')).toHaveAttribute('data-revision', '1');
    await expect(page.getByTestId('sd-page')).toHaveText('Page 1 of 2');
    await page.getByTestId('sd-next').click();
    await expect(page.getByTestId('sd-page')).toHaveText('Page 2 of 2');
    expect(revisionPages).toContain('2');
  });

  test('FE1736.6 FR39 a server refusal is shown with its code and the editor stays open @SI-046', async ({ page }) => {
    await seedWorkspaceScope(page, tenant);
    await page.route(`**/api/v1/workspaces/${tenant.workspaceId}/datasets/${DATASET}`, (r) => ok(r, {
      id: DATASET, workspaceId: tenant.workspaceId, organizationId: tenant.orgId, originalFilename: 'mock.csv', contentType: 'text/csv',
      sizeBytes: 10, availability: 'AVAILABLE', lockStatus: 'UNLOCKED', uploadedBy: 'u', uploadInitiatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    const sdBase = `**/api/v1/discovery/datasets/${DATASET}/semantic-declaration`;
    await page.route(`${sdBase}/revisions**`, (r) => ok(r, { items: [], total: 0, page: 1, limit: 10 }));
    await page.route(sdBase, (r) => r.request().method() === 'PUT'
      ? ok(r, { statusCode: 400, message: 'refused', errors: [{ field: 'scopeRoles[0].column', code: 'DECL_ROLE_COLUMN_BLANK', message: 'names no column' }] }, 400)
      : ok(r, null));
    await page.goto(`/datasets/${DATASET}`);
    await page.getByRole('button', { name: 'Semantics' }).click({ timeout: 30_000 });
    await page.getByTestId('sd-edit').click();
    await page.getByTestId('sd-save').click();
    await expect(page.getByTestId('sd-issues')).toContainText('DECL_ROLE_COLUMN_BLANK');
    await expect(page.getByTestId('sd-editor')).toBeVisible();
  });
});

import { test, expect, Page, Route } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import { ensureTenant1603 } from '../AXI-1603/harness/planner';

/**
 * AXI-1740 - front polish on the dataset Semantics tab (epic AXI-1687). Offline: the real front end
 * from the AXI-1740 worktree (Vite, BASE_URL) with every discovery response synthetic via
 * `page.route`; the tenant fixture is API setup only. No LLM, `E2E_LIVE_LLM` never read.
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section FP1740.
 */

type Tenant = Awaited<ReturnType<typeof ensureTenant1603>>;
const DATASET = '55555555-5555-4555-8555-555555555555';
let api: Api;
let tenant: Tenant;
test.beforeAll(async () => { api = await adminApi(); tenant = await ensureTenant1603(api); });
test.afterAll(async () => { await api?.ctx.dispose(); });

const ok = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function openSemantics(page: Page, onPut: (body: unknown) => void, revisions: (r: Route) => Promise<void>): Promise<void> {
  await page.addInitScript(([ws, org]) => {
    localStorage.setItem('axiome-active-workspace', ws);
    localStorage.setItem('axiome-top-org', org);
  }, [tenant.workspaceId, tenant.orgId] as const);
  const now = new Date().toISOString();
  await page.route(`**/api/v1/workspaces/${tenant.workspaceId}/datasets/${DATASET}`, (r) => ok(r, {
    id: DATASET, workspaceId: tenant.workspaceId, organizationId: tenant.orgId, originalFilename: 'mock.csv', displayName: 'Mock dataset',
    contentType: 'text/csv', sizeBytes: 10, availability: 'AVAILABLE', lockStatus: 'UNLOCKED', uploadedBy: 'u',
    uploadInitiatedAt: now, createdAt: now, updatedAt: now,
  }));
  const sd = `**/api/v1/discovery/datasets/${DATASET}/semantic-declaration`;
  await page.route(`${sd}/revisions**`, revisions);
  await page.route(sd, (r) => {
    if (r.request().method() === 'PUT') {
      const body = r.request().postDataJSON();
      onPut(body);
      return ok(r, { record: { id: 'r1', datasetId: DATASET, revision: 1, declaration: body.declaration, identityHash: 'abcdef0123456789', declaredBy: 'u', declaredAt: now }, mintedNewRevision: true });
    }
    return ok(r, null);
  });
  await page.goto(`/datasets/${DATASET}`);
  await page.getByRole('button', { name: 'Semantics' }).click({ timeout: 30_000 });
}

test.describe('AXI-1740 semantics tab polish', { tag: ['@SI-046'] }, () => {
  test('FP1740.1 a revisions load failure is an error, not "No revisions yet." @SI-046', async ({ page }) => {
    await openSemantics(page, () => undefined, (r) => ok(r, { message: 'revisions down' }, 500));
    await expect(page.getByTestId('sd-revisions-error')).toContainText('revisions down', { timeout: 30_000 });
    await expect(page.getByTestId('sd-revisions-empty')).toHaveCount(0);
  });

  test('FP1740.2 the structured form writes the per-role declaration the server is sent @SI-046', async ({ page }) => {
    const puts: unknown[] = [];
    await openSemantics(page, (b) => puts.push(b), (r) => ok(r, { items: [], total: 0, page: 1, limit: 10 }));
    await page.getByTestId('sd-edit').click();
    await page.getByTestId('sd-role-add').click();
    await page.getByTestId('sd-role-column').fill('unit');
    await page.getByTestId('sd-role-kind').selectOption('duplicate_rendering');
    await page.getByTestId('sd-role-levels').fill('percentage, count');
    await page.getByTestId('sd-role-levels').blur();
    await page.getByTestId('sd-type-add').click();
    await page.getByTestId('sd-type-column').fill('cd8_pct');
    await expect(page.getByTestId('sd-text')).toHaveValue(/"columnLogicalTypes"/);
    await page.getByTestId('sd-save').click();
    await expect(page.getByTestId('sd-notice')).toHaveText('Saved as revision 1.');
    expect(puts).toEqual([{ declaration: {
      scopeRoles: [{ column: 'unit', kind: 'duplicate_rendering', levels: ['percentage', 'count'], comparableAcrossLevels: false }],
      columnLogicalTypes: { cd8_pct: 'numeric' },
    } }]);
  });
});

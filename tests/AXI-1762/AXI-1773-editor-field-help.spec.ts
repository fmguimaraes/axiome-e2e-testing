import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, request as apiRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, asList, sleep, workspaceHeader, type Api } from '../AXI-1400/harness/api';
import { ReviewWorld, send } from './AXI-1765-rule-review-fixtures';

/**
 * AXI-1773 (epic AXI-1762 — FR26, FR27, FR30, NFR7, NFR9; AC2, AC4, EC8):
 * field help in the rule parameter editor, in a REAL browser, against a REAL
 * gateway → organization-service serving the operation descriptor.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §15.
 *
 * The editor opened is the statistical one (`StatisticalRunConfigModal`) for
 * the unpaired t-test carrier. Every expectation about help TEXT is read
 * from the descriptor the gateway serves (`GET /rule-runs/operations`) in the
 * same test, never restated here: this proves the editor shows the served
 * help rather than text of its own.
 *
 * Seeding: a dedicated organization/workspace/project and a two-arm CSV that
 * is ingested and PROFILED by a real compute plane, because the editor offers
 * columns only from a ready profile. Nothing is published by seeding (AXI-1768).
 * The carrier goes through review: the admin submits it, and a SECOND platform
 * admin approves it. That approver is promoted for this file and demoted again
 * in `afterAll`, because the carrier's guidance is Claude-authored and its
 * submitter may not approve it.
 *
 * One scenario (§15.3.4) changes the served descriptor in the browser: a
 * `page.route` deletes ONE parameter's `help` from the real response. No
 * approvable operation leaves a parameter's help undeclared (the checked gate
 * refuses one), so a route is the only way to show a live editor rendering an
 * undeclared help. The route passes every other byte through.
 */

const OPERATION = 'stats.unpaired_ttest';
const FIXTURE = join(process.cwd(), 'tests', 'AXI-1762', 'fixtures', 'axi1773-two-arm.csv');
const NUMERIC_COLUMNS = ['score', 'score2'];
const PROFILE_TIMEOUT_MS = 180_000;

interface HelpBlock { label: string; what: string; why: string; example: string; valueLabels: Record<string, string> | null }
interface ParamDescriptor { key: string; type: string; required: boolean; allowedValues: string[] | null; help?: HelpBlock | null }
interface RoleDescriptor { role: string; required: boolean; help?: HelpBlock | null }
interface OperationDescriptor { operationId: string; parameters: ParamDescriptor[]; columnRoles: RoleDescriptor[] }

interface Scope { orgId: string; workspaceId: string; projectId: string; datasetId: string; analysisId: string; snapshotId: string; headers: Record<string, string> }

test.describe.configure({ mode: 'serial', timeout: 240_000 });

let api: Api;
let world: ReviewWorld | undefined;
let approverId: string | undefined;
let approverApi: APIRequestContext | undefined;
let scope: Scope;
let carrierCode: string;
let operation: OperationDescriptor;

const unique = (label: string): string => `${label} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function ok<T = any>(p: Promise<{ status: number; body: T }>, what: string): Promise<T> {
  const res = await p;
  if (res.status >= 300) throw new Error(`${what} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function servedOperation(): Promise<OperationDescriptor> {
  const body = await ok(api.get('/api/v1/rule-runs/operations'), 'GET /rule-runs/operations');
  const op = (body.operations as OperationDescriptor[]).find((o) => o.operationId === OPERATION);
  if (!op) throw new Error(`${OPERATION} is not served`);
  return op;
}

/** Walk the carrier checked -> in_review -> published through a SECOND platform admin. */
async function ensureCarrierOffered(): Promise<string> {
  const catalog = await ok(api.get('/api/v1/rules?limit=200'), 'GET /rules');
  const carrier = asList(catalog).find((r: any) => (r.tags ?? []).includes(`op:${OPERATION}`));
  if (!carrier) throw new Error(`no carrier rule for ${OPERATION}`);
  const detail = await ok(api.get(`/api/v1/rules/${carrier.id}`), 'GET carrier');
  if (detail.status === 'published') return carrier.code;
  expect(['checked', 'in_review'], `${carrier.code} must be submittable; it is ${detail.status}`).toContain(detail.status);

  world = await ReviewWorld.create();
  const role = await world.role('axi1773-approver', ['rule:read', 'rule:publish']);
  const actor = await world.actor('axi1773-approver', role);
  approverId = actor.userId;
  await send(world.admin, 'patch', `/api/v1/users/${actor.userId}`, { role: 'ADMIN' });
  const login = await apiRequest.newContext();
  const tokens = await send(login, 'post', '/api/v1/auth/login', { email: actor.email, password: 'AXI1765-e2e-pw!' });
  await login.dispose();
  approverApi = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` } });

  if (detail.status === 'checked') await send(world.admin, 'post', `/api/v1/rules/${carrier.id}/submit-for-review`);
  const inReview = await send(world.admin, 'get', `/api/v1/rules/${carrier.id}`);
  const approved = await send(approverApi, 'post', `/api/v1/rules/${carrier.id}/approve`, {
    note: 'AXI-1773 E2E: approving the unpaired t-test carrier so its editor can be opened.',
    expectedContentHash: inReview.review.contentHash,
  });
  expect(approved.status).toBe('published');
  return carrier.code;
}

async function seedScope(): Promise<Scope> {
  const org = await ok(api.post('/api/v1/organizations', { name: unique('AXI-1773 Org'), type: 'biotech' }), 'create org');
  const ws = await ok(
    api.post('/api/v1/workspaces', { name: unique('AXI-1773 WS'), description: 'AXI-1773 field help E2E', type: 'internal', ownerOrganizationId: org.id }),
    'create workspace',
  );
  const headers = workspaceHeader(ws.id);
  const project = await ok(api.post('/api/v1/projects', { name: unique('AXI-1773 Project'), workspaceId: ws.id }, headers), 'create project');

  const init = await ok(
    api.post(`/api/v1/workspaces/${ws.id}/datasets`, { organizationId: org.id, originalFilename: 'axi1773-two-arm.csv', contentType: 'text/csv' }, headers),
    'initiate dataset',
  );
  const datasetId: string = init.dataset.id;
  const put = await fetch(init.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(readFileSync(FIXTURE)) });
  if (!put.ok) throw new Error(`presigned PUT failed (${put.status})`);
  await ok(api.patch(`/api/v1/workspaces/${ws.id}/datasets/${datasetId}/finalize`, undefined, headers), 'finalize');
  await ok(api.post(`/api/v1/projects/${project.id}/datasets`, { datasetId }, headers), 'link dataset');

  // Ingested AND profiled: the editor offers columns from a ready profile only.
  const deadline = Date.now() + PROFILE_TIMEOUT_MS;
  let last = '';
  for (;;) {
    const d = await api.get(`/api/v1/workspaces/${ws.id}/datasets/${datasetId}`, headers);
    const ingestion = d.body?.latestIngestion?.status;
    if (ingestion === 'failed') throw new Error('ingestion failed');
    const profiles = asList((await api.get(`/api/v1/workspaces/${ws.id}/datasets/${datasetId}/profiles`, headers)).body);
    last = `ingestion=${ingestion} profiles=${profiles.map((p: any) => p.status).join(',')}`;
    if (ingestion === 'ready' && profiles.some((p: any) => p.status === 'ready' || p.status === 'completed')) break;
    if (profiles.some((p: any) => p.status === 'failed')) throw new Error(`profiling failed: ${last}`);
    if (Date.now() > deadline) throw new Error(`dataset not profiled in time: ${last}`);
    await sleep(2_000);
  }

  const analysis = await ok(api.post('/api/v1/view-analyses', { projectId: project.id, datasetId, name: 'AXI-1773 field help' }, headers), 'create analysis');
  const snapshot = await ok(api.post('/api/v1/view-analyses/snapshots', { viewAnalysisId: analysis.id, filters: [] }, headers), 'create snapshot');
  return { orgId: org.id, workspaceId: ws.id, projectId: project.id, datasetId, analysisId: analysis.id, snapshotId: snapshot.id, headers };
}

/**
 * The first-visit tours start on a fresh account and navigate away from the
 * page under test; mark them skipped for the admin (a no-op where they already are).
 */
const FIRST_VISIT_TOURS = ['orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets', 'evidence-decisions', 'graph-rules', 'charts-views'];

async function skipFirstVisitTours(): Promise<void> {
  for (const tourId of FIRST_VISIT_TOURS) {
    const res = await api.ctx.put(apiUrl('/api/v1/onboarding-state'), { data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 } });
    if (!res.ok()) throw new Error(`skip tour ${tourId} -> ${res.status()}: ${await res.text()}`);
  }
}

test.beforeAll(async () => {
  api = await adminApi();
  await skipFirstVisitTours();
  carrierCode = await ensureCarrierOffered();
  scope = await seedScope();
  operation = await servedOperation();
});

test.afterAll(async () => {
  await approverApi?.dispose();
  if (world && approverId) await send(world.admin, 'patch', `/api/v1/users/${approverId}`, { role: 'USER' }).catch(() => undefined);
  await api?.ctx.dispose();
});

async function openEditor(page: Page): Promise<void> {
  await page.addInitScript(
    ([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [scope.workspaceId, scope.orgId] as const,
  );
  await page.goto(`/projects/${scope.projectId}/view-analyses/${scope.analysisId}?snapshotId=${scope.snapshotId}`);
  await page.getByRole('button', { name: 'Run rule' }).click();
  await expect(page.getByRole('heading', { name: /Run relationship rule/i })).toBeVisible({ timeout: 20_000 });
  const row = page.getByRole('radio').filter({ hasText: carrierCode });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.getByRole('heading', { name: /^Configure / })).toBeVisible({ timeout: 20_000 });
  // The resolver has answered once the Measurements field offers its columns.
  const measurements = page.locator('[data-testid="rule-run-field"][data-field="role:valueColumns"]');
  await expect(measurements.getByRole('checkbox').first()).toBeVisible({ timeout: 30_000 });
}

const field = (page: Page, key: string): Locator => page.locator(`[data-testid="rule-run-field"][data-field="${key}"]`);

/** Every declared help the served descriptor carries for this editor's fields: `param:<key>` / `role:<name>`. */
function servedHelp(): Map<string, { help: HelpBlock; required: boolean }> {
  const out = new Map<string, { help: HelpBlock; required: boolean }>();
  for (const p of operation.parameters) if (p.help) out.set(`param:${p.key}`, { help: p.help, required: p.required });
  for (const r of operation.columnRoles) if (r.help) out.set(`role:${r.role}`, { help: r.help, required: r.required });
  return out;
}

const labelOf = (help: HelpBlock, required: boolean): string => (required || /\(optional\)/i.test(help.label) ? help.label : `${help.label} (optional)`);

test.describe('AXI-1773 — field help in the rule parameter editor', () => {
  test('15.3.1 AC2 FR30 NFR9 — every field shows the SERVED label, what/why and example, linked to its control @SI-030 @SI-046', async ({ page }) => {
    await openEditor(page);
    const served = servedHelp();
    const rendered = await page.locator('[data-testid="rule-run-field"][data-help="declared"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-field')));
    expect(rendered.length, 'the editor renders declared help').toBeGreaterThan(0);
    for (const key of rendered) {
      expect(served.has(key!), `${key} renders help the descriptor does not serve`).toBe(true);
    }
    // Every descriptor slot this editor shows as its own field carries its help.
    // (subject/level roles are mapping-bound and never shown; the two-group
    // test's levels are its groupFrom/groupTo parameters.)
    for (const key of ['role:groupColumn', 'role:valueColumns', 'param:groupFrom', 'param:groupTo', 'param:alternative', 'param:confidence', 'param:censoringSubstitution']) {
      if (served.has(key)) expect(rendered, `${key} shows its served help`).toContain(key);
    }

    for (const key of rendered) {
      const { help, required } = served.get(key!)!;
      const f = field(page, key!);
      await expect(f.locator(':scope > label')).toHaveText(labelOf(help, required));
      await expect(f.getByTestId('field-help-what')).toHaveText(help.what);
      await expect(f.getByTestId('field-help-why')).toHaveText(help.why);
      const helpId = await f.getByTestId('field-help-text').getAttribute('id');
      // The help describes the focusable control (or group) the label names.
      const described = f.locator(`[aria-describedby~="${helpId}"]`);
      await expect(described.first()).toBeAttached();
      // The example sits behind a keyboard-focusable button named by it.
      const example = f.getByRole('button', { name: `Example: ${help.example}` });
      await example.focus();
      await expect(example).toBeFocused();
    }

    // A select field's label names its control (getByLabel resolves it).
    const group = served.get('role:groupColumn');
    if (group) await expect(page.getByLabel(labelOf(group.help, group.required), { exact: true })).toHaveJSProperty('tagName', 'SELECT');
  });

  test('15.3.2 FR30 — enum options read by their served value labels; the submitted values are unchanged @SI-030 @SI-046', async ({ page }) => {
    await openEditor(page);
    const alternative = operation.parameters.find((p) => p.key === 'alternative')!;
    expect(alternative.help?.valueLabels, 'alternative serves value labels').toBeTruthy();
    const options = await field(page, 'param:alternative').locator('select option').evaluateAll((els) =>
      els.map((o) => [(o as HTMLOptionElement).value, o.textContent]).filter(([v]) => v),
    );
    expect(options).toEqual((alternative.allowedValues ?? []).map((v) => [v, alternative.help!.valueLabels![v] ?? v]));
  });

  test('15.3.3 FR27 AC4 — a pre-filled value keeps its origin chip beside its help; two candidate measurements stay empty with both offered @SI-030 @SI-046', async ({ page }) => {
    await openEditor(page);
    const alternative = field(page, 'param:alternative');
    await expect(alternative.getByTestId('origin-chip')).toBeVisible();
    await expect(alternative.getByTestId('origin-chip')).toHaveAttribute('data-origin', 'from_rule');
    await expect(alternative.getByTestId('field-help')).toBeVisible();

    const measurements = field(page, 'role:valueColumns');
    const boxes = measurements.getByRole('checkbox');
    await expect(boxes).toHaveCount(NUMERIC_COLUMNS.length);
    const offered = await boxes.evaluateAll((els) => els.map((e) => e.closest('label')?.textContent?.trim()));
    expect(offered.sort()).toEqual([...NUMERIC_COLUMNS].sort());
    for (const box of await boxes.all()) await expect(box).not.toBeChecked();
    await expect(measurements.getByTestId('origin-chip')).toHaveCount(0);
  });

  test('15.3.4 NFR7 — a field with NO declared help shows none: no text, no example, no describedby @SI-030 @SI-046', async ({ page }) => {
    // The operation line is not a descriptor slot: it never carries help.
    await page.route('**/api/v1/rule-runs/operations*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const op of body.operations ?? []) {
        if (op.operationId !== OPERATION) continue;
        for (const p of op.parameters) if (p.key === 'confidence') p.help = null;
      }
      await route.fulfill({ response, json: body });
    });
    await openEditor(page);
    const operationField = field(page, 'operation');
    await expect(operationField).toHaveAttribute('data-help', 'none');
    await expect(operationField.getByTestId('field-help')).toHaveCount(0);

    const confidence = field(page, 'param:confidence');
    await expect(confidence).toHaveAttribute('data-help', 'none');
    await expect(confidence.getByTestId('field-help')).toHaveCount(0);
    await expect(confidence.getByRole('button', { name: /^Example:/ })).toHaveCount(0);
    await expect(confidence.locator(':scope > label')).toHaveText('confidence (optional)');
    await expect(confidence.locator('input')).not.toHaveAttribute('aria-describedby', /.+/);
    // Its neighbours still show theirs.
    await expect(field(page, 'param:alternative').getByTestId('field-help')).toBeVisible();
  });

  test('15.3.5 EC8 FR27 — a value the project LOCKED is not editable, shows its lock chip, and keeps its help @SI-030 @SI-046', async ({ page }) => {
    await ok(
      api.post(`/api/v1/workspaces/${scope.workspaceId}/analysis-policy`, { entries: { [OPERATION]: { alternative: { value: 'greater', locked: true } } } }, scope.headers),
      'author analysis policy',
    );
    await openEditor(page);
    const alternative = field(page, 'param:alternative');
    const select = alternative.locator('select');
    await expect(select).toHaveValue('greater', { timeout: 20_000 });
    await expect(select).toBeDisabled();
    await expect(alternative.getByTestId('origin-chip')).toHaveAttribute('data-origin', 'locked_by_project');
    await expect(alternative.getByTestId('field-help-what')).toHaveText(operation.parameters.find((p) => p.key === 'alternative')!.help!.what);
  });
});

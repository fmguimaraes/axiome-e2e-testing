import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, request as apiRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, asList, workspaceHeader, type Api } from '../AXI-1400/harness/api';
import { ReviewWorld, send, type Actor } from './AXI-1765-rule-review-fixtures';
import { systemRuleCatalogue } from './seeded-rule-approval';

/**
 * AXI-1882 (epic AXI-1762 — FR32, NFR7, NFR9; AC15): the rule-run editor's help
 * ANCHOR, in a REAL browser against a REAL gateway.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §32 (32.3.1–32.3.4).
 *
 * Three things are pinned here, each of which a unit test can only pin against a
 * prop:
 * 1. a field that HAS declared help offers exactly one editor-help anchor, and it
 *    resolves to the real article the corpus serves (`rules.run.editor` is declared
 *    by `choosing-values-in-a-rule-run-editor` only) — 32.3.1;
 * 2. a field with NO declared help offers none, so the identical link name is not
 *    repeated on every field and adds no tab stop — 32.3.2;
 * 3. the anchor's article carries the Stratify grouping section AXI-1882 added, and
 *    it states that the configuration offers no clustering — 32.3.3;
 * 4. a user without `help:view` sees no anchor anywhere on these surfaces, because
 *    `/help` would refuse them — 32.3.4.
 *
 * Editor under test: the unpaired t-test carrier's statistical editor, the same
 * surface AXI-1773 drives — the anchor rule lives in the shared `RuleRunField`
 * frame and is decided per FIELD (declared help or not), never per rule kind, so
 * the carrier that opens the frame is immaterial. Only the ARTICLE assertion is
 * Stratify-specific, and that is read from the served corpus (32.3.3).
 *
 * Seeding mirrors AXI-1773: a dedicated organization/workspace/project and a
 * two-arm CSV ingested AND profiled by a real compute plane, because the editor
 * offers columns only from a ready profile. Nothing is published by seeding
 * (AXI-1768); the carrier is walked through review by a SECOND platform admin
 * because its guidance is Claude-authored and a submitter may not approve it.
 *
 * 32.3.2 deletes ONE parameter's `help` from the real `GET /rule-runs/operations`
 * response with a `page.route`. No approvable operation leaves a parameter's help
 * undeclared (the FR9 checked gate refuses one), so a route is the only way to put
 * a help-less field in a live editor. Every other byte passes through.
 */

const OPERATION = 'stats.unpaired_ttest';
const FIXTURE = join(process.cwd(), 'tests', 'AXI-1762', 'fixtures', 'axi1773-two-arm.csv');
const PROFILE_TIMEOUT_MS = 180_000;
const EDITOR_HELP_KEY = 'rules.run.editor';
const EDITOR_ANCHOR_NAME = 'Help — the fields of a rule run';
const EDITOR_ARTICLE = '/help/analysis/choosing-values-in-a-rule-run-editor';
const ACTOR_PASSWORD = 'AXI1765-e2e-pw!';

interface HelpBlock { label: string; what: string; why: string; example: string; valueLabels: Record<string, string> | null }
interface ParamDescriptor { key: string; type: string; required: boolean; allowedValues: string[] | null; help?: HelpBlock | null }
interface RoleDescriptor { role: string; required: boolean; help?: HelpBlock | null }
interface OperationDescriptor { operationId: string; parameters: ParamDescriptor[]; columnRoles: RoleDescriptor[] }

interface Scope { orgId: string; workspaceId: string; projectId: string; analysisId: string; snapshotId: string; headers: Record<string, string> }

test.describe.configure({ mode: 'serial', timeout: 240_000 });

let api: Api;
let world: ReviewWorld | undefined;
let approverId: string | undefined;
let approverApi: APIRequestContext | undefined;
let scope: Scope;
let carrierCode: string;
let operation: OperationDescriptor;
/** A workspace member who holds rule:read but NOT help:view (32.3.4). */
let noHelpActor: Actor | undefined;

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
  const catalog = await systemRuleCatalogue((path) => ok(api.get(path), 'GET /rules'));
  const carrier = catalog.find((r) => (r.tags ?? []).includes(`op:${OPERATION}`));
  if (!carrier) throw new Error(`no carrier rule for ${OPERATION}`);
  const detail = await ok(api.get(`/api/v1/rules/${carrier.id}`), 'GET carrier');
  if (detail.status === 'published') return carrier.code;
  expect(['checked', 'in_review'], `${carrier.code} must be submittable; it is ${detail.status}`).toContain(detail.status);

  world = await ReviewWorld.create();
  const role = await world.role('axi1882-approver', ['rule:read', 'rule:publish']);
  const actor = await world.actor('axi1882-approver', role);
  approverId = actor.userId;
  await send(world.admin, 'patch', `/api/v1/users/${actor.userId}`, { role: 'ADMIN' });
  const login = await apiRequest.newContext();
  const tokens = await send(login, 'post', '/api/v1/auth/login', { email: actor.email, password: ACTOR_PASSWORD });
  await login.dispose();
  approverApi = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` } });

  if (detail.status === 'checked') await send(world.admin, 'post', `/api/v1/rules/${carrier.id}/submit-for-review`);
  const inReview = await send(world.admin, 'get', `/api/v1/rules/${carrier.id}`);
  const approved = await send(approverApi, 'post', `/api/v1/rules/${carrier.id}/approve`, {
    note: 'AXI-1882 E2E: approving the unpaired t-test carrier so its editor can be opened.',
    expectedContentHash: inReview.review.contentHash,
  });
  expect(approved.status).toBe('published');
  return carrier.code;
}

async function seedScope(): Promise<Scope> {
  const org = await ok(api.post('/api/v1/organizations', { name: unique('AXI-1882 Org'), type: 'biotech' }), 'create org');
  const ws = await ok(
    api.post('/api/v1/workspaces', { name: unique('AXI-1882 WS'), description: 'AXI-1882 help anchor E2E', type: 'internal', ownerOrganizationId: org.id }),
    'create workspace',
  );
  const headers = workspaceHeader(ws.id);
  const project = await ok(api.post('/api/v1/projects', { name: unique('AXI-1882 Project'), workspaceId: ws.id }, headers), 'create project');
  const datasetId = await seedProfiledDataset(ws.id, org.id, project.id, headers);

  const analysis = await ok(api.post('/api/v1/view-analyses', { projectId: project.id, datasetId, name: 'AXI-1882 help anchor' }, headers), 'create analysis');
  const snapshot = await ok(api.post('/api/v1/view-analyses/snapshots', { viewAnalysisId: analysis.id, filters: [] }, headers), 'create snapshot');
  return { orgId: org.id, workspaceId: ws.id, projectId: project.id, analysisId: analysis.id, snapshotId: snapshot.id, headers };
}

async function seedProfiledDataset(wsId: string, orgId: string, projectId: string, headers: Record<string, string>): Promise<string> {
  const init = await ok(
    api.post(`/api/v1/workspaces/${wsId}/datasets`, { organizationId: orgId, originalFilename: 'axi1882-two-arm.csv', contentType: 'text/csv' }, headers),
    'initiate dataset',
  );
  const datasetId: string = init.dataset.id;
  const put = await fetch(init.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(readFileSync(FIXTURE)) });
  if (!put.ok) throw new Error(`presigned PUT failed (${put.status})`);
  await ok(api.patch(`/api/v1/workspaces/${wsId}/datasets/${datasetId}/finalize`, undefined, headers), 'finalize');
  await ok(api.post(`/api/v1/projects/${projectId}/datasets`, { datasetId }, headers), 'link dataset');
  await waitForProfile(wsId, datasetId, headers);
  return datasetId;
}

/**
 * The editor offers columns from a READY profile only, so seeding waits for one.
 * `expect.poll` rather than a fixed-duration wait (NFR4): the timeout message carries
 * the last ingestion/profile statuses, so a stuck compute plane is named.
 */
async function waitForProfile(wsId: string, datasetId: string, headers: Record<string, string>): Promise<void> {
  await expect
    .poll(async () => {
      const d = await api.get(`/api/v1/workspaces/${wsId}/datasets/${datasetId}`, headers);
      const ingestion = d.body?.latestIngestion?.status;
      const profiles = asList((await api.get(`/api/v1/workspaces/${wsId}/datasets/${datasetId}/profiles`, headers)).body);
      if (ingestion === 'failed' || profiles.some((p: any) => p.status === 'failed')) return 'failed';
      const ready = ingestion === 'ready' && profiles.some((p: any) => p.status === 'ready' || p.status === 'completed');
      return ready ? 'ready' : `ingestion=${ingestion} profiles=${profiles.map((p: any) => p.status).join(',')}`;
    }, { message: 'dataset ingested and profiled', timeout: PROFILE_TIMEOUT_MS, intervals: [2_000] })
    .toBe('ready');
}

/**
 * The first-visit tours navigate away from the page under test; mark them skipped
 * (a no-op where they already are). `ctx` is the session whose state is written.
 */
const TOUR_IDS = [
  'orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets', 'evidence-decisions',
  'graph-rules', 'help', 'admin', 'charts-views', 'collaboration',
];

async function skipTours(ctx: APIRequestContext): Promise<void> {
  for (const tourId of TOUR_IDS) {
    const res = await ctx.put(apiUrl('/api/v1/onboarding-state'), { data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 } });
    if (!res.ok()) throw new Error(`skip tour ${tourId} -> ${res.status()}: ${await res.text()}`);
  }
}

/**
 * A throwaway workspace member who can open the editor but holds no `help:view`
 * (32.3.4). The permissions are the editor's, minus help: a reader of rules with
 * workspace membership on the seeded scope.
 */
async function seedNoHelpActor(): Promise<Actor> {
  world = world ?? (await ReviewWorld.create());
  // Exactly what the editor needs — the analysis view, the rule catalogue and the
  // run — and NOT `help:view`, so the only reason an anchor could be missing is
  // the AXI-1823 gate the anchor consults.
  const role = await world.role('axi1882-no-help', ['view-analysis:view', 'rule:read', 'rule:view_shared', 'rule:evaluate']);
  const actor = await world.actor('axi1882-no-help', role);
  await send(world.admin, 'post', `/api/v1/workspaces/${scope.workspaceId}/members`, {
    userId: actor.userId,
    organizationId: scope.orgId,
    role: 'admin',
  });
  return actor;
}

test.beforeAll(async () => {
  api = await adminApi();
  await skipTours(api.ctx);
  carrierCode = await ensureCarrierOffered();
  scope = await seedScope();
  operation = await servedOperation();
});

test.afterAll(async () => {
  await approverApi?.dispose();
  if (world && approverId) await send(world.admin, 'patch', `/api/v1/users/${approverId}`, { role: 'USER' }).catch(() => undefined);
  await world?.dispose().catch(() => undefined);
  await api?.ctx.dispose();
});

/** Seed `page` with `actor`'s own session (the app reads the tokens from localStorage). */
async function signIn(page: Page, actor: Actor): Promise<void> {
  const login = await apiRequest.newContext();
  const tokens = await send(login, 'post', '/api/v1/auth/login', { email: actor.email, password: ACTOR_PASSWORD });
  await login.dispose();
  const ctx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` } });
  await skipTours(ctx);
  await ctx.dispose();
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('access_token', access as string);
      localStorage.setItem('refresh_token', refresh as string);
    },
    [tokens.accessToken, tokens.refreshToken] as const,
  );
}

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
  // The demo catalogue carries several carriers for this operation (seed leftovers),
  // and any of them opens the same `RuleRunField` frame — the anchor rule under test
  // is per FIELD, not per rule — so the first offered row is taken.
  const row = page.getByRole('radio').filter({ hasText: carrierCode }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  // AXI-1772 (FR28): the click opens the DETAIL PANE; the editor is one step further.
  await page.getByTestId('rule-detail-pane').getByRole('button', { name: 'Adjust parameters' }).click();
  await expect(page.getByRole('heading', { name: /^Configure / })).toBeVisible({ timeout: 20_000 });
  // The resolver has answered once the Measurements field offers its columns.
  const measurements = page.locator('[data-testid="rule-run-field"][data-field="role:valueColumns"]');
  await expect(measurements.getByRole('checkbox').first()).toBeVisible({ timeout: 30_000 });
}

const field = (page: Page, key: string): Locator => page.locator(`[data-testid="rule-run-field"][data-field="${key}"]`);
const declaredFields = (page: Page): Locator => page.locator('[data-testid="rule-run-field"][data-help="declared"]');
const helplessFields = (page: Page): Locator => page.locator('[data-testid="rule-run-field"][data-help="none"]');
const editorAnchors = (page: Page): Locator => page.locator(`[data-help-anchor="${EDITOR_HELP_KEY}"]`);

test.describe('AXI-1882 — the rule-run editor help anchor', () => {
  test('FR32 AC15 NFR9 (§32.3.1) — a field with declared help offers ONE editor-help anchor, resolving to the served article @SI-037', async ({ page }) => {
    await openEditor(page);
    const declared = declaredFields(page);
    const declaredCount = await declared.count();
    expect(declaredCount, 'the editor renders fields with declared help').toBeGreaterThan(0);

    // One anchor per declared field, and no more anywhere in the editor: the anchor
    // count IS the declared-help count (32.3.2 pins the other direction).
    await expect(editorAnchors(page)).toHaveCount(declaredCount);

    for (const f of await declared.all()) {
      const anchor = f.locator(`[data-help-anchor="${EDITOR_HELP_KEY}"]`);
      await expect(anchor).toHaveCount(1);
      await expect(anchor).toHaveAttribute('aria-label', EDITOR_ANCHOR_NAME);
      // It resolves to the ONE declaring article, not the browse root (a dead end).
      await expect(anchor).toHaveAttribute('href', new RegExp(`${EDITOR_ARTICLE}$`));
      // The anchor sits OUTSIDE the label, so the label still names only its control.
      await expect(f.locator(':scope > label').locator(`[data-help-anchor="${EDITOR_HELP_KEY}"]`)).toHaveCount(0);
      // The field keeps its what/why line: the anchor is in addition to it, not instead.
      await expect(f.getByTestId('field-help-what')).not.toBeEmpty();
      // Keyboard reachable.
      await anchor.focus();
      await expect(anchor).toBeFocused();
    }
  });

  test('FR32 NFR7 (§32.3.2) — a field with NO declared help offers no anchor, and its neighbours keep theirs @SI-037', async ({ page }) => {
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

    const confidence = field(page, 'param:confidence');
    await expect(confidence).toHaveAttribute('data-help', 'none');
    await expect(confidence.locator(`[data-help-anchor="${EDITOR_HELP_KEY}"]`)).toHaveCount(0);
    // The field itself still renders — the anchor is withheld, never the field.
    await expect(confidence.locator('input')).toBeVisible();

    // The operation line is not a descriptor slot: it never carries help, so never an anchor.
    const operationField = field(page, 'operation');
    await expect(operationField).toHaveAttribute('data-help', 'none');
    await expect(operationField.locator(`[data-help-anchor="${EDITOR_HELP_KEY}"]`)).toHaveCount(0);

    // No help-less field anywhere in this editor carries one, and every declared one does:
    // the anchor count equals the declared count, so the identical link name is not
    // repeated on fields that have nothing to explain.
    for (const f of await helplessFields(page).all()) {
      await expect(f.locator(`[data-help-anchor="${EDITOR_HELP_KEY}"]`)).toHaveCount(0);
    }
    await expect(editorAnchors(page)).toHaveCount(await declaredFields(page).count());

    // A neighbour that DOES declare help still shows both its line and its anchor.
    const alternative = field(page, 'param:alternative');
    await expect(alternative.getByTestId('field-help')).toBeVisible();
    await expect(alternative.locator(`[data-help-anchor="${EDITOR_HELP_KEY}"]`)).toHaveCount(1);
  });

  test('FR32 (§32.3.3) — the anchor opens the article, whose Stratify section explains predefined grouping and states no clustering @SI-037', async ({ page }) => {
    await openEditor(page);
    await declaredFields(page).first().locator(`[data-help-anchor="${EDITOR_HELP_KEY}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${EDITOR_ARTICLE}$`));
    await expect(page.getByRole('heading', { name: "Choosing values in a rule's run editor" }).first()).toBeVisible({ timeout: 20_000 });

    // The section AXI-1882 added, read from the SERVED corpus.
    await expect(page.getByRole('heading', { name: 'Stratify runs: the groups are the ones you declare' })).toBeVisible();
    const article = page.getByRole('main');
    // Each categorical value becomes its own group.
    await expect(article).toContainText('Each value you select becomes its own group');
    // A numeric bucket needs a unique label and an inclusive or exclusive side.
    await expect(article).toContainText('Each bucket needs a unique label');
    await expect(article).toContainText('an inclusive or an exclusive side');
    await expect(article).toContainText('Two buckets cannot share a label');
    // And the configuration offers NO clustering.
    await expect(article).toContainText('does not offer clustering');
  });

  test('AC15 FR32 (§32.3.4) — a user without help:view sees no help anchor on the editor, the rule page or the top bar @SI-037', async ({ page }) => {
    noHelpActor = await seedNoHelpActor();
    await signIn(page, noHelpActor);
    await openEditor(page);

    // The editor really rendered for this actor (so the zero-anchor assertions below
    // are about a withheld anchor, not about a page that failed to load).
    expect(await declaredFields(page).count(), 'the editor rendered fields with declared help').toBeGreaterThan(0);
    await expect(declaredFields(page).first().getByTestId('field-help-what')).not.toBeEmpty();
    // ...and not one anchor, of any context key, is offered.
    await expect(editorAnchors(page)).toHaveCount(0);
    await expect(page.locator('[data-help-anchor]')).toHaveCount(0);

    // Nor on the rule pages, nor the top bar.
    await page.goto('/rules');
    await expect(page.getByRole('heading', { name: /Rules/ }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-help-anchor]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^Help$/ })).toHaveCount(0);
  });
});

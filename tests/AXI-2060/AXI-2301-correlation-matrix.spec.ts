import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ReviewWorld, send, type Actor } from '../AXI-1762/AXI-1765-rule-review-fixtures';

/**
 * AXI-2301 (epic AXI-2060): `stats.correlation_matrix` — ONE rule run computes
 * every reference x variable correlation, BH-adjusted per declared family, and
 * its long result table drives the annotated heatmap with no manual CSV.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2301 (S1–S6). Tags: @SI-017 @SI-021 @SI-018 @SI-033 @SI-035.
 *
 * Self-isolating:
 *  - the rule is a WORKSPACE CLONE of the seeded carrier `STAT-CORRELATION-MATRIX`,
 *    submitted by the admin and approved by a throwaway second approver (a
 *    self-registered user with a throwaway `rule:publish` role, a member of the
 *    workspace only for this file). The seeded system carrier is never submitted
 *    or approved — its guidance is Claude-authored and nobody here may sign it.
 *  - every run reads a THROWAWAY analysis (`[e2e AXI-2301 throwaway]`) in the
 *    synthetic reproduction project 22585add over final_tableau2_synthetic.csv.
 *    Snapshot v1 has no filters, which is exactly A4 Snapshot v1's slice.
 *  - two identities: the demo workspace owner (`E2E_DEMO_EMAIL`, default
 *    admin@cro-one.com) authors the clone and the runs; the platform admin
 *    (`E2E_ADMIN_EMAIL`, the e2e suite's own admin) only creates the throwaway
 *    approver role, as `POST /roles` requires.
 *  - afterAll soft-deletes the clone, removes the approver from the workspace and
 *    deletes its role. Analyses with governed runs are not deletable (EC3) and stay.
 *
 * The AC1 oracle is the 42 recorded A4 `stats.correlation` runs plus the 7
 * per-reference `correlation-family-adjust` calls (fixture copied verbatim from
 * axiome-bio-compute `tests/fixtures/correlation_matrix/`).
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_ID = '22585add-60ab-4d8e-a8ff-0f1071862553';
const DATASET_ID = 'f93231f3-20e7-445c-b0b3-8d767444ecb3';
const OPERATION = 'stats.correlation_matrix';
const CARRIER_CODE = 'STAT-CORRELATION-MATRIX';
const THROWAWAY = '[e2e AXI-2301 throwaway]';
const TOLERANCE = 1e-9;

interface Cell {
  reference: string;
  variable: string;
  rho: number | null;
  pValue: number | null;
  qValue: number | null;
  significance: string;
  n: number;
  reason?: string | null;
}
interface Oracle {
  references: { label: string; column: string }[];
  variables: { label: string; column: string }[];
  cells: Cell[];
  starred: { reference: string; variable: string }[];
}

const ORACLE: Oracle = JSON.parse(
  readFileSync(join(process.cwd(), 'tests', 'AXI-2060', 'fixtures', 'axi2301-a4-snapshot-v1-per-pair-runs.json'), 'utf8'),
);
const REFERENCES = ORACLE.references.map((r) => r.column);
const VARIABLES = ORACLE.variables.map((v) => v.column);

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
let world: ReviewWorld;
let approver: Actor;
let approverRoleId = '';
let cloneId = '';
let cloneCode = '';
let analysisId = '';
let snapshotId = '';
let matrixRun: { id: string; table: Cell[]; resultDatasetId: string };

const key = (c: { reference: string; variable: string }) => `${c.reference}|${c.variable}`;

async function ok<T = any>(label: string, res: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.ok(), `${label}: ${r.status()} ${text}`).toBeTruthy();
  return (text ? JSON.parse(text) : {}) as T;
}

async function createSnapshot(filters: unknown[], name: string): Promise<string> {
  const snapshot = await ok<{ id: string }>('snapshot', api.post(apiUrl('/api/v1/view-analyses/snapshots'), {
    data: { viewAnalysisId: analysisId, filters, name },
  }));
  return snapshot.id;
}

/** POST /rule-runs on the clone and wait for a terminal status; returns the canonical run. */
async function runMatrix(
  snapshot: string,
  filters: unknown[],
  variables: string[],
  operationParams: Record<string, unknown> = { method: 'spearman', familyScope: 'per_reference' },
): Promise<{ id: string; run: any }> {
  const created = await ok<{ ruleRunId: string }>('rule run', api.post(apiUrl('/api/v1/rule-runs'), {
    data: {
      ruleId: cloneId, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, datasetId: DATASET_ID,
      snapshotId: snapshot, viewAnalysisId: analysisId, runKind: 'STATISTICAL', operationId: OPERATION,
      scope: filters.length ? 'FILTERED' : 'FULL', filters, operationParams,
      roleBindings: { referenceColumns: REFERENCES, variableColumns: variables },
    },
  }));
  let run: any = { status: 'QUEUED' };
  await expect.poll(async () => {
    run = await ok('get rule run', api.get(apiUrl(`/api/v1/rule-runs/${created.ruleRunId}`)));
    return run.status;
  }, { timeout: 120_000, intervals: [1000] }).toMatch(/^(SUCCEEDED|DEDUPED|FAILED)$/);
  // AC3: a cell that cannot be computed is a row with a reason, never a failed run.
  expect(run.status, JSON.stringify(run)).not.toBe('FAILED');
  const id = run.status === 'DEDUPED' ? (run.dedupedFromRunId as string) : created.ruleRunId;
  if (id !== created.ruleRunId) run = await ok('get canonical run', api.get(apiUrl(`/api/v1/rule-runs/${id}`)));
  return { id, run };
}

async function resultTable(runId: string): Promise<Cell[]> {
  const body = await ok<{ rows: Cell[]; totalRows?: number }>('result table', api.get(apiUrl(`/api/v1/rule-runs/${runId}/table?limit=500`)));
  return body.rows;
}

/** The run's result dataset: the `rule_derived` snapshot it materialized in the analysis. */
async function resultDatasetOf(runId: string): Promise<string> {
  let datasetId: string | undefined;
  await expect.poll(async () => {
    const body = await ok<any>('snapshots', api.get(apiUrl(`/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=100`)));
    const list: any[] = Array.isArray(body) ? body : body.data ?? body.items ?? [];
    datasetId = list.find((snap) => snap.origin === 'rule_derived' && snap.ruleRunId === runId)?.datasetId;
    return datasetId ?? null;
  }, { timeout: 60_000, intervals: [1000], message: `run ${runId} materialized a rule_derived snapshot` }).not.toBeNull();
  return datasetId!;
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

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('AXI-2301 - correlation matrix: one run, every reference x variable cell, annotated heatmap', {
  tag: ['@SI-017', '@SI-021', '@SI-018', '@SI-033', '@SI-035'],
}, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    test.setTimeout(360_000);
    const login = await apiRequest.newContext();
    const res = await login.post(apiUrl('/api/v1/auth/login'), {
      data: { email: process.env.E2E_DEMO_EMAIL?.trim() || 'admin@cro-one.com', password: process.env.E2E_DEMO_PASSWORD?.trim() || 'admin' },
    });
    expect(res.ok()).toBeTruthy();
    ({ accessToken, refreshToken } = await res.json());
    await login.dispose();
    api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } });

    // The seeded carrier — read only. Its clone is the rule this file runs.
    const catalogue = await ok<{ data: { id: string; code: string; tags?: string[]; scope: string }[] }>(
      'catalogue', api.get(apiUrl(`/api/v1/rules?scope=system&search=${CARRIER_CODE}&limit=50`)));
    const carrier = catalogue.data.find((r) => r.code === CARRIER_CODE && r.scope === 'system');
    expect(carrier, `${CARRIER_CODE} is seeded (it is ${OPERATION}'s carrier)`).toBeDefined();
    expect(carrier!.tags ?? []).toContain(`op:${OPERATION}`);

    world = await ReviewWorld.create();
    approverRoleId = await world.role('axi2301-approver', ['rule:read', 'rule:publish']);
    approver = await world.actor('axi2301-approver', approverRoleId);
    await send(world.admin, 'post', `/api/v1/workspaces/${WORKSPACE_ID}/members`, {
      userId: approver.userId, organizationId: ORGANIZATION_ID, role: 'admin',
    });

    const clone = await send(api, 'post', `/api/v1/rules/${carrier!.id}/clone`, {
      targetScope: 'workspace', targetWorkspaceId: WORKSPACE_ID,
    });
    cloneId = clone.id;
    cloneCode = clone.code;
    // The clone KEEPS its `op:` tag: that tag is what binds the run modal to the
    // operation (without it the modal falls back to a generic operation picker).
    // Sibling specs resolve carriers from the SYSTEM catalogue only (AXI-1809), so a
    // workspace clone cannot shadow the carrier, and afterAll deletes it.
    expect(clone.tags ?? []).toContain(`op:${OPERATION}`);
    await send(api, 'post', `/api/v1/rules/${cloneId}/submit-for-review`);
    const inReview = await send(approver.api, 'get', `/api/v1/rules/${cloneId}`);
    expect(inReview.review?.canApprove, JSON.stringify(inReview.review)).toBe(true);
    const approved = await send(approver.api, 'post', `/api/v1/rules/${cloneId}/approve`, {
      note: 'AXI-2301 E2E: approving a throwaway workspace clone of the correlation-matrix carrier.',
      expectedContentHash: inReview.review.contentHash,
    });
    expect(approved.status).toBe('published');

    // The synthetic dataset is linked to the protected reference project; link it to the
    // throwaway project too (idempotent: an existing link answers 409 / 400 "already linked").
    const linked = await api.post(apiUrl(`/api/v1/projects/${PROJECT_ID}/datasets`), { data: { datasetId: DATASET_ID } });
    expect(linked.ok() || [400, 409].includes(linked.status()), `link dataset: ${linked.status()} ${await linked.text()}`).toBeTruthy();

    const analysis = await ok<{ id: string }>('analysis', api.post(apiUrl('/api/v1/view-analyses'), {
      data: { projectId: PROJECT_ID, datasetId: DATASET_ID, name: `${THROWAWAY} matrix ${new Date().toISOString()}` },
    }));
    analysisId = analysis.id;
    snapshotId = await createSnapshot([], 'v1 — no filters (A4 Snapshot v1 slice)');

    const { id } = await runMatrix(snapshotId, [], VARIABLES);
    matrixRun = { id, table: await resultTable(id), resultDatasetId: await resultDatasetOf(id) };
  });

  test.afterAll(async () => {
    if (world) {
      if (cloneId) await world.admin.delete(apiUrl(`/api/v1/rules/${cloneId}`)).catch(() => undefined);
      if (approver) {
        await world.admin.delete(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/members/${approver.userId}`)).catch(() => undefined);
        // An assigned role cannot be deleted, so revoke it before dispose() deletes it.
        await world.revoke(approver.userId, approverRoleId).catch(() => undefined);
      }
      await world.dispose();
    }
    await api?.dispose();
  });

  test('AC1 - S1: one 7 x 6 Spearman per-reference run equals the 42 per-pair runs (1e-9) and stars 15/42 exactly', async () => {
    const rows = matrixRun.table;
    expect(rows).toHaveLength(42);
    const byKey = new Map(rows.map((r) => [key(r), r]));
    for (const expected of ORACLE.cells) {
      const got = byKey.get(key(expected));
      expect(got, `cell ${key(expected)}`).toBeDefined();
      for (const field of ['rho', 'pValue', 'qValue'] as const) {
        expect(Math.abs(Number(got![field]) - (expected[field] as number)), `${key(expected)} ${field}`).toBeLessThanOrEqual(TOLERANCE);
      }
      expect(got!.significance, key(expected)).toBe(expected.significance);
      expect(Number(got!.n), key(expected)).toBe(expected.n);
      expect(got!.reason ?? null).toBeNull();
    }
    const starred = rows.filter((r) => r.significance === 'after_correction').map(key).sort();
    expect(starred).toEqual(ORACLE.starred.map(key).sort());
    expect(starred).toHaveLength(15);
  });

  test('AC2 - S2: the result dataset\'s recommended chart is heatmap_annotated_v1 bound x/y/z/mark with the declared star and scale', async () => {
    const list = await ok<any>('candidates', api.get(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${matrixRun.resultDatasetId}/candidates`)));
    const specs: any[] = Array.isArray(list) ? list : list.data ?? list.items ?? list.candidates ?? [];
    const recommended = specs.filter((s) => s.origin === 'recommended');
    expect(recommended.map((s) => s.templateId), JSON.stringify(specs.map((s) => [s.origin, s.templateId]))).toEqual(['heatmap_annotated_v1']);
    const spec = recommended[0];
    const bound = (slot: string) => {
      const b = spec.bindings?.[slot];
      return typeof b === 'string' ? b : b?.column_id;
    };
    expect({ x: bound('x'), y: bound('y'), z: bound('z'), mark: bound('mark') }).toEqual({
      x: 'col_reference', y: 'col_variable', z: 'col_rho', mark: 'col_significance',
    });
    expect(spec.params).toMatchObject({
      mark_values: { after_correction: '*' }, colorscale: 'RdBu', z_min: -1, z_max: 1,
    });
  });

  test('AC2 - S3: the recommended heatmap renders 7 x 6 cells, exactly 15 starred, with no manual table', async ({ page }) => {
    const list = await ok<any>('candidates', api.get(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${matrixRun.resultDatasetId}/candidates`)));
    const specs: any[] = Array.isArray(list) ? list : list.data ?? list.items ?? list.candidates ?? [];
    const spec = specs.find((s) => s.origin === 'recommended' && s.templateId === 'heatmap_annotated_v1');
    expect(spec).toBeDefined();
    await signIn(page);
    await page.goto(`/datasets/${matrixRun.resultDatasetId}/chart/${spec.id}`);
    const labels = page.locator('.js-plotly-plot .annotation-text');
    await expect(labels.first()).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => labels.count(), { timeout: 30_000 }).toBe(42);
    const texts = (await labels.allTextContents()).map((t) => t.trim());
    expect(texts.filter((t) => t.endsWith('*')), texts.join(' | ')).toHaveLength(15);
  });

  test('AC3 - S4: a non-numeric variable is a per-cell reason in a SUCCEEDED run, and the other 42 cells do not move', async () => {
    const { id } = await runMatrix(snapshotId, [], [...VARIABLES, 'sexe']);
    const rows = await resultTable(id);
    expect(rows).toHaveLength(49);
    const sexe = rows.filter((r) => r.variable === 'sexe');
    expect(sexe).toHaveLength(7);
    for (const cell of sexe) {
      expect(cell).toMatchObject({ rho: null, pValue: null, qValue: null, significance: 'undefined', reason: 'non-numeric column: sexe' });
    }
    // An excluded member never enters its family, so the 42 numeric cells are byte-identical.
    const base = new Map(matrixRun.table.map((r) => [key(r), r]));
    for (const cell of rows.filter((r) => r.variable !== 'sexe')) {
      const before = base.get(key(cell))!;
      expect(cell.qValue, key(cell)).toBe(before.qValue);
      expect(cell.significance, key(cell)).toBe(before.significance);
    }
  });

  test('AC3 - S5: fewer than 3 complete pairs is a per-cell reason in a SUCCEEDED run, never a failed run', async () => {
    const filters = [{ column: 'patient_id', operator: 'in', value: ['MAG4 1', 'MAG4 2'] }];
    const slice = await createSnapshot(filters, 'two patients');
    const { id } = await runMatrix(slice, filters, VARIABLES);
    const rows = await resultTable(id);
    expect(rows).toHaveLength(42);
    for (const cell of rows) {
      expect(cell.rho, key(cell)).toBeNull();
      expect(cell.significance, key(cell)).toBe('undefined');
      expect(Number(cell.n), key(cell)).toBeLessThanOrEqual(2);
      expect(cell.reason ?? '', key(cell)).toMatch(/^insufficient complete pairs: [0-2] \(at least 3 required\)$/);
    }
  });

  test('S6: the run modal offers the clone with two labelled multi-select roles and the four parameters', async ({ page }) => {
    const ops = await ok<{ operations: { operationId: string; columnRoles: { role: string; help?: { label: string } | null }[]; parameters: { key: string }[] }[] }>(
      'operations', api.get(apiUrl('/api/v1/rule-runs/operations')));
    const op = ops.operations.find((o) => o.operationId === OPERATION);
    expect(op, `${OPERATION} is served`).toBeDefined();
    await signIn(page);
    await page.goto(`/projects/${PROJECT_ID}/view-analyses/${analysisId}?snapshotId=${snapshotId}`);
    await page.getByRole('button', { name: 'Run rule' }).click();
    await expect(page.getByRole('heading', { name: /Run relationship rule/i })).toBeVisible({ timeout: 30_000 });
    const row = page.getByRole('radio').filter({ hasText: cloneCode });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await page.getByTestId('rule-detail-pane').getByRole('button', { name: 'Adjust parameters' }).click();
    await expect(page.getByRole('heading', { name: /^Configure / })).toBeVisible({ timeout: 20_000 });

    const field = (k: string) => page.locator(`[data-testid="rule-run-field"][data-field="${k}"]`);
    for (const role of ['referenceColumns', 'variableColumns']) {
      const served = op!.columnRoles.find((r) => r.role === role);
      expect(served?.help?.label, `${role} declares a label`).toBeTruthy();
      const frame = field(`role:${role}`);
      await expect(frame.locator(':scope > label')).toContainText(served!.help!.label);
      // A multi-select: the role offers a checklist of the dataset's columns.
      await expect.poll(async () => frame.getByRole('checkbox').count(), { timeout: 30_000 }).toBeGreaterThan(1);
    }
    expect(op!.columnRoles.map((r) => r.help?.label)).toEqual(['References', 'Variables']);
    for (const p of op!.parameters) await expect(field(`param:${p.key}`)).toBeVisible();
    expect(op!.parameters.map((p) => p.key).sort()).toEqual(['alpha', 'alternative', 'familyScope', 'method']);
  });
});

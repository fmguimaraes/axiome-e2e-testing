import { APIResponse, expect, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld, uploadCsvDataset } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2340 (epic AXI-2308 — FR3, FR35, AC3, EC18) — a Reviewer (Sponsor Viewer)
 * is refused server-side on upload, run, style change and delete; the read
 * surface (answer, charts, evidence, report download) stays open.
 *
 * Origin: a design-time sweep (the AXI-2353/AXI-2354 IDOR-fix pattern and the
 * AXI-2323/AXI-2324 Investigator-deny pattern) found `CandidatesProxyController`'s
 * seven chart-spec write routes carried `WorkspaceRoleGuard` in the guard chain
 * with no `@MinimumRole` decorator to activate it — a Reviewer passed every one
 * of them unchanged. The fix adds `@MinimumRole(WorkspaceRole.editor)` to all
 * seven; the read routes, upload, run and export were already correctly
 * gated and are swept here unchanged.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md`
 * § AXI-2340 §.1–§.2. Fully self-provisioned: one fresh workspace
 * (`PrivateProjectsWorld`), a throwaway admin owner and a throwaway Reviewer
 * (`sponsor_viewer`), one CSV dataset and one real chart spec minted by the
 * admin through `POST candidates/regenerate`. Nothing seeded or shared is read
 * or mutated.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ['@SI-010', '@SI-011'] };

let world: PrivateProjectsWorld;
let owner: Actor;
let reviewer: Actor;
let datasetId: string;
let specId: string;

async function body(res: APIResponse, what: string): Promise<any> {
  const text = await res.text();
  if (!res.ok()) throw new Error(`AXI-2340 fixture ${what} -> ${res.status()}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function candidatesBase(workspaceId: string, dsId: string): string {
  return `/api/v1/workspaces/${workspaceId}/datasets/${dsId}/candidates`;
}

const INGEST_TIMEOUT_MS = 90_000;

/** `uploadCsvDataset` does not await ingestion (AXI-2267); `regenerate` needs a
 *  profiled column shape to produce candidates, so this story's fixture waits. */
async function waitForIngestion(dsId: string): Promise<void> {
  const deadline = Date.now() + INGEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const d = await body(
      await owner.api.get(apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets/${dsId}`)),
      'read dataset',
    );
    const status = d?.latestIngestion?.status;
    if (status === 'ready') return;
    if (status === 'failed') throw new Error('AXI-2340 fixture: ingestion failed');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('AXI-2340 fixture: ingestion timed out');
}

/** Mint (or reuse) a real chart spec on the dataset via `regenerate`, as the admin. */
async function realChartSpec(): Promise<string> {
  const base = candidatesBase(world.workspaceId, datasetId);
  let specs: Array<{ id: string }> = await body(await owner.api.get(apiUrl(base)), 'list candidates');
  if (!Array.isArray(specs) || specs.length === 0) {
    await body(await owner.api.post(apiUrl(`${base}/regenerate`), { data: {} }), 'regenerate candidates');
    specs = await body(await owner.api.get(apiUrl(base)), 'list candidates (after regenerate)');
  }
  expect(specs.length, 'the fixture dataset has at least one chart spec').toBeGreaterThan(0);
  return specs[0].id;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  world = await PrivateProjectsWorld.create();
  owner = await world.actor('owner');
  reviewer = await world.actor('reviewer');
  await world.addMember(owner, 'admin');
  await world.addMember(reviewer, 'sponsor_viewer' as never);
  await world.leaveWorkspace();

  datasetId = await uploadCsvDataset(world, owner);
  await waitForIngestion(datasetId);
  specId = await realChartSpec();
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2340 — Reviewer read-only access (buyer)', TAGS, () => {
  test('AXI-2340.1 EC18 — a Reviewer is refused server-side on every chart-spec write route', async () => {
    // Arrange
    const base = candidatesBase(world.workspaceId, datasetId);
    const writes: Array<[string, () => Promise<APIResponse>]> = [
      ['POST candidates', () => reviewer.api.post(apiUrl(base), {
        data: { templateId: 'scatter_v1', templateVersion: '1.0.0', bindings: {} },
      })],
      ['POST candidates/regenerate', () => reviewer.api.post(apiUrl(`${base}/regenerate`), { data: {} })],
      ['PATCH candidates/:id/title', () => reviewer.api.patch(apiUrl(`${base}/${specId}/title`), {
        data: { title: 'AXI-2340 reviewer attempt' },
      })],
      ['PATCH candidates/:id/params', () => reviewer.api.patch(apiUrl(`${base}/${specId}/params`), {
        data: { params: { color: 'red' } },
      })],
      ['PATCH candidates/:id/compute-run-link', () => reviewer.api.patch(apiUrl(`${base}/${specId}/compute-run-link`), {
        data: { computeRunId: null },
      })],
      ['PATCH candidates/:id/facet-compute-run-links', () => reviewer.api.patch(apiUrl(`${base}/${specId}/facet-compute-run-links`), {
        data: { links: [] },
      })],
      ['DELETE candidates/:id', () => reviewer.api.delete(apiUrl(`${base}/${specId}`))],
    ];

    // Act
    const outcomes: string[] = [];
    for (const [label, call] of writes) outcomes.push(`${label} ${(await call()).status()}`);

    // Assert
    expect(outcomes).toEqual(writes.map(([label]) => `${label} 403`));
  });

  test('AXI-2340.1 AC3 — the read surface stays open to the Reviewer', async () => {
    // Arrange
    const base = candidatesBase(world.workspaceId, datasetId);

    // Act
    const list = await reviewer.api.get(apiUrl(base));
    const one = await reviewer.api.get(apiUrl(`${base}/${specId}`));

    // Assert
    expect(list.status()).toBe(200);
    expect((await list.json()).some((s: { id: string }) => s.id === specId)).toBe(true);
    expect(one.status()).toBe(200);
    expect((await one.json()).id).toBe(specId);
  });

  test('AXI-2340.1 — the fix is role-gated, not a blanket deny: an admin-tier caller still restyles', async () => {
    // Act
    const res = await owner.api.patch(apiUrl(`${candidatesBase(world.workspaceId, datasetId)}/${specId}/params`), {
      data: { params: { color: 'blue' } },
    });

    // Assert
    expect(res.status()).toBe(200);
  });

  test('AXI-2340.2 EC18 — a Reviewer is refused server-side on upload (unchanged)', async () => {
    // Act
    const res = await reviewer.api.post(apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`), {
      data: { organizationId: world.orgId, originalFilename: 'axi2340-reviewer.csv', contentType: 'text/csv' },
    });

    // Assert
    expect(res.status()).toBe(403);
  });

  test('AXI-2340.2 EC18 — a Reviewer is refused server-side on run via the Guided wizard (unchanged)', async () => {
    // Act
    const res = await reviewer.api.post(apiUrl('/api/v1/guided-analysis/wizard-runs'), { data: {} });

    // Assert
    expect(res.status()).toBe(403);
  });
});

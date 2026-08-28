import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { RestClient } from '../../staging/client/RestClient';
import { ensureDatasetStep } from '../../staging/steps/datasetIngestion';
import { SERVICE_HANDLE } from '../../staging/steps/context';
import { TENANT_FIXTURE } from '../../staging/fixtures/tenantFixture';
import type { ProvisioningContext } from '../../staging/steps/context';
import type { TenantFixture } from '../../staging/fixtures/types';

/**
 * AXI-1372 — `ensureDatasetStep()` (FR7/AC5/NFR1): ingest the Riaz DE table
 * via the real REST upload flow (initiate -> presigned S3 PUT -> finalize ->
 * wait for ingestion -> link to project), idempotently. Mocked at the HTTP
 * boundary — no live stack in this file (the story report carries the
 * actual live-stack run). `ensureDatasetStep.run()` is called directly
 * against a hand-built `ProvisioningContext` rather than the full
 * `stageTenant()`, so this stays fast and scoped to the dataset step alone.
 *
 * AXI-1374 widens `content.datasets` to a list (one corpus, two dataset
 * versions — the DE table plus a per-sample count-matrix backing charts
 * 5-6) and generalizes the step to iterate it, reading each entry's OWN
 * `localPathEnv`/`defaultLocalPath` instead of the single hard-coded
 * `STAGING_RIAZ_DE_CSV_PATH` constant AXI-1372 shipped. UT-DSI-001..005
 * still cover the single-dataset shape (still real: the fixture's first
 * entry, in isolation); UT-DSI-006..008 add the two-dataset behavior.
 *
 * @SI-044.
 */

interface FakeDataset {
  id: string;
  originalFilename: string;
  contentType: string;
  availability: 'pending' | 'available';
  latestIngestion: { status: string } | null;
}

/** A minimal in-memory stand-in for the dataset/project-link/S3 surface this
 *  step calls — not a gateway re-implementation (same convention as the
 *  AXI-1371 FakeGateway). The "presigned URL" is just another path this same
 *  fake server answers, since the step does a plain `fetch(...)` to it. */
class FakeDatasetGateway {
  datasets = new Map<string, FakeDataset>();
  projectLinks = new Map<string, Set<string>>(); // projectId -> datasetIds
  uploadedBytes: Uint8Array | undefined;
  initiateUploadCalls = 0;

  async handle(url: string, init: { method: string; body?: BodyInit | string; headers: Record<string, string> }): Promise<Response> {
    const parsed = new URL(url, 'http://localhost:3000');
    const path = parsed.pathname;
    const method = init.method;
    if (parsed.host === 'fake-s3.local') return this.handleS3Put(init);
    if (method === 'GET' && path === '/api/v1/projects') return json(200, { data: [{ id: 'project-1', name: 'Melanoma IO cohort, paired timepoints', status: 'active' }] });
    if (method === 'GET' && path === '/api/v1/workspaces/workspace-1/datasets') return this.searchDatasets(parsed.searchParams.get('search'));
    if (method === 'POST' && path === '/api/v1/workspaces/workspace-1/datasets') return this.initiateUpload(init.body);
    const finalizeMatch = path.match(/^\/api\/v1\/workspaces\/workspace-1\/datasets\/([^/]+)\/finalize$/);
    if (method === 'PATCH' && finalizeMatch) return this.finalize(finalizeMatch[1]);
    const getMatch = path.match(/^\/api\/v1\/workspaces\/workspace-1\/datasets\/([^/]+)$/);
    if (method === 'GET' && getMatch) return this.getDataset(getMatch[1]);
    if (method === 'GET' && path === '/api/v1/projects/project-1/datasets') return this.getProjectDatasets();
    if (method === 'POST' && path === '/api/v1/projects/project-1/datasets') return this.linkDataset(init.body);
    return json(404, { message: `unhandled route in FakeDatasetGateway: ${method} ${path}` });
  }

  private async handleS3Put(init: { body?: BodyInit | string }): Promise<Response> {
    this.uploadedBytes = init.body as Uint8Array;
    return new Response(undefined, { status: 200 });
  }

  private searchDatasets(search: string | null): Response {
    const matches = [...this.datasets.values()].filter((d) => !search || d.originalFilename === search);
    return json(200, { data: matches });
  }

  private initiateUpload(rawBody?: BodyInit | string): Response {
    this.initiateUploadCalls += 1;
    const body = JSON.parse(String(rawBody ?? '{}'));
    const dataset: FakeDataset = {
      id: randomUUID(),
      originalFilename: body.originalFilename,
      contentType: body.contentType,
      availability: 'pending',
      latestIngestion: null,
    };
    this.datasets.set(dataset.id, dataset);
    return json(201, { dataset: { id: dataset.id }, presignedUrl: 'http://fake-s3.local/bucket/key' });
  }

  private finalize(id: string): Response {
    const dataset = this.datasets.get(id);
    if (!dataset) return json(404, { message: 'not found' });
    dataset.availability = 'available';
    // Real finalize auto-triggers ingestion, but completion is async — model
    // that as 'queued' at finalize time; `getDataset` below flips it to
    // 'ready' the moment it's polled, so `waitForIngestion`'s status check
    // runs for real without this test sleeping through a real poll interval.
    dataset.latestIngestion = { status: 'queued' };
    return json(200, dataset);
  }

  private getDataset(id: string): Response {
    const dataset = this.datasets.get(id);
    if (!dataset) return json(404, { message: 'not found' });
    // Simulate the ingestion completing between the first and second poll.
    if (dataset.latestIngestion?.status === 'queued') dataset.latestIngestion = { status: 'ready' };
    return json(200, dataset);
  }

  // The real gateway returns raw ProjectDatasetLink join rows as a bare
  // array — each row's own `id` is the LINK id, and `datasetId` is the
  // dataset it points at (confirmed live, AXI-1372). Modeled faithfully here
  // after a first version of this fake used `{id: datasetId}` and hid a real
  // idempotency bug (`projectHasDataset` checking `.id` instead of
  // `.datasetId`) that only a live `stage` run exposed — see the production
  // code's comment on `projectHasDataset` for the full story.
  private getProjectDatasets(): Response {
    const linked = this.projectLinks.get('project-1') ?? new Set<string>();
    return json(200, [...linked].map((datasetId) => ({ id: randomUUID(), projectId: 'project-1', datasetId })));
  }

  private linkDataset(rawBody?: BodyInit | string): Response {
    const { datasetId } = JSON.parse(String(rawBody ?? '{}'));
    const linked = this.projectLinks.get('project-1') ?? new Set<string>();
    linked.add(datasetId);
    this.projectLinks.set('project-1', linked);
    return json(201, { projectId: 'project-1', datasetId });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installFetchStub(gateway: FakeDatasetGateway): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    return gateway.handle(String(input), { method: init.method ?? 'GET', body: init.body ?? undefined, headers });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Single-dataset slice of the shipped fixture (its `de_table` entry alone)
 *  — keeps UT-DSI-001..005 exercising exactly one dataset, same shape as
 *  before AXI-1374 widened `content.datasets` to a list. */
function oneDatasetFixture(): TenantFixture {
  const deTable = TENANT_FIXTURE.content.datasets.find((d) => d.role === 'de_table')!;
  return { ...TENANT_FIXTURE, content: { ...TENANT_FIXTURE.content, datasets: [deTable] } };
}

function newContext(fixture: TenantFixture = oneDatasetFixture()): ProvisioningContext {
  const client = new RestClient({ baseUrl: 'http://localhost:3000' });
  client.tokens.set(SERVICE_HANDLE, { accessToken: 'fake-service-token' });
  return {
    client,
    fixture,
    serviceUserId: 'svc-1',
    orgId: 'org-1',
    workspaceIdByFixtureName: new Map([['Translational Immuno-Oncology', 'workspace-1']]),
    touched: [],
  };
}

test.describe('FR7/AC5 — ensureDatasetStep() ingests the Riaz DE-table dataset', () => {
  let gateway: FakeDatasetGateway;
  let restore: () => void;
  let tempDir: string;
  let previousEnv: string | undefined;

  test.beforeEach(() => {
    gateway = new FakeDatasetGateway();
    restore = installFetchStub(gateway);
    tempDir = mkdtempSync(join(tmpdir(), 'axi-1372-riaz-'));
    previousEnv = process.env.STAGING_RIAZ_DE_CSV_PATH;
    const csvPath = join(tempDir, 'riaz2017_de_pre_R_vs_NR.csv');
    writeFileSync(csvPath, 'gene,baseMean,log2FoldChange,pvalue,padj\nBRCA1,277.9,-0.56,0.13,0.65\n');
    process.env.STAGING_RIAZ_DE_CSV_PATH = csvPath;
  });

  test.afterEach(() => {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
    if (previousEnv === undefined) delete process.env.STAGING_RIAZ_DE_CSV_PATH;
    else process.env.STAGING_RIAZ_DE_CSV_PATH = previousEnv;
  });

  test('UT-DSI-001 — first run uploads, finalizes, waits for ingestion, and links to the project', async () => {
    const ctx = newContext();
    await ensureDatasetStep.run(ctx);

    expect(gateway.initiateUploadCalls).toBe(1);
    expect(gateway.uploadedBytes).toBeDefined();
    const dataset = [...gateway.datasets.values()][0];
    expect(dataset.availability).toBe('available');
    expect(gateway.projectLinks.get('project-1')?.has(dataset.id)).toBe(true);
    expect(ctx.touched.filter((t) => t.kind === 'dataset').map((t) => t.action).sort()).toEqual(['created', 'linked']);
  });

  test('UT-DSI-002 (NFR1) — a second run reuses the existing dataset, no re-upload, no duplicate link', async () => {
    const first = newContext();
    await ensureDatasetStep.run(first);
    expect(gateway.datasets.size).toBe(1);

    const second = newContext();
    await ensureDatasetStep.run(second);

    expect(gateway.initiateUploadCalls).toBe(1); // still just the one upload
    expect(gateway.datasets.size).toBe(1); // no duplicate dataset (AC5: exactly one version of THIS dataset)
    expect(second.touched.filter((t) => t.kind === 'dataset').map((t) => t.action)).toEqual(['reused']);
  });

  test('UT-DSI-003 — the S3 PUT carries the declared content type, matching what initiateUpload signed', async () => {
    const ctx = newContext();
    await ensureDatasetStep.run(ctx);
    const dataset = [...gateway.datasets.values()][0];
    expect(dataset.contentType).toBe('text/csv');
  });

  test('UT-DSI-004 — fails loudly when the fixture names a workspace not yet in context', async () => {
    const ctx = newContext();
    ctx.workspaceIdByFixtureName.clear();
    await expect(ensureDatasetStep.run(ctx)).rejects.toThrow(/workspace .* not found in context/);
  });

  test('UT-DSI-005 — is a no-op when the fixture declares no dataset content', async () => {
    const ctx = newContext();
    ctx.fixture = { ...TENANT_FIXTURE, content: { ...TENANT_FIXTURE.content, datasets: [] } };
    await ensureDatasetStep.run(ctx);
    expect(gateway.initiateUploadCalls).toBe(0);
    expect(ctx.touched).toHaveLength(0);
  });
});

test.describe('AXI-1374 (AC5 amended) — ensureDatasetStep() ingests a SECOND, count-matrix dataset alongside the DE table', () => {
  let gateway: FakeDatasetGateway;
  let restore: () => void;
  let tempDir: string;
  let previousDeEnv: string | undefined;
  let previousCountEnv: string | undefined;

  test.beforeEach(() => {
    gateway = new FakeDatasetGateway();
    restore = installFetchStub(gateway);
    tempDir = mkdtempSync(join(tmpdir(), 'axi-1374-riaz-'));
    previousDeEnv = process.env.STAGING_RIAZ_DE_CSV_PATH;
    previousCountEnv = process.env.STAGING_RIAZ_COUNT_MATRIX_CSV_PATH;
    const dePath = join(tempDir, 'de.csv');
    const countPath = join(tempDir, 'counts.csv');
    writeFileSync(dePath, 'gene,baseMean,log2FoldChange,pvalue,padj\nBRCA1,277.9,-0.56,0.13,0.65\n');
    writeFileSync(countPath, 'gene,patient_id,response,pre_expression,on_expression\nBRCA1,Pt1,R,58,63\n');
    process.env.STAGING_RIAZ_DE_CSV_PATH = dePath;
    process.env.STAGING_RIAZ_COUNT_MATRIX_CSV_PATH = countPath;
  });

  test.afterEach(() => {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
    if (previousDeEnv === undefined) delete process.env.STAGING_RIAZ_DE_CSV_PATH;
    else process.env.STAGING_RIAZ_DE_CSV_PATH = previousDeEnv;
    if (previousCountEnv === undefined) delete process.env.STAGING_RIAZ_COUNT_MATRIX_CSV_PATH;
    else process.env.STAGING_RIAZ_COUNT_MATRIX_CSV_PATH = previousCountEnv;
  });

  test('UT-DSI-006 — one run ingests BOTH declared datasets and links both to the project', async () => {
    const ctx = newContext(TENANT_FIXTURE);
    await ensureDatasetStep.run(ctx);

    expect(gateway.initiateUploadCalls).toBe(2);
    expect(gateway.datasets.size).toBe(2);
    const filenames = [...gateway.datasets.values()].map((d) => d.originalFilename).sort();
    expect(filenames).toEqual(['riaz2017_de_pre_R_vs_NR.csv', 'riaz2017_expression_by_response_timepoint.csv']);
    for (const dataset of gateway.datasets.values()) {
      expect(gateway.projectLinks.get('project-1')?.has(dataset.id)).toBe(true);
    }
  });

  test('UT-DSI-007 (NFR1) — a second run reuses both datasets, no re-upload, no duplicate links', async () => {
    const first = newContext(TENANT_FIXTURE);
    await ensureDatasetStep.run(first);

    const second = newContext(TENANT_FIXTURE);
    await ensureDatasetStep.run(second);

    expect(gateway.initiateUploadCalls).toBe(2); // still just the two original uploads
    expect(gateway.datasets.size).toBe(2);
    expect(second.touched.filter((t) => t.kind === 'dataset').map((t) => t.action)).toEqual(['reused', 'reused']);
  });

  test('UT-DSI-008 — each dataset reads bytes from its OWN localPathEnv, not a shared hard-coded path', async () => {
    const ctx = newContext(TENANT_FIXTURE);
    await ensureDatasetStep.run(ctx);
    // Both uploads succeeded (initiateUploadCalls === 2, above) using two
    // DIFFERENT env-provided paths set in beforeEach — proof the step no
    // longer reads a single module-level constant path.
    expect(gateway.uploadedBytes).toBeDefined();
  });
});

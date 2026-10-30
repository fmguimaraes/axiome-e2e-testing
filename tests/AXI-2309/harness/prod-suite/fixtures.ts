import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiClient, okBody } from './api-client';
import { ProdSuiteAbort } from './abort';

/**
 * AXI-2318 — prod-suite fixtures, referenced by ID (FR29).
 *
 * The two fixtures are Paul Dalmas's two table formats filled with the
 * owner-approved SYNTHETIC data of the Microbiote final reference set
 * (byte-identical copies of `axiome-docs/demo/mag4-microbiote/final/inputs/`,
 * the exact inputs the AXI-2066 reproduction numbers were computed against —
 * never real patient data, NFR5). They are uploaded ONCE into the test
 * workspace (`provisionFixtures`, run by the operator via the workflow's
 * `provision-fixtures` mode) and every daily run then resolves them by the
 * dataset ids in `PROD_E2E_FIXTURE_IDS`, verifying each server-recorded
 * `rawFileHash` against the committed bytes. A daily run NEVER uploads: an id
 * that does not resolve, or resolves to different bytes, aborts the run.
 */

export interface FixtureSpec {
  key: string;
  file: string;
  contentType: string;
  /** Paul's format the file instantiates (for the report reader). */
  format: string;
}

export interface ResolvedFixture {
  key: string;
  datasetId: string;
  rawFileHash: string;
}

export const PROD_SUITE_FIXTURES: readonly FixtureSpec[] = [
  { key: 'tableau1', file: 'final_tableau1_long_synthetic.csv', contentType: 'text/csv', format: 'Tableau 1 (long: serum, group, reference, isotype, pct)' },
  { key: 'tableau2', file: 'final_tableau2_synthetic.csv', contentType: 'text/csv', format: 'Tableau 2 axiome (wide: one row per patient)' },
];

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/prod-suite');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function fixtureBytes(spec: FixtureSpec, dir = FIXTURES_DIR): Buffer {
  return readFileSync(path.join(dir, spec.file));
}

/** The `rawFileHash` the platform records for these bytes (`sha256:<hex>`, datasets.service finalize). */
export function expectedRawFileHash(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Parse `PROD_E2E_FIXTURE_IDS` into key → dataset id; every manifest key must map to a UUID. */
export function parseFixtureIds(raw: string, manifest: readonly FixtureSpec[] = PROD_SUITE_FIXTURES): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProdSuiteAbort('fixtures', 'FIXTURE_IDS_MALFORMED', 'PROD_E2E_FIXTURE_IDS is not valid JSON');
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const ids = new Map<string, string>();
  for (const spec of manifest) {
    const id = record[spec.key];
    if (typeof id !== 'string' || !UUID.test(id)) {
      throw new ProdSuiteAbort('fixtures', 'FIXTURE_ID_MISSING', `PROD_E2E_FIXTURE_IDS has no dataset id for "${spec.key}"`);
    }
    ids.set(spec.key, id);
  }
  return ids;
}

/** Pure check of one dataset row against its fixture (workspace, not deleted, same bytes). */
export function assertFixtureDataset(row: any, spec: FixtureSpec, workspaceId: string, expectedHash: string): void {
  const fail = (code: string, why: string) => {
    throw new ProdSuiteAbort('fixtures', code, `fixture "${spec.key}": ${why} — re-provision it, never re-upload per run`);
  };
  if (row?.workspaceId !== workspaceId) fail('FIXTURE_OUTSIDE_TEST_WORKSPACE', 'dataset is not in the test workspace');
  if (row?.deletedAt) fail('FIXTURE_DELETED', 'dataset is deleted');
  if (row?.rawFileHash !== expectedHash) fail('FIXTURE_HASH_MISMATCH', 'dataset bytes differ from the committed fixture');
}

/** Resolve every fixture BY ID and verify it — never uploads (FR29). */
export async function resolveFixtures(
  client: ApiClient,
  workspaceId: string,
  fixtureIdsJson: string,
  manifest: readonly FixtureSpec[] = PROD_SUITE_FIXTURES,
  readBytes: (spec: FixtureSpec) => Buffer = (spec) => fixtureBytes(spec),
): Promise<ResolvedFixture[]> {
  const ids = parseFixtureIds(fixtureIdsJson, manifest);
  const resolved: ResolvedFixture[] = [];
  for (const spec of manifest) {
    const datasetId = ids.get(spec.key)!;
    const res = await client.get(`/api/v1/workspaces/${workspaceId}/datasets/${datasetId}`);
    if (res.status !== 200) {
      throw new ProdSuiteAbort('fixtures', 'FIXTURE_NOT_FOUND', `fixture "${spec.key}" did not resolve by id (HTTP ${res.status})`);
    }
    const hash = expectedRawFileHash(readBytes(spec));
    assertFixtureDataset(res.body, spec, workspaceId, hash);
    resolved.push({ key: spec.key, datasetId, rawFileHash: hash });
  }
  return resolved;
}

// ── One-time provisioning (operator act, FR29 "uploaded once") ──────────────

export interface UploadPort {
  put(url: string, contentType: string, bytes: Buffer): Promise<number>;
}

export const fetchUpload: UploadPort = {
  async put(url, contentType, bytes) {
    const res = await fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body: new Uint8Array(bytes) });
    return res.status;
  },
};

/** Every non-deleted dataset row in the workspace (paged). */
async function listWorkspaceDatasets(client: ApiClient, workspaceId: string): Promise<any[]> {
  const rows: any[] = [];
  for (let page = 1; page <= 100; page++) {
    const body = okBody(await client.get(`/api/v1/workspaces/${workspaceId}/datasets?page=${page}&limit=100`), 'list datasets');
    const data: any[] = Array.isArray(body?.data) ? body.data : [];
    rows.push(...data);
    if (!body?.meta?.hasNextPage || data.length === 0) return rows;
  }
  throw new Error('dataset listing did not terminate in 100 pages');
}

async function uploadOnce(client: ApiClient, ctx: { workspaceId: string; organizationId: string },
  spec: FixtureSpec, bytes: Buffer, upload: UploadPort): Promise<string> {
  const base = `/api/v1/workspaces/${ctx.workspaceId}/datasets`;
  const init = okBody(await client.post(base, {
    organizationId: ctx.organizationId, originalFilename: spec.file, contentType: spec.contentType,
  }), `initiate upload of ${spec.key}`);
  const status = await upload.put(init.presignedUrl, spec.contentType, bytes);
  if (status < 200 || status >= 300) throw new Error(`presigned PUT of ${spec.key} -> HTTP ${status}`);
  okBody(await client.patch(`${base}/${init.dataset.id}/finalize`), `finalize ${spec.key}`);
  return init.dataset.id;
}

/**
 * Upload each fixture unless the workspace already holds a dataset with the
 * same bytes (idempotent by `rawFileHash`), and return the key → id map the
 * operator stores as `PROD_E2E_FIXTURE_IDS`. Run once, after the isolation guard.
 */
export async function provisionFixtures(
  client: ApiClient,
  ctx: { workspaceId: string; organizationId: string },
  upload: UploadPort = fetchUpload,
  manifest: readonly FixtureSpec[] = PROD_SUITE_FIXTURES,
  readBytes: (spec: FixtureSpec) => Buffer = (spec) => fixtureBytes(spec),
): Promise<Record<string, string>> {
  const existing = await listWorkspaceDatasets(client, ctx.workspaceId);
  const ids: Record<string, string> = {};
  for (const spec of manifest) {
    const bytes = readBytes(spec);
    const hash = expectedRawFileHash(bytes);
    const reuse = existing.find((row) => row?.rawFileHash === hash && !row?.deletedAt);
    ids[spec.key] = reuse ? String(reuse.id) : await uploadOnce(client, ctx, spec, bytes, upload);
  }
  return ids;
}

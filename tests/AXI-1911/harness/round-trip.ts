import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminApi, asList, sleep, workspaceHeader, type Api } from '../../AXI-1435/harness/api';
import { carrierRuleId } from '../../AXI-1400/harness/seed';
import { decodeValue } from './encoding';
import type { ExpectedRefusal } from './comparator';

/**
 * AXI-1921 (epic AXI-1911 — FR5, AC5, D8, SI-042). Seeding + submission +
 * polling for the release round-trip runner. Reuses the established
 * `adminApi`/`Api` client (`tests/AXI-1435/harness/api.ts`, already imported
 * across sibling stories, e.g. `tests/AXI-1762/AXI-1810-locked-policy-
 * enforced.spec.ts`) and the carrier-approval helper
 * (`tests/AXI-1400/harness/seed.ts#carrierRuleId`) rather than re-deriving
 * either. Own-repo convention followed:
 * `tests/AXI-1400/harness/seed.ts#ingestFixture`/`uploadAndFinalize`'s
 * upload-CSV-then-poll-ingestion shape, adapted for this story's OWN inline
 * fixture rows (no on-disk CSV committed — generated at runtime from the
 * fixture JSON's `rows`, so the embedded fixture content and the ingested
 * bytes can never drift apart).
 *
 * `stats.fisher_exact`'s roles (`rowColumn`/`columnColumn`) are `roleBinding`
 * kind (`axiome-back`'s `operand-role-sources.ts`) — resolved directly from
 * the ingested dataset's raw column names, with NO semantic profile
 * assignment required. This is why this harness skips the semantic-
 * mapping step (`assignProfileAndVerify`) other operations' harnesses need.
 */

/**
 * Shape mirrors bio-compute's own `Fixture` schema
 * (`tests/validation/fixtures/schema.py`) only for the `case_kind` values
 * this port covers today: `nominal`/`boundary`/`degenerate` (an
 * `expected` field array) or `refusal` (an `expected_refusal` object).
 * AXI-1957's multi-row `expected_rows` shape (merged on bio-compute
 * origin/main `cd0aa85`) is deliberately NOT
 * modeled here — `loadRoundTripFixtures` below throws on it rather than
 * silently accepting an unrecognised on-disk shape.
 */
export interface RoundTripFixtureExpectedField {
  readonly field: string;
  readonly value: unknown;
  readonly null?: boolean;
  readonly toleranceKind: 'exact' | 'relative' | 'absolute' | 'log_p' | 'monte_carlo';
  readonly toleranceValue: number;
  readonly nullable: boolean;
}

export interface RoundTripFixtureCommon {
  readonly method_id: string;
  readonly operation_id: string;
  readonly operand_roles: Record<string, string>;
  readonly operation_params: Record<string, unknown>;
  readonly csv_columns: readonly string[];
  readonly rows: readonly Record<string, string>[];
  readonly case_kind: 'nominal' | 'boundary' | 'degenerate' | 'refusal';
  readonly expected?: readonly RoundTripFixtureExpectedField[];
  readonly expected_refusal?: ExpectedRefusal;
}

export type RoundTripFixture = RoundTripFixtureCommon;

const FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-1911', 'harness', 'fixtures');

const KNOWN_CASE_KINDS = new Set(['nominal', 'boundary', 'degenerate', 'refusal']);

/**
 * Apply the fixture-file non-finite envelope decode (`encoding.ts#decodeValue`)
 * ONCE, recursively, at load time — mirrors `loader.py#parse_fixture` calling
 * `decode_value` before a fixture is ever compared (bounce #1's main
 * finding: the comparator itself must never see an envelope).
 *
 * Throws "unsupported fixture shape" for any on-disk fixture whose
 * `case_kind` this port does not recognise, or that declares an
 * `expected_rows` key (AXI-1957's multi-row shape, merged on bio-compute
 * origin/main `cd0aa85` — porting it is a separate story's job, out of
 * this story's scope) — loud, never a silent skip.
 */
function decodeFixture(raw: Record<string, unknown>): RoundTripFixture {
  if ('expected_rows' in raw) {
    throw new Error(
      `unsupported fixture shape: '${String(raw.method_id)}' declares 'expected_rows' (AXI-1957's multi-row shape, bio-compute origin/main cd0aa85) — this port does not cover it`,
    );
  }
  const caseKind = raw.case_kind;
  if (typeof caseKind !== 'string' || !KNOWN_CASE_KINDS.has(caseKind)) {
    throw new Error(`unsupported fixture shape: '${String(raw.method_id)}' has case_kind '${String(caseKind)}', which this port does not cover`);
  }
  const decoded = { ...raw, case_kind: caseKind } as Record<string, unknown>;
  if (Array.isArray(raw.expected)) decoded.expected = decodeValue(raw.expected);
  if (raw.expected_refusal != null && typeof raw.expected_refusal === 'object') {
    decoded.expected_refusal = decodeValue(raw.expected_refusal);
  }
  return decoded as unknown as RoundTripFixture;
}

/** Every round-trip fixture this runner knows about today — loudly just the
 * ones present on disk; see the spec's own per-method "no fixture yet" lines
 * for the methods this does NOT cover (AXI-1912's job). */
export function loadRoundTripFixtures(): RoundTripFixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => decodeFixture(JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf8')) as Record<string, unknown>));
}

function toCsv(columns: readonly string[], rows: readonly Record<string, string>[]): string {
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => escape(String(row[c] ?? ''))).join(','));
  return lines.join('\n');
}

export interface Tenant {
  orgId: string;
  workspaceId: string;
  projectId: string;
  headers: Record<string, string>;
}

const ORG_NAME = 'AXI-1921 Round-Trip Validation Org';
const WORKSPACE_NAME = 'AXI-1921 Round-Trip Validation';

async function findByName(api: Api, path: string, name: string): Promise<string | undefined> {
  const res = await api.get(`${path}?limit=100`);
  return asList(res.body).find((x: any) => x.name === name)?.id;
}

/** A fresh-or-reused tenant dedicated to this release gate, never the shared
 * demo stack's own org/workspace (this runner is release-gate only and is
 * never pointed at the shared demo DB). */
export async function ensureRoundTripTenant(api: Api): Promise<Tenant> {
  const orgId =
    (await findByName(api, '/api/v1/organizations', ORG_NAME)) ??
    (await api.post('/api/v1/organizations', { name: ORG_NAME, type: 'biotech' })).body.id;

  let workspaceId = await findByName(api, '/api/v1/workspaces', WORKSPACE_NAME);
  if (!workspaceId) {
    const res = await api.post('/api/v1/workspaces', {
      name: WORKSPACE_NAME,
      type: 'internal',
      ownerOrganizationId: orgId,
    });
    workspaceId = res.body.id;
  }
  const headers = workspaceHeader(workspaceId!);

  const projects = await api.get(`/api/v1/projects?workspaceId=${workspaceId}&limit=100`, headers);
  let projectId = asList(projects.body).find((p: any) => p.name === WORKSPACE_NAME)?.id;
  if (!projectId) {
    const res = await api.post('/api/v1/projects', { name: WORKSPACE_NAME, workspaceId }, headers);
    projectId = res.body.id;
  }
  return { orgId, workspaceId: workspaceId!, projectId: projectId!, headers };
}

const INGEST_TIMEOUT_MS = 90_000;
const INGEST_POLL_MS = 2_000;

async function waitForIngestion(api: Api, t: Tenant, datasetId: string): Promise<void> {
  const deadline = Date.now() + INGEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const d = await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}`, t.headers);
    const status = d.body?.latestIngestion?.status;
    if (status === 'ready') return;
    if (status === 'failed') throw new Error(`ingestion of round-trip fixture dataset failed`);
    await sleep(INGEST_POLL_MS);
  }
  throw new Error('ingestion of round-trip fixture dataset timed out');
}

async function ensureLink(api: Api, t: Tenant, datasetId: string): Promise<void> {
  const linked = async () => {
    const res = await api.get(`/api/v1/projects/${t.projectId}/datasets`, t.headers);
    return asList(res.body).some((l: any) => l.datasetId === datasetId);
  };
  if (await linked()) return;
  await api.post(`/api/v1/projects/${t.projectId}/datasets`, { datasetId }, t.headers);
  if (!(await linked())) throw new Error(`fixture dataset did not link to the round-trip project`);
}

/** Ingest one fixture's rows as a fresh CSV dataset (generated at runtime —
 * never a committed CSV file duplicating the JSON fixture's own `rows`). */
export async function ingestRoundTripFixture(api: Api, t: Tenant, fixture: RoundTripFixture): Promise<string> {
  const filename = `${fixture.method_id}-round-trip.csv`;
  const csv = toCsv(fixture.csv_columns, fixture.rows);
  const init = await api.post(
    `/api/v1/workspaces/${t.workspaceId}/datasets`,
    { organizationId: t.orgId, originalFilename: filename, contentType: 'text/csv' },
    t.headers,
  );
  const datasetId = init.body.dataset.id;
  const presignedUrl = init.body.presignedUrl;
  const put = await fetch(presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: csv });
  if (!put.ok) throw new Error(`presigned PUT of ${filename} failed (${put.status})`);
  const fin = await api.patch(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}/finalize`, undefined, t.headers);
  if (fin.status >= 300) throw new Error(`finalize ${filename} failed (${fin.status})`);
  await waitForIngestion(api, t, datasetId);
  await ensureLink(api, t, datasetId);
  return datasetId;
}

export interface Analysis {
  analysisId: string;
  snapshotId: string;
}

/** Reuse-or-create a single empty-filter referent snapshot per method, like
 * `tests/AXI-1400/harness/seed.ts#ensureAnalysis`'s own precedent (a fresh
 * POST per call versions a new snapshot that later re-runs would dedup
 * against, leaving it childless). */
export async function ensureRoundTripAnalysis(api: Api, t: Tenant, name: string, datasetId: string): Promise<Analysis> {
  const list = await api.get(`/api/v1/view-analyses?projectId=${t.projectId}`, t.headers);
  const found = asList(list.body).find((a: any) => a.name === name);
  const analysisId = found
    ? found.id
    : (await api.post('/api/v1/view-analyses', { projectId: t.projectId, datasetId, name }, t.headers)).body.id;

  const existing = await api.get(`/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=100`, t.headers);
  const base = asList(existing.body).find((s: any) => s.origin === 'filter' && (s.filters == null || s.filters.length === 0));
  const snapshotId = base
    ? base.id
    : (await api.post('/api/v1/view-analyses/snapshots', { viewAnalysisId: analysisId, filters: [] }, t.headers)).body.id;
  return { analysisId, snapshotId };
}

const RUN_TIMEOUT_MS = 120_000;
const RUN_POLL_MS = 2_000;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELED', 'DEDUPED']);

export interface RuleRunRow {
  id: string;
  status: string;
  [key: string]: unknown;
}

/** Submit the fixture's declared operation as a real governed run, waiting
 * out the "referent still profiling" 400 the way `AXI-1810`'s harness does. */
export async function submitRoundTrip(
  api: Api,
  t: Tenant,
  analysis: Analysis,
  datasetId: string,
  fixture: RoundTripFixture,
): Promise<RuleRunRow> {
  const ruleId = await carrierRuleId(fixture.operation_id);
  const body = {
    ruleId,
    runKind: 'STATISTICAL',
    operationId: fixture.operation_id,
    operationParams: fixture.operation_params,
    roleBindings: fixture.operand_roles,
    projectId: t.projectId,
    workspaceId: t.workspaceId,
    datasetId,
    snapshotId: analysis.snapshotId,
    viewAnalysisId: analysis.analysisId,
    scope: 'FILTERED',
  };
  let res: { status: number; body: any } | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    res = await api.post('/api/v1/rule-runs', body, t.headers);
    if (!(res.status === 400 && /profil/i.test(JSON.stringify(res.body)))) break;
    await sleep(2000);
  }
  if (!res || res.status >= 300) {
    throw new Error(`submit of ${fixture.method_id} round-trip run failed: ${JSON.stringify(res?.body)}`);
  }
  return pollTerminal(api, t, res.body.id);
}

async function pollTerminal(api: Api, t: Tenant, ruleRunId: string): Promise<RuleRunRow> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rr = await api.get(`/api/v1/rule-runs/${ruleRunId}`, t.headers);
    if (TERMINAL.has(rr.body?.status)) return rr.body;
    await sleep(RUN_POLL_MS);
  }
  throw new Error(`round-trip run ${ruleRunId} did not reach a terminal status within ${RUN_TIMEOUT_MS}ms`);
}

/**
 * The ACTUAL side's own non-finite encoding — distinct from, and never
 * mixed with, the fixture-file `__float__` envelope in `encoding.ts`.
 *
 * Established by reading `axiome-back` (read-only; no production source
 * touched by this story):
 *   - `stats.fisher_exact` writes a Parquet column of physical type
 *     Float64/DOUBLE (`axiome-bio-compute/src/pipelines/
 *     fisher_exact_execution.py`'s `_SCHEMA`, `pl.Float64`), via polars'
 *     `write_parquet` — native IEEE-754 NaN/Infinity, no string fallback.
 *   - read back by `apps/organization-service/src/rule-runs/
 *     result-table.reader.ts`'s `sanitizeParquetValue`, which only
 *     transforms `bigint`/`Buffer` and recurses into arrays/objects — it
 *     does not special-case numeric values at all, so a DOUBLE column's
 *     NaN/Inf should surface as a native JS `NaN`/`Infinity`/`-Infinity`
 *     unchanged.
 *   - passed through unmodified by the gateway's `apps/gateway/src/proxy/
 *     rule-runs.controller.ts`'s `:id/table` endpoint (`findTableData`) —
 *     a pure RPC passthrough, no transformation.
 *   This chain is VERIFIED by reading the above files; the one residual,
 *   NOT independently verified, step is `@dsnp/parquetjs`'s own bit-level
 *   fidelity decoding a DOUBLE column's NaN/Infinity — that would need a
 *   live run against a real stack to confirm, which this story did not
 *   perform. If that library instead ever surfaces a non-finite DOUBLE as
 *   a string, this function's fallback branch below (ported from the
 *   SEPARATE, also-verified JOIN-writer convention) will still classify
 *   it correctly.
 *   - A DIFFERENT, also-established encoding — bare string tokens
 *     `"NaN"`/`"Infinity"`/`"-Infinity"` via `String(value)` — is used
 *     ONLY by the JOIN run kind's `ResultTableWriterService`
 *     (`result-table-writer.service.ts`'s `coerceToPhysical`, confirmed
 *     by `grep -rln "ResultTableWriterService"` to be consumed only by
 *     `join-run-executor.service.ts`). `stats.fisher_exact` never goes
 *     through this writer, but this function still recognises the tokens
 *     so the SAME comparator path can serve a future JOIN-kind fixture.
 *
 * Anything that is neither a finite number, a native non-finite number,
 * nor one of the three recognised string tokens is returned UNCHANGED —
 * `compareField`/`compareExact` in `comparator.ts` will then report a
 * type mismatch rather than this function silently guessing a coercion.
 */
const ACTUAL_NONFINITE_TOKEN: Record<string, number> = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity };

export function decodeActualTableValue(value: unknown): unknown {
  if (typeof value === 'string' && value in ACTUAL_NONFINITE_TOKEN) return ACTUAL_NONFINITE_TOKEN[value];
  return value;
}

function decodeActualRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = decodeActualTableValue(v);
  return out;
}

/** The stored result row for a completed run — one object keyed by field
 * name, exactly what `compareFixture` (`harness/comparator.ts`) expects.
 * Non-finite values are decoded per `decodeActualTableValue` above before
 * the row is ever handed to the comparator. */
export async function fetchRoundTripResult(api: Api, t: Tenant, ruleRunId: string): Promise<Record<string, unknown>> {
  const res = await api.get(`/api/v1/rule-runs/${ruleRunId}/table`, t.headers);
  if (res.status >= 300) throw new Error(`fetch of round-trip result table failed (${res.status})`);
  const rows = asList(res.body?.rows ?? res.body);
  if (rows.length === 0) throw new Error('round-trip result table has no rows');
  return decodeActualRow(rows[0] as Record<string, unknown>);
}

export { adminApi };

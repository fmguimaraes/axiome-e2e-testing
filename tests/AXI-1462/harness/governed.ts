import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api } from '../../AXI-1435/harness/api';
import { workspaceHeader, asList, sleep } from '../../AXI-1435/harness/api';
import type { GradosQuestion } from '../../AXI-1458/fixtures/gradosQuestions';

/**
 * AXI-1473 — Grados-corpus governed-path harness (@SI-047).
 *
 * The governed path the corpus E2E drives (feature FR21 / AC6):
 *   guided plan  (POST /guided-analysis/plan)
 *     -> governed run  (POST /governed-execution/submit)
 *       -> reconciler drains  (GOVERNED_EXECUTION_RECONCILER=on)
 *         -> queryable state  (GET /governed-execution/status)
 *
 * This is the industrialized AXI-1458 spike path: a planner-produced AnalysisPlan
 * submitted to the event-sourced governed engine, not the in-unit compute route.
 * All delays live here (a harness, not a `*.spec.ts`), so the poll loops are
 * condition waits, not fixed sleeps the spec linter (AXI-1265/NFR4) forbids.
 */

/**
 * The Grados 2017 IgG4-RD question bank — the corpus AC6 refers to. Defined once
 * in tests/AXI-1458/fixtures/grados-questions.json (46 questions). Loaded via fs
 * (not a JSON `import`) so the Playwright runtime needs no import attribute, and
 * so this reuses the exact fixture the spike authored rather than re-inventing it.
 */
export function loadGradosBank(): GradosQuestion[] {
  const path = join(process.cwd(), 'tests', 'AXI-1458', 'fixtures', 'grados-questions.json');
  return (JSON.parse(readFileSync(path, 'utf8')) as { questions: GradosQuestion[] }).questions;
}

/** A structural node type (no external operation) — deterministic no-op output. */
export type StructuralNodeType = 'qc_check' | 'filter' | 'join' | 'describe' | 'profile';

/** Governed run node as the STATUS RPC returns it. */
export interface RunNode {
  nodeId: string;
  status: string;
  artifactHash: string | null;
}

/** Governed run status body (`GET /governed-execution/status`). */
export interface RunStatus {
  runId: string;
  runStatus?: string;
  status?: string;
  nodes: RunNode[];
  planId?: string | null;
}

const RUN_POLL_MS = 2_000;
const RUN_POLL_MAX = 60; // 60 * 2s = 120s ceiling per run

// A governed run node is "settled" once it leaves the schedulable states — either
// it produced/reused an artifact, was blocked/failed, or halted for human approval.
const SETTLED = new Set([
  'SUCCEEDED',
  'REUSED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'AWAITING_APPROVAL',
]);

/** One column of an anchored dataset, as the planner envelope carries it. */
export interface AnchoredColumn {
  name: string;
  /** The profiler's semantic type — `numeric` | `categorical` | `identifier` | `timepoint`. */
  type: string;
  /** The observed value domain of a low-cardinality categorical column (AXI-1462). */
  categories?: string[];
}

/** A dataset resolved for a planner envelope: real identity, real schema. */
export interface AnchoredDataset {
  datasetId: string;
  name: string;
  versionHash: string;
  columns: AnchoredColumn[];
}

/** Build the minimal PlannerEnvelope the guided planner needs for one question. */
export function buildEnvelope(
  projectId: string,
  question: string,
  datasets: AnchoredDataset[],
) {
  return {
    projectId,
    question,
    sendData: false,
    context: { scientificContext: 'Grados 2017 IgG4-RD corpus E2E (AXI-1473)' },
    datasets,
  };
}

/**
 * `sha256:<64 hex>` — the only version hash shape the backend accepts (rule P24,
 * `apps/organization-service/src/guided-analysis/plan/envelope-identity.ts`).
 */
export const SHA256_VERSION_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Rows pulled to profile the anchor dataset. Same cap the product uses
 * (`PROTO_ROW_LIMIT` in axiome-front `src/lib/guidedAnalysis/loadProjectDatasets.ts`),
 * so the harness profiles exactly what a user's guided launch profiles.
 */
export const ANCHOR_PROFILE_ROW_LIMIT = 1000;

/** Thrown when a dataset cannot describe itself — a run must not start on it. */
export class AnchorDatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnchorDatasetError';
  }
}

/** `dataset "name" (id)` — every failure message names the dataset it is about. */
function label(ds: { id: string; originalFilename?: string; displayName?: string | null }): string {
  return `dataset "${ds.displayName || ds.originalFilename || ds.id}" (${ds.id})`;
}

/** A short, non-secret rendering of a response body for a failure message. */
function snippet(body: unknown): string {
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return String(body);
  }
}

/**
 * Discover an ingested dataset in the workspace and describe it — its real
 * column schema and its real content hash — for a planner envelope.
 *
 * AXI-1661. The previous version read `columns`/`versionHash` off the workspace
 * dataset **LIST** row, which carries neither; both `??` chains fell through to
 * `[]` and the literal `'sha256:unknown'` WITHOUT failing, so the 2026-09-25
 * FR28/FR30 shadow run asked all 46 questions of both planner arms against a
 * dataset with no schema and measured nothing
 * (`axiome-docs/reports/2026-09-25-compiled-planner-shadow-run.md`). That mode
 * of failure is now impossible: every source below is mandatory and each one
 * throws, naming the dataset and what was missing, rather than degrading.
 *
 * The three sources are the ones the product itself uses (axiome-front
 * `src/lib/guidedAnalysis/loadProjectDatasets.ts` + `plannerEnvelope.ts`), so a
 * shadow run measures what a real guided launch would send:
 *   1. `GET  /workspaces/:ws/datasets/:id`         -> `fileHash`, the sha256 content
 *                                                     hash (P24's `versionHash`).
 *   2. `POST /workspaces/:ws/datasets/:id/query`   -> the live column list + a row
 *                                                     slice (the list row has neither).
 *   3. `POST /guided-analysis/profile`             -> the profiler's semantic types
 *                                                     and each categorical column's
 *                                                     observed `categories` domain.
 *
 * Returns `null` ONLY when the workspace holds no ingested dataset at all — an
 * honest "nothing to anchor on" the callers skip on. A dataset that exists but
 * cannot be described throws.
 */
export async function anchorDataset(
  api: Api,
  workspaceId: string,
  projectId: string,
): Promise<AnchoredDataset | null> {
  const res = await api.get(`/api/v1/workspaces/${workspaceId}/datasets?limit=50`, workspaceHeader(workspaceId));
  // `availability === 'available'` AND a ready ingestion, both explicitly: the
  // old truthiness test (`d.availability ?? d.latestIngestion?.status`) accepted
  // a `pending` upload, which has no parquet, no schema and a null fileHash.
  const ds = asList(res.body).find(
    (d: any) => d?.id && d.availability === 'available' && d.latestIngestion?.status === 'ready',
  );
  if (!ds) return null;

  const versionHash = await anchorVersionHash(api, workspaceId, ds);
  const { columns, rows } = await anchorSlice(api, workspaceId, ds);
  const profiled = await anchorColumns(api, workspaceId, projectId, ds, versionHash, columns, rows);

  return {
    datasetId: ds.id,
    name: ds.displayName || ds.originalFilename || ds.id,
    versionHash,
    columns: profiled,
  };
}

/** The dataset's real content hash, from the detail endpoint. Never substituted. */
async function anchorVersionHash(api: Api, workspaceId: string, ds: any): Promise<string> {
  const detail = await api.get(`/api/v1/workspaces/${workspaceId}/datasets/${ds.id}`, workspaceHeader(workspaceId));
  if (detail.status >= 300) {
    throw new AnchorDatasetError(
      `anchorDataset: ${label(ds)} — GET /datasets/:id returned ${detail.status}, so no version hash could be read: ${snippet(detail.body)}`,
    );
  }
  const versionHash = detail.body?.fileHash;
  if (typeof versionHash !== 'string' || !SHA256_VERSION_HASH_RE.test(versionHash)) {
    throw new AnchorDatasetError(
      `anchorDataset: ${label(ds)} carries no sha256 content hash (fileHash=${JSON.stringify(versionHash)}). ` +
        'A planner envelope needs a real `sha256:<64 hex>` versionHash (rule P24); refusing to anchor a run on an unpinned dataset. ' +
        'Note: fileHash is null for non-text formats (XLSX) — anchor on a CSV/TSV dataset.',
    );
  }
  return versionHash;
}

/** The live column list and a bounded row slice. Zero columns is a hard failure. */
async function anchorSlice(
  api: Api,
  workspaceId: string,
  ds: any,
): Promise<{ columns: Array<{ name: string }>; rows: Array<Record<string, unknown>> }> {
  const query = await api.post(
    `/api/v1/workspaces/${workspaceId}/datasets/${ds.id}/query`,
    { limit: ANCHOR_PROFILE_ROW_LIMIT },
    workspaceHeader(workspaceId),
  );
  if (query.status >= 300) {
    throw new AnchorDatasetError(
      `anchorDataset: ${label(ds)} — POST /datasets/:id/query returned ${query.status}, so no column schema could be read: ${snippet(query.body)}`,
    );
  }
  const columns = Array.isArray(query.body?.columns) ? query.body.columns : [];
  const rows = Array.isArray(query.body?.rows) ? query.body.rows : [];
  if (columns.length === 0) {
    throw new AnchorDatasetError(
      `anchorDataset: ${label(ds)} resolved ZERO columns from POST /datasets/:id/query. ` +
        'An envelope with `columns: []` tells the planner nothing and makes any run against it meaningless (AXI-1616); refusing to anchor.',
    );
  }
  if (rows.length === 0) {
    throw new AnchorDatasetError(
      `anchorDataset: ${label(ds)} returned ${columns.length} columns but ZERO rows, so it cannot be profiled for column types or category domains; refusing to anchor.`,
    );
  }
  return { columns, rows };
}

/** Semantic types + category domains, via the same profiler the product calls. */
async function anchorColumns(
  api: Api,
  workspaceId: string,
  projectId: string,
  ds: any,
  versionHash: string,
  columns: Array<{ name: string }>,
  rows: Array<Record<string, unknown>>,
): Promise<AnchoredColumn[]> {
  const names = columns.map((c: any) => c?.name).filter((n: unknown): n is string => typeof n === 'string' && n.length > 0);
  if (names.length !== columns.length) {
    throw new AnchorDatasetError(
      `anchorDataset: ${label(ds)} — POST /datasets/:id/query returned a column with no usable name: ${snippet(columns)}`,
    );
  }
  const profile = await api.post(
    '/api/v1/guided-analysis/profile',
    {
      projectId,
      dataset: {
        datasetVersion: versionHash,
        columns: names,
        rows: rows.map((row) => Object.fromEntries(names.map((n) => [n, coerceCell(row?.[n])]))),
      },
    },
    workspaceHeader(workspaceId),
  );
  if (profile.status >= 300) {
    throw new AnchorDatasetError(
      `anchorDataset: ${label(ds)} — POST /guided-analysis/profile returned ${profile.status}, so no column types could be resolved: ${snippet(profile.body)}`,
    );
  }
  const variables = Array.isArray(profile.body?.variables) ? profile.body.variables : [];
  if (variables.length === 0) {
    throw new AnchorDatasetError(
      `anchorDataset: ${label(ds)} profiled to ZERO variables even though the query returned ${names.length} columns (${names.join(', ')}); refusing to anchor on an unprofiled dataset.`,
    );
  }
  return variables.map((v: any) => ({
    name: v.name,
    type: v.type,
    ...(Array.isArray(v.categories) && v.categories.length > 0 ? { categories: v.categories } : {}),
  }));
}

/** Coerce a cell to the `string | number | null` the guided dataset contract allows. */
function coerceCell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return String(value);
}

/** Ask the planner for a plan (LLM or deterministic fallback) for one question. */
export async function planQuestion(api: Api, workspaceId: string, projectId: string, envelope: ReturnType<typeof buildEnvelope>): Promise<any | null> {
  const res = await api.post('/api/v1/guided-analysis/plan', { projectId, envelope }, workspaceHeader(workspaceId));
  if (res.status >= 300 || !res.body?.plan) return null;
  return res.body.plan;
}

/** Submit a plan as a governed run; returns the runId (or null on rejection). */
export async function submitPlan(api: Api, workspaceId: string, projectId: string, plan: any, datasetId: string): Promise<string | null> {
  const res = await api.post('/api/v1/governed-execution/submit', { projectId, plan, datasetId, workspaceId }, workspaceHeader(workspaceId));
  if (res.status >= 300) return null;
  return res.body?.runId ?? null;
}

/** Poll a run until every node has settled (or the ceiling is hit). */
export async function drainRun(api: Api, workspaceId: string, projectId: string, runId: string): Promise<RunStatus> {
  for (let i = 0; i < RUN_POLL_MAX; i++) {
    const res = await api.get(`/api/v1/governed-execution/status?projectId=${projectId}&runId=${runId}`, workspaceHeader(workspaceId));
    const body = res.body as RunStatus;
    const nodes = body?.nodes ?? [];
    if (nodes.length > 0 && nodes.every((n) => SETTLED.has(n.status))) return body;
    await sleep(RUN_POLL_MS);
  }
  const last = await api.get(`/api/v1/governed-execution/status?projectId=${projectId}&runId=${runId}`, workspaceHeader(workspaceId));
  return last.body as RunStatus;
}

/** True when no node in the run ended in a hard-error state. */
export function ranWithoutError(run: RunStatus): boolean {
  const nodes = run?.nodes ?? [];
  return nodes.length > 0 && !nodes.some((n) => n.status === 'FAILED');
}

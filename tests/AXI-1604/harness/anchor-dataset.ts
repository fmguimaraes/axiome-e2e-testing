import type { Api } from '../../AXI-1435/harness/api';
import { workspaceHeader, asList } from '../../AXI-1435/harness/api';

/**
 * AXI-1662 (epic AXI-1604 — FR28/FR30, @SI-042). THE dataset resolver. One
 * implementation, imported by every harness that builds a planner envelope.
 *
 * WHY THIS FILE EXISTS AT ALL — read this before adding a second copy.
 * There used to be two `anchorDataset()`s: one in
 * `tests/AXI-1462/harness/governed.ts` and a near-identical copy in
 * `tests/AXI-1603/harness/planner.ts`, kept in step by hand. AXI-1661 fixed the
 * first one — it had been degrading silently to `columns: []` and the literal
 * `'sha256:unknown'`, which is why the 2026-09-25 FR28/FR30 shadow run asked all
 * 46 Grados questions of BOTH planner arms against a dataset with no schema and
 * measured nothing
 * (`axiome-docs/reports/2026-09-25-compiled-planner-shadow-run.md`). The copy in
 * `planner.ts` did NOT get the fix, and carried all four defects forward
 * (`?? []` columns, `?? 'sha256:unknown'`, a truthiness availability test that
 * accepted a `pending` upload, and no `categories`). Its own comment block
 * already claimed the path was "live-verified": it had the endpoints right and
 * the failure behaviour wrong, and that knowledge never crossed back.
 *
 * So the fix is not "fix both copies". It is "have one copy". Any harness that
 * needs an anchor dataset imports `anchorDataset` from HERE. Do not re-implement
 * it in a story harness, not even "thinly" — that is exactly the move that cost
 * a paid evaluation run.
 *
 * THE CONTRACT (non-negotiable, and identical for every caller).
 * The three sources are the ones the product itself uses (axiome-front
 * `src/lib/guidedAnalysis/loadProjectDatasets.ts` + `plannerEnvelope.ts`), so an
 * anchored envelope is what a real guided launch would send:
 *   1. `GET  /workspaces/:ws/datasets/:id`       -> `fileHash`, the real sha256
 *                                                   content hash (rule P24's
 *                                                   `versionHash`).
 *   2. `POST /workspaces/:ws/datasets/:id/query` -> the live column list + a row
 *                                                   slice (the LIST row has
 *                                                   neither a schema nor a hash).
 *   3. `POST /guided-analysis/profile`           -> the profiler's semantic types
 *                                                   and each categorical column's
 *                                                   observed `categories` domain.
 * All three are mandatory and every degraded path THROWS an `AnchorDatasetError`
 * naming the dataset and what was missing: a non-2xx, an absent or malformed
 * `fileHash`, zero columns, zero rows, an unnamed column, zero profiled
 * variables. There is no `?? []`, no substituted hash, and no silent `catch` in
 * this file — if one appears, this module has been broken back to the defect.
 *
 * `null` is returned in EXACTLY ONE case: the workspace holds no anchorable
 * dataset at all. That is an honest "nothing to anchor on" and callers
 * `test.skip` on it. A dataset that exists but cannot describe itself throws.
 *
 * AXI-1677 adds ONE knob and nothing else: `AnchorDatasetOptions.datasetId`
 * chooses WHICH dataset is anchored. Everything after the choice — the three
 * sources, the four mandatory checks, the throw-on-every-degraded-path contract
 * above — is byte-for-byte the same code on both paths, deliberately, so the
 * targeted path cannot acquire a weaker contract than the untargeted one.
 */

/** One column of an anchored dataset, as the planner envelope carries it. */
export interface AnchoredColumn {
  name: string;
  /** The profiler's semantic type — `numeric` | `categorical` | `identifier` | `timepoint`. */
  type: string;
  /** The observed value domain of a low-cardinality categorical column (AXI-1462). */
  categories?: string[];
}

/**
 * A dataset resolved for a planner envelope: real identity, real schema.
 *
 * AXI-1662: the human filename lives in `displayName`, matching the CURRENT
 * `PlannerDatasetSchema` contract (`libs/contracts` — "FR2: the human filename
 * lives ONLY here"). Both harnesses used to emit the pre-AXI-1463 legacy `name`,
 * which the backend still tolerates only through `displayNameOf()`'s fallback
 * (`envelope-identity.ts:29`). Emitting the deprecated field kept the harness's
 * envelope different from the product's for no reason; it now matches.
 */
export interface AnchoredDataset {
  datasetId: string;
  displayName: string;
  versionHash: string;
  columns: AnchoredColumn[];
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

/** How the anchor dataset is CHOSEN. Everything after the choice is identical. */
export interface AnchorDatasetOptions {
  /**
   * AXI-1677 (epic AXI-1604 — FR28/FR30). Anchor EXACTLY this dataset id.
   *
   * WHY. Unset, this resolver takes the first available, ready dataset off the
   * workspace list — which is not reproducible, and on the workspace the shadow
   * run actually uses is close to arbitrary: the Riaz workspace holds roughly
   * 150 datasets, many of them intermediate `*_result.parquet` artifacts whose
   * `file_hash` is NULL and which therefore cannot be anchored on at all. A gate
   * measurement has to be able to name its own input; "whatever came back first"
   * is a different experiment on every run.
   *
   * The loud-failure contract is UNCHANGED and, if anything, stricter: a
   * targeted id that is not a dataset in this workspace, or is not ingested,
   * THROWS. It never silently falls back to the untargeted path, and it never
   * returns `null` — `null` still means only "this workspace holds nothing
   * anchorable", which is not what "the dataset you named is missing" means.
   */
  readonly datasetId?: string;
}

/** First available, ready dataset in the workspace, or `null`. Unchanged behaviour. */
async function firstAnchorableDataset(api: Api, workspaceId: string): Promise<any | null> {
  const res = await api.get(`/api/v1/workspaces/${workspaceId}/datasets?limit=50`, workspaceHeader(workspaceId));
  // `availability === 'available'` AND a ready ingestion, both explicitly: the
  // old truthiness test (`d.availability ?? d.latestIngestion?.status`) accepted
  // a `pending` upload, which has no parquet, no schema and a null fileHash.
  return (
    asList(res.body).find(
      (d: any) => d?.id && d.availability === 'available' && d.latestIngestion?.status === 'ready',
    ) ?? null
  );
}

/** The one named dataset, fetched by id. Every miss throws — see `datasetId`. */
async function targetedDataset(api: Api, workspaceId: string, datasetId: string): Promise<any> {
  // By id, through the DETAIL endpoint rather than by scanning the list: the
  // list is paginated and the target may not be on the first page at all.
  const res = await api.get(`/api/v1/workspaces/${workspaceId}/datasets/${datasetId}`, workspaceHeader(workspaceId));
  if (res.status >= 300 || !res.body?.id) {
    throw new AnchorDatasetError(
      `anchorDataset: the targeted dataset ${datasetId} could not be read in workspace ${workspaceId} ` +
        `(GET /datasets/:id returned ${res.status}): ${snippet(res.body)}. ` +
        'A targeted run anchors on the dataset it names or it does not run; it never falls back to another dataset.',
    );
  }
  if (res.body.availability !== 'available' || res.body.latestIngestion?.status !== 'ready') {
    throw new AnchorDatasetError(
      `anchorDataset: the targeted ${label(res.body)} is not ingested ` +
        `(availability=${JSON.stringify(res.body.availability)}, ingestion=${JSON.stringify(res.body.latestIngestion?.status)}). ` +
        'It has no parquet, no schema and no content hash, so it cannot be anchored on.',
    );
  }
  return res.body;
}

/**
 * Discover an ingested dataset in the workspace and describe it — its real
 * column schema and its real content hash — for a planner envelope.
 *
 * `projectId` is required: the profiler (source 3) is project-scoped, and it is
 * what supplies the semantic types and the `categories` domains. Every caller
 * already has one in scope at the call site (the AXI-1603 harness gets it from
 * `ensureTenant1603()`, the AXI-1462 specs from `ensureTenant()` or the
 * `SHADOW_RUN_PROJECT_ID` override), so there is no caller for which a
 * project-less, type-less, category-less envelope would have to be tolerated.
 *
 * `opts.datasetId` (AXI-1677) targets one dataset by id; see the field's own doc
 * for why "the first one in the list" is not good enough for a gate measurement.
 */
export async function anchorDataset(
  api: Api,
  workspaceId: string,
  projectId: string,
  opts: AnchorDatasetOptions = {},
): Promise<AnchoredDataset | null> {
  const ds = opts.datasetId
    ? await targetedDataset(api, workspaceId, opts.datasetId)
    : await firstAnchorableDataset(api, workspaceId);
  if (!ds) return null;

  const versionHash = await anchorVersionHash(api, workspaceId, ds);
  const { columns, rows } = await anchorSlice(api, workspaceId, ds);
  const profiled = await anchorColumns(api, workspaceId, projectId, ds, versionHash, columns, rows);

  return {
    datasetId: ds.id,
    displayName: ds.displayName || ds.originalFilename || ds.id,
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

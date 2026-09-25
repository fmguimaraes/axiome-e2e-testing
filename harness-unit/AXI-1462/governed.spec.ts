import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Api } from '../../tests/AXI-1435/harness/api';
import { anchorDataset } from '../../tests/AXI-1462/harness/governed';

/**
 * UT-ANCHOR-1661-1..8 (epic AXI-1604 — SI-042). Regression coverage for
 * `anchorDataset` (`tests/AXI-1462/harness/governed.ts`).
 *
 * THE DEFECT THESE PIN. Until AXI-1661, `anchorDataset` read `columns` and
 * `versionHash` off the workspace dataset **LIST** row, which carries neither.
 * Both `??` chains fell through, silently, to `[]` and the literal
 * `'sha256:unknown'`, and the harness happily returned that envelope. The
 * 2026-09-25 FR28/FR30 shadow run therefore asked all 46 Grados questions of
 * BOTH planner arms against a dataset with no schema — every answer was a
 * refusal and the gate evaluation measured nothing
 * (`axiome-docs/reports/2026-09-25-compiled-planner-shadow-run.md`). Types and
 * the live specs were both blind to it: the shape was valid, the values were
 * empty. UT-ANCHOR-1661-1/2/3 are the tests that would have caught it — an
 * undescribable dataset must THROW, never yield an empty-column envelope.
 *
 * `node:test` + a stubbed `Api`, so no backend is involved. The live proof that
 * the real endpoints return what this expects is
 * `tests/AXI-1604/AXI-1661-anchor-dataset-schema.spec.ts`. Run via
 * `npm run harness:unit`. See `UT.md` in this directory.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const DATASET = '33333333-3333-4333-8333-333333333333';
const HASH = `sha256:${'a'.repeat(64)}`;

/** A workspace dataset LIST row, exactly as the gateway returns it: no schema, no hash. */
function listRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DATASET,
    originalFilename: 'riaz2017_expression_by_response_timepoint.csv',
    displayName: null,
    availability: 'available',
    latestIngestion: { id: 'ing-1', status: 'ready', rowCount: 648, columnCount: 3 },
    ...overrides,
  };
}

interface StubRoutes {
  list?: unknown[];
  detail?: { status?: number; body?: unknown };
  query?: { status?: number; body?: unknown };
  profile?: { status?: number; body?: unknown };
}

/** Minimal `Api` stub routing only the four calls `anchorDataset` makes. */
function stubApi(routes: StubRoutes): Api {
  const ok = (r: { status?: number; body?: unknown } | undefined, body: unknown) => ({
    status: r?.status ?? 200,
    body: (r && 'body' in r ? r.body : body) as any,
  });
  return {
    async get(path: string) {
      if (path.includes('/datasets?')) return { status: 200, body: { data: routes.list ?? [] } as any };
      if (/\/datasets\/[^/?]+$/.test(path)) return ok(routes.detail, { id: DATASET, fileHash: HASH });
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path: string) {
      if (path.endsWith('/query')) return ok(routes.query, { columns: [], rows: [] });
      if (path.endsWith('/guided-analysis/profile')) return ok(routes.profile, { variables: [] });
      throw new Error(`unexpected POST ${path}`);
    },
    async patch(path: string) {
      throw new Error(`unexpected PATCH ${path}`);
    },
    ctx: {} as Api['ctx'],
  };
}

const REAL_SLICE = {
  columns: [
    { name: 'gene', type: 'string' },
    { name: 'response', type: 'string' },
    { name: 'pre_expression', type: 'float' },
  ],
  rows: [{ gene: 'CD27', response: 'NR', pre_expression: 2.7918 }],
};

const REAL_PROFILE = {
  variables: [
    { name: 'gene', type: 'categorical', usable: true, missingCount: 0, categories: ['CD27', 'CD8A'] },
    { name: 'response', type: 'categorical', usable: true, missingCount: 0, categories: ['NR', 'R'] },
    { name: 'pre_expression', type: 'numeric', usable: true, missingCount: 0 },
  ],
};

test('UT-ANCHOR-1661-1: a dataset whose schema resolves to ZERO columns throws — it never yields a `columns: []` envelope', async () => {
  // The exact pre-AXI-1661 shape: a list row with no `columns` and no `schema`,
  // and nothing downstream to supply one.
  const api = stubApi({ list: [listRow()], query: { body: { columns: [], rows: [] } } });
  await assert.rejects(
    () => anchorDataset(api, WS, PROJECT),
    (err: Error) => {
      assert.match(err.message, /ZERO columns/);
      assert.match(err.message, new RegExp(DATASET));
      assert.match(err.message, /riaz2017_expression_by_response_timepoint\.csv/);
      return true;
    },
  );
});

test('UT-ANCHOR-1661-2: a dataset with no sha256 content hash throws — it never substitutes the literal "sha256:unknown"', async () => {
  const api = stubApi({
    list: [listRow()],
    detail: { body: { id: DATASET, fileHash: null } },
    query: { body: REAL_SLICE },
    profile: { body: REAL_PROFILE },
  });
  await assert.rejects(
    () => anchorDataset(api, WS, PROJECT),
    (err: Error) => {
      assert.match(err.message, /no sha256 content hash/);
      assert.doesNotMatch(err.message, /sha256:unknown/);
      assert.match(err.message, new RegExp(DATASET));
      return true;
    },
  );
});

test('UT-ANCHOR-1661-3: a version hash that is not `sha256:<64 hex>` is refused, not forwarded', async () => {
  const api = stubApi({
    list: [listRow()],
    detail: { body: { id: DATASET, fileHash: 'sha256:unknown' } },
    query: { body: REAL_SLICE },
    profile: { body: REAL_PROFILE },
  });
  await assert.rejects(() => anchorDataset(api, WS, PROJECT), /no sha256 content hash/);
});

test('UT-ANCHOR-1661-4: a dataset that profiles to ZERO variables throws rather than anchoring untyped columns', async () => {
  const api = stubApi({ list: [listRow()], query: { body: REAL_SLICE }, profile: { body: { variables: [] } } });
  await assert.rejects(
    () => anchorDataset(api, WS, PROJECT),
    (err: Error) => {
      assert.match(err.message, /ZERO variables/);
      assert.match(err.message, /gene, response, pre_expression/);
      return true;
    },
  );
});

test('UT-ANCHOR-1661-5: a non-2xx from the schema endpoint throws with the status, never a silent empty schema', async () => {
  const api = stubApi({ list: [listRow()], query: { status: 400, body: { message: 'No ready ingestion' } } });
  await assert.rejects(
    () => anchorDataset(api, WS, PROJECT),
    (err: Error) => {
      assert.match(err.message, /returned 400/);
      assert.match(err.message, /No ready ingestion/);
      return true;
    },
  );
});

test('UT-ANCHOR-1661-6: an empty workspace returns null (an honest "nothing to anchor on"), not a throw', async () => {
  assert.equal(await anchorDataset(stubApi({ list: [] }), WS, PROJECT), null);
});

test('UT-ANCHOR-1661-7: a dataset that is not ingested yet is never anchored on — it has no parquet, no schema, no hash', async () => {
  const pending = listRow({ availability: 'pending', latestIngestion: null, id: 'pending-ds' });
  assert.equal(await anchorDataset(stubApi({ list: [pending] }), WS, PROJECT), null);
});

test('UT-ANCHOR-1661-8: a described dataset carries real column names, profiler types, categories and the real hash', async () => {
  const api = stubApi({ list: [listRow()], query: { body: REAL_SLICE }, profile: { body: REAL_PROFILE } });
  const anchor = await anchorDataset(api, WS, PROJECT);
  assert.deepEqual(anchor, {
    datasetId: DATASET,
    name: 'riaz2017_expression_by_response_timepoint.csv',
    versionHash: HASH,
    columns: [
      { name: 'gene', type: 'categorical', categories: ['CD27', 'CD8A'] },
      { name: 'response', type: 'categorical', categories: ['NR', 'R'] },
      { name: 'pre_expression', type: 'numeric' },
    ],
  });
});

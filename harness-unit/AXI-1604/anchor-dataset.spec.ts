import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Api } from '../../tests/AXI-1435/harness/api';
import { anchorDataset } from '../../tests/AXI-1604/harness/anchor-dataset';
import { buildEnvelope as buildGovernedEnvelope } from '../../tests/AXI-1462/harness/governed';
import { buildEnvelope as buildPlannerEnvelope } from '../../tests/AXI-1603/harness/planner';

/**
 * UT-ANCHOR-1661-1..8 + UT-ANCHOR-1662-1..4 (epic AXI-1604 — SI-042).
 * Regression coverage for `anchorDataset`, which AXI-1662 moved to the ONE
 * shared module `tests/AXI-1604/harness/anchor-dataset.ts`.
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
 * AND WHY 1661's COVERAGE WAS NOT ENOUGH. Those eight tests bound ONE of the two
 * copies of this function. `tests/AXI-1603/harness/planner.ts` carried a
 * near-duplicate that kept every defect above — `?? []` columns, the
 * `'sha256:unknown'` literal, a truthiness availability test that accepted a
 * `pending` upload, and no `categories` — and nothing failed, because nothing
 * tested it. UT-ANCHOR-1662-1 is therefore a STRUCTURAL guard: it reads the
 * harness sources and fails if a second resolver, or either degradation
 * literal, reappears anywhere outside the shared module. A copy that is never
 * imported by these tests is exactly how the defect survived.
 *
 * `node:test` + a stubbed `Api`, so no backend is involved. The live proof that
 * the real endpoints return what this expects is
 * `tests/AXI-1604/AXI-1661-anchor-dataset-schema.spec.ts`. Run via
 * `npm run harness:unit`. See `UT.md` in `harness-unit/`.
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
    displayName: 'riaz2017_expression_by_response_timepoint.csv',
    versionHash: HASH,
    columns: [
      { name: 'gene', type: 'categorical', categories: ['CD27', 'CD8A'] },
      { name: 'response', type: 'categorical', categories: ['NR', 'R'] },
      { name: 'pre_expression', type: 'numeric' },
    ],
  });
});

// ── AXI-1662 — one resolver, not two ─────────────────────────────────────────

const HARNESS_ROOT = path.join(import.meta.dirname, '..', '..', 'tests');
const SHARED_RESOLVER = path.join(HARNESS_ROOT, 'AXI-1604', 'harness', 'anchor-dataset.ts');

/** Every `tests/**\/harness/*.ts` source, so no harness can hide a second copy. */
function harnessSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) out.push(full);
    }
  };
  for (const epic of readdirSync(HARNESS_ROOT)) {
    const harness = path.join(HARNESS_ROOT, epic, 'harness');
    try {
      if (statSync(harness).isDirectory()) walk(harness);
    } catch {
      // No harness directory for this epic — nothing to scan.
    }
  }
  return out;
}

/** Source with block and line comments removed — the guards below judge CODE. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('UT-ANCHOR-1662-1: exactly ONE harness implements anchorDataset, and no envelope-building harness can degrade one', () => {
  const offenders: string[] = [];
  const implementers: string[] = [];
  for (const file of harnessSources()) {
    const code = codeOf(file);
    const rel = path.relative(HARNESS_ROOT, file);
    if (/(?:export\s+)?(?:async\s+)?function\s+anchorDataset\b/.test(code)) implementers.push(rel);
    if (file === SHARED_RESOLVER) continue;
    // Scoped to harnesses that build a planner envelope (they are the only ones
    // a dataset anchor can leak through); `?? []` elsewhere in the suite is
    // about result-table columns and is asserted on immediately.
    if (!code.includes('versionHash')) continue;
    // The two values the 2026-09-25 shadow run was voided by.
    if (/sha256:unknown/.test(code)) offenders.push(`${rel}: substitutes a placeholder version hash`);
    if (/columns\s*\?\?\s*\[\]/.test(code)) offenders.push(`${rel}: falls back to an empty column list`);
  }
  assert.deepEqual(offenders, [], `no envelope harness may degrade a dataset anchor:\n${offenders.join('\n')}`);
  assert.deepEqual(
    implementers,
    [path.relative(HARNESS_ROOT, SHARED_RESOLVER)],
    'anchorDataset must have exactly one implementation — a second copy is the AXI-1662 defect, not a convenience',
  );
});

test('UT-ANCHOR-1662-2: the AXI-1462 and AXI-1603 harnesses build their envelopes from the SAME anchor, categories and all', async () => {
  const api = stubApi({ list: [listRow()], query: { body: REAL_SLICE }, profile: { body: REAL_PROFILE } });
  const anchor = await anchorDataset(api, WS, PROJECT);
  assert.ok(anchor);

  const governed = buildGovernedEnvelope(PROJECT, 'q', [anchor]);
  const planner = buildPlannerEnvelope(PROJECT, 'q', [anchor]);

  // Same dataset payload on both paths — the AXI-1603 harness used to narrow it
  // to `{ name, type }` and drop the category domains the compiled arm validates
  // filter/group values against.
  assert.deepEqual(governed.datasets, planner.datasets);
  for (const envelope of [governed, planner]) {
    const [ds] = envelope.datasets;
    assert.equal(ds.versionHash, HASH);
    assert.deepEqual(
      ds.columns.find((c) => c.name === 'response')?.categories,
      ['NR', 'R'],
      'the observed categorical domain reaches the planner on both paths',
    );
  }
});

test('UT-ANCHOR-1662-3: the anchored dataset names itself with `displayName`, not the deprecated `name`', async () => {
  const api = stubApi({ list: [listRow()], query: { body: REAL_SLICE }, profile: { body: REAL_PROFILE } });
  const anchor = await anchorDataset(api, WS, PROJECT);
  assert.equal(anchor?.displayName, 'riaz2017_expression_by_response_timepoint.csv');
  // `PlannerDatasetSchema` puts the filename ONLY in `displayName` (FR2);
  // `displayNameOf()` still accepts a legacy `name`, but the harness should not
  // be the last thing keeping that fallback alive.
  assert.equal((anchor as unknown as Record<string, unknown>).name, undefined);
});

test('UT-ANCHOR-1662-4: the shared resolver contains no silent catch and no substituted hash — every degraded path is a throw', () => {
  const code = codeOf(SHARED_RESOLVER);
  // The one `catch` this module is allowed is `snippet()`'s JSON.stringify guard,
  // which formats a failure message and cannot mask a missing schema.
  const catches = code.match(/catch\s*(?:\([^)]*\))?\s*\{/g) ?? [];
  assert.equal(catches.length, 1, `unexpected catch blocks in the shared resolver: ${catches.length}`);
  assert.doesNotMatch(code, /sha256:unknown/, 'the resolver must never name a substitute hash in code');
  assert.doesNotMatch(code, /columns\s*\?\?\s*\[\]/, 'the resolver must never fall back to an empty column list');
});

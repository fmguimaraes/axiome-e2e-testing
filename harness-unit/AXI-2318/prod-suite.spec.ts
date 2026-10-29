import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ProdSuiteAbort } from '../../tests/AXI-2309/harness/prod-suite/abort';
import { createApiClient, ForbiddenReferenceError, type ApiResponse, type Transport } from '../../tests/AXI-2309/harness/prod-suite/api-client';
import { recordOnlyExecutor, runCases } from '../../tests/AXI-2309/harness/prod-suite/cases';
import { prodSuiteEnabled, readProdSuiteConfig, safeRunId, type ProdSuiteConfig } from '../../tests/AXI-2309/harness/prod-suite/config';
import { expectedRawFileHash, fixtureBytes, parseFixtureIds, provisionFixtures, PROD_SUITE_FIXTURES, resolveFixtures } from '../../tests/AXI-2309/harness/prod-suite/fixtures';
import { assertConfined, isForbiddenOrg, verifyIsolation } from '../../tests/AXI-2309/harness/prod-suite/isolation-guard';
import { findSecretShapes, planPublication, repoDirFor, s3KeyFor, safePrefix, stageForRepo, writePublicationPlan } from '../../tests/AXI-2309/harness/prod-suite/publish';
import { buildReport, renderReportMarkdown, serializeReport, writeReport, type ProdSuiteReport } from '../../tests/AXI-2309/harness/prod-suite/report';
import { buildRunPlan, fetchActiveCatalogue, PAUL_OPERATIONS, type CatalogueRule } from '../../tests/AXI-2309/harness/prod-suite/run-plan';
import { configAbortReport, runProdSuite } from '../../tests/AXI-2309/harness/prod-suite/suite';

/**
 * UT-PRODE2E-6000 .. UT-PRODE2E-6038 (epic AXI-2309 — AXI-2318, SI-042).
 * Pure unit coverage of the prod E2E daily-suite harness: configuration, the
 * EC9 isolation guard + request tripwire, fixtures by ID (FR29), the FR30 run
 * order, the case seam, the deterministic report (FR33/NFR6) and its
 * publication (S3 keys, secret scan). HTTP is a scripted fake transport — no
 * network, no browser. Run via `npm run harness:unit`. See `UT.md`.
 */

// ── fakes ────────────────────────────────────────────────────────────────

type Route = (method: string, url: string, data?: unknown) => ApiResponse | undefined;

interface FakeHttp {
  transport: Transport;
  calls: Array<{ method: string; url: string; data?: unknown }>;
}

function fakeHttp(...routes: Route[]): FakeHttp {
  const calls: FakeHttp['calls'] = [];
  const transport: Transport = async (method, url, _headers, data) => {
    calls.push({ method, url, data });
    for (const route of routes) {
      const res = route(method, url, data);
      if (res) return res;
    }
    return { status: 404, body: {} };
  };
  return { transport, calls };
}

const on = (method: string, fragment: string, body: unknown, status = 200): Route =>
  (m, url) => (m === method && url.includes(fragment) ? { status, body } : undefined);

const ORG = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const DS1 = '33333333-3333-4333-8333-333333333333';
const DS2 = '44444444-4444-4444-8444-444444444444';
const OTHER_ORG = '55555555-5555-4555-8555-555555555555';

const client = (http: FakeHttp, forbiddenIds: string[] = []) =>
  createApiClient({ apiBaseUrl: 'http://api.test', token: 't', workspaceId: WS, forbiddenIds }, http.transport);

const orgsPage = (orgs: Array<{ id: string; name: string; slug?: string }>) =>
  on('GET', '/api/v1/organizations', { data: orgs, meta: { hasNextPage: false } });
const workspace = (ownerOrganizationId: string) => on('GET', `/api/v1/workspaces/${WS}`, { id: WS, ownerOrganizationId });

const bytesOf = (key: string) => Buffer.from(`fixture-${key}\n`);
const hashOf = (key: string) => expectedRawFileHash(bytesOf(key));
const readFake = (spec: { key: string }) => bytesOf(spec.key);
const FIXTURE_IDS = JSON.stringify({ tableau1: DS1, tableau2: DS2 });

const datasetRoute = (id: string, key: string, over: Record<string, unknown> = {}): Route =>
  on('GET', `/datasets/${id}`, { id, workspaceId: WS, deletedAt: null, rawFileHash: hashOf(key), ...over });

const rule = (id: string, code: string, operationId: string | null): CatalogueRule =>
  ({ id, code, operationId, runKind: null, runnable: true });

const baseConfig = (over: Partial<ProdSuiteConfig> = {}): ProdSuiteConfig => ({
  apiBaseUrl: 'http://api.test', email: 'e', password: 'p', organizationId: ORG, workspaceId: WS,
  fixtureIdsJson: FIXTURE_IDS, forbiddenOrgIds: [], targetLabel: 'unit', runId: 'run-1', gitSha: null, trigger: 'unit', ...over,
});

async function rejectsAbort(p: Promise<unknown>, code: string): Promise<ProdSuiteAbort> {
  const err = await p.then(() => null, (e: unknown) => e);
  assert.ok(err instanceof ProdSuiteAbort, `expected ProdSuiteAbort, got ${String(err)}`);
  assert.equal((err as ProdSuiteAbort).code, code);
  return err as ProdSuiteAbort;
}

function sampleReport(over: Partial<ProdSuiteReport['run']> = {}, abort: ProdSuiteReport['abort'] = null): ProdSuiteReport {
  const plan = buildRunPlan([rule('r2', 'B', 'stats.correlation'), rule('r1', 'A', null)]);
  const cases = plan.cases.map((c) => ({ ...c, outcome: 'not-evaluated' as const, reason: 'x', facts: { b: 1, a: 'z' } }));
  return buildReport({
    run: { runId: 'run-1', trigger: 'unit', gitSha: null, targetLabel: 'unit', startedAt: '2026-10-29T03:17:00.000Z', finishedAt: '2026-10-29T03:20:00.000Z', ...over },
    abort, testOrg: { organizationId: ORG, workspaceId: WS },
    fixtures: [{ key: 'tableau2', datasetId: DS2, rawFileHash: hashOf('tableau2') }, { key: 'tableau1', datasetId: DS1, rawFileHash: hashOf('tableau1') }],
    plan, cases,
  });
}

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ut-prode2e-'));

// ── configuration ───────────────────────────────────────────────────────

test('UT-PRODE2E-6000: a config with nothing set names EVERY missing variable at once', () => {
  const result = readProdSuiteConfig({});
  assert.equal(result.ok, false);
  assert.deepEqual(!result.ok && result.missing, ['API_BASE_URL', 'PROD_E2E_TEST_EMAIL', 'PROD_E2E_TEST_PASSWORD', 'PROD_E2E_ORG_ID', 'PROD_E2E_WORKSPACE_ID', 'PROD_E2E_FIXTURE_IDS']);
});

test('UT-PRODE2E-6001: a full config parses, trims the API origin and splits the forbidden-id list', () => {
  const result = readProdSuiteConfig({
    API_BASE_URL: 'https://api.example/', PROD_E2E_TEST_EMAIL: 'e', PROD_E2E_TEST_PASSWORD: 'p', PROD_E2E_ORG_ID: ORG,
    PROD_E2E_WORKSPACE_ID: WS, PROD_E2E_FIXTURE_IDS: '{}', PROD_E2E_FORBIDDEN_ORG_IDS: ` ${OTHER_ORG}, x ,`, PROD_E2E_RUN_ID: '42-1',
  });
  assert.ok(result.ok);
  assert.equal(result.config.apiBaseUrl, 'https://api.example');
  assert.deepEqual(result.config.forbiddenOrgIds, [OTHER_ORG, 'x']);
  assert.equal(result.config.runId, '42-1');
});

test('UT-PRODE2E-6002: a run id that is not a safe path segment is refused; an empty one gets a local id', () => {
  assert.throws(() => safeRunId('../etc', new Date()), /unsafe/);
  assert.throws(() => safeRunId('a/b', new Date()), /unsafe/);
  assert.match(safeRunId('', new Date('2026-10-29T00:00:00Z')), /^local-2026-10-29T00-00-00-000Z$/);
});

test('UT-PRODE2E-6003: the daily suite is enabled only by PROD_E2E_SUITE=1|true', () => {
  assert.equal(prodSuiteEnabled({}), false);
  assert.equal(prodSuiteEnabled({ PROD_E2E_SUITE: '0' }), false);
  assert.equal(prodSuiteEnabled({ PROD_E2E_SUITE: 'yes' }), false);
  assert.equal(prodSuiteEnabled({ PROD_E2E_SUITE: '1' }), true);
  assert.equal(prodSuiteEnabled({ PROD_E2E_SUITE: 'TRUE' }), true);
});

// ── EC9 tripwire + client ───────────────────────────────────────────────

test('UT-PRODE2E-6004: a request whose path names a forbidden org id is refused BEFORE the transport is called', async () => {
  const http = fakeHttp();
  await assert.rejects(client(http, [OTHER_ORG]).get(`/api/v1/organizations/${OTHER_ORG.toUpperCase()}`), ForbiddenReferenceError);
  assert.equal(http.calls.length, 0);
});

test('UT-PRODE2E-6005: a request whose BODY names a forbidden org id is refused before sending', async () => {
  const http = fakeHttp();
  await assert.rejects(client(http, [OTHER_ORG]).post('/api/v1/x', { organizationId: OTHER_ORG }), ForbiddenReferenceError);
  assert.equal(http.calls.length, 0);
});

test('UT-PRODE2E-6006: the client sends the bearer + workspace headers, and no Authorization header without a token', async () => {
  const seen: Array<Record<string, string>> = [];
  const transport: Transport = async (_m, _u, headers) => { seen.push(headers); return { status: 200, body: {} }; };
  await createApiClient({ apiBaseUrl: 'http://a/', token: 'tok', workspaceId: WS }, transport).get('/x');
  await createApiClient({ apiBaseUrl: 'http://a', token: '' }, transport).get('x');
  assert.deepEqual(seen[0], { Authorization: 'Bearer tok', 'X-Workspace-Id': WS });
  assert.deepEqual(seen[1], {});
});

// ── EC9 isolation guard ─────────────────────────────────────────────────

test('UT-PRODE2E-6007: exactly one visible org, the configured one, passes the confinement check', () => {
  assert.doesNotThrow(() => assertConfined([{ id: ORG, name: 'E2E test org', slug: null }], ORG, []));
});

test('UT-PRODE2E-6008: a visible CeRAINOM-IgG4 org is FORBIDDEN_ORG_VISIBLE, even when it is the configured one', () => {
  const paul = { id: ORG, name: 'CeRAINOM-IgG4', slug: null };
  assert.throws(() => assertConfined([paul], ORG, []), (e: unknown) => e instanceof ProdSuiteAbort && e.code === 'FORBIDDEN_ORG_VISIBLE');
});

test('UT-PRODE2E-6009: an identity seeing more than one org is IDENTITY_NOT_CONFINED', () => {
  const orgs = [{ id: ORG, name: 'test', slug: null }, { id: OTHER_ORG, name: 'Biotech One', slug: null }];
  assert.throws(() => assertConfined(orgs, ORG, []), (e: unknown) => e instanceof ProdSuiteAbort && e.code === 'IDENTITY_NOT_CONFINED');
});

test('UT-PRODE2E-6010: an identity seeing no org at all is IDENTITY_NOT_CONFINED, never a pass', () => {
  assert.throws(() => assertConfined([], ORG, []), (e: unknown) => e instanceof ProdSuiteAbort && e.code === 'IDENTITY_NOT_CONFINED');
});

test('UT-PRODE2E-6011: one visible org that is not PROD_E2E_ORG_ID is ORG_MISMATCH', () => {
  assert.throws(() => assertConfined([{ id: OTHER_ORG, name: 'x', slug: null }], ORG, []), (e: unknown) => e instanceof ProdSuiteAbort && e.code === 'ORG_MISMATCH');
});

test('UT-PRODE2E-6012: a configured org on the forbidden-id list aborts before ANY request is made', async () => {
  const http = fakeHttp(orgsPage([{ id: ORG, name: 'test' }]), workspace(ORG));
  await rejectsAbort(verifyIsolation(client(http), { organizationId: ORG, workspaceId: WS, forbiddenOrgIds: [ORG] }), 'CONFIGURED_ORG_FORBIDDEN');
  assert.equal(http.calls.length, 0);
});

test('UT-PRODE2E-6013: a workspace owned by another org is WORKSPACE_OUTSIDE_TEST_ORG', async () => {
  const http = fakeHttp(orgsPage([{ id: ORG, name: 'test' }]), workspace(OTHER_ORG));
  await rejectsAbort(verifyIsolation(client(http), { organizationId: ORG, workspaceId: WS, forbiddenOrgIds: [] }), 'WORKSPACE_OUTSIDE_TEST_ORG');
});

test('UT-PRODE2E-6014: forbidden-org matching is normalized over name AND slug, and exact on id', () => {
  assert.equal(isForbiddenOrg({ id: 'a', name: null, slug: 'aphm-cerainom-igg4' }, []), true);
  assert.equal(isForbiddenOrg({ id: 'a', name: 'cerainom igg4 (MAG4)', slug: null }, []), true);
  assert.equal(isForbiddenOrg({ id: OTHER_ORG, name: 'x', slug: null }, [OTHER_ORG.toUpperCase()]), true);
  assert.equal(isForbiddenOrg({ id: ORG, name: 'E2E AXI-2318 test org', slug: null }, [OTHER_ORG]), false);
});

// ── FR29 fixtures by ID ─────────────────────────────────────────────────

test('UT-PRODE2E-6015: PROD_E2E_FIXTURE_IDS that is not JSON is FIXTURE_IDS_MALFORMED', () => {
  assert.throws(() => parseFixtureIds('{nope'), (e: unknown) => e instanceof ProdSuiteAbort && e.code === 'FIXTURE_IDS_MALFORMED');
});

test('UT-PRODE2E-6016: a manifest key with no id, or a non-UUID id, is FIXTURE_ID_MISSING', () => {
  const missing = (raw: string) => () => parseFixtureIds(raw);
  const isMissing = (e: unknown) => e instanceof ProdSuiteAbort && e.code === 'FIXTURE_ID_MISSING';
  assert.throws(missing(JSON.stringify({ tableau1: DS1 })), isMissing);
  assert.throws(missing(JSON.stringify({ tableau1: DS1, tableau2: 'not-a-uuid' })), isMissing);
  assert.equal(parseFixtureIds(FIXTURE_IDS).get('tableau2'), DS2);
});

test('UT-PRODE2E-6017: a fixture id that does not resolve is FIXTURE_NOT_FOUND and nothing is uploaded', async () => {
  const http = fakeHttp(datasetRoute(DS1, 'tableau1'));
  await rejectsAbort(resolveFixtures(client(http), WS, FIXTURE_IDS, PROD_SUITE_FIXTURES, readFake), 'FIXTURE_NOT_FOUND');
  assert.ok(http.calls.every((c) => c.method === 'GET'), 'a daily run never POSTs/PATCHes a dataset');
});

test('UT-PRODE2E-6018: a dataset whose rawFileHash differs from the committed bytes is FIXTURE_HASH_MISMATCH', async () => {
  const http = fakeHttp(datasetRoute(DS1, 'tableau1'), datasetRoute(DS2, 'tableau2', { rawFileHash: hashOf('other') }));
  await rejectsAbort(resolveFixtures(client(http), WS, FIXTURE_IDS, PROD_SUITE_FIXTURES, readFake), 'FIXTURE_HASH_MISMATCH');
});

test('UT-PRODE2E-6019: a fixture dataset outside the test workspace, or deleted, is refused', async () => {
  const outside = fakeHttp(datasetRoute(DS1, 'tableau1', { workspaceId: 'elsewhere' }));
  await rejectsAbort(resolveFixtures(client(outside), WS, FIXTURE_IDS, PROD_SUITE_FIXTURES, readFake), 'FIXTURE_OUTSIDE_TEST_WORKSPACE');
  const deleted = fakeHttp(datasetRoute(DS1, 'tableau1', { deletedAt: '2026-10-01T00:00:00Z' }));
  await rejectsAbort(resolveFixtures(client(deleted), WS, FIXTURE_IDS, PROD_SUITE_FIXTURES, readFake), 'FIXTURE_DELETED');
});

test('UT-PRODE2E-6020: the committed fixtures are byte-identical to the Microbiote final reference set inputs', () => {
  const expected: Record<string, string> = {
    tableau1: 'sha256:bc98a928ef3bce6a44b8bb2a180e16fb24f20bb72710697dd1ef3169e3f64b36',
    tableau2: 'sha256:42fede8a595e05f09589910d5ba91f1602d4a5762c4f834de075d472743e3cbc',
  };
  for (const spec of PROD_SUITE_FIXTURES) assert.equal(expectedRawFileHash(fixtureBytes(spec)), expected[spec.key], spec.key);
});

test('UT-PRODE2E-6021: provisioning REUSES a dataset already holding the same bytes — no upload', async () => {
  const listing = on('GET', `/workspaces/${WS}/datasets?`, {
    data: [{ id: DS1, rawFileHash: hashOf('tableau1') }, { id: DS2, rawFileHash: hashOf('tableau2') }], meta: { hasNextPage: false },
  });
  const http = fakeHttp(listing);
  const ids = await provisionFixtures(client(http), { workspaceId: WS, organizationId: ORG }, { put: async () => 500 }, PROD_SUITE_FIXTURES, readFake);
  assert.deepEqual(ids, { tableau1: DS1, tableau2: DS2 });
  assert.ok(http.calls.every((c) => c.method === 'GET'));
});

test('UT-PRODE2E-6022: provisioning uploads a missing fixture once: initiate -> presigned PUT -> finalize', async () => {
  const listing = on('GET', `/workspaces/${WS}/datasets?`, { data: [{ id: DS1, rawFileHash: hashOf('tableau1') }], meta: { hasNextPage: false } });
  const init = on('POST', `/workspaces/${WS}/datasets`, { dataset: { id: DS2 }, presignedUrl: 'https://s3.test/put' }, 201);
  const fin = on('PATCH', `/datasets/${DS2}/finalize`, {});
  const http = fakeHttp(listing, init, fin);
  const puts: Array<{ url: string; bytes: string }> = [];
  const upload = { put: async (url: string, _ct: string, bytes: Buffer) => { puts.push({ url, bytes: bytes.toString() }); return 200; } };
  const ids = await provisionFixtures(client(http), { workspaceId: WS, organizationId: ORG }, upload, PROD_SUITE_FIXTURES, readFake);
  assert.deepEqual(ids, { tableau1: DS1, tableau2: DS2 });
  assert.deepEqual(puts, [{ url: 'https://s3.test/put', bytes: 'fixture-tableau2\n' }]);
  assert.deepEqual(http.calls.filter((c) => c.method !== 'GET').map((c) => c.method), ['POST', 'PATCH']);
});

// ── FR30 run plan ───────────────────────────────────────────────────────

test("UT-PRODE2E-6023: Paul's methods come first in PAUL_OPERATIONS order, then the rest by code", () => {
  const plan = buildRunPlan([
    rule('z', 'ZZ-OTHER', 'stats.chi_square'), rule('k', 'STAT-KRUSKAL-WALLIS', 'stats.kruskal_wallis'),
    rule('a', 'AA-QC', null), rule('d', 'STAT-DUNN-POSTHOC', 'stats.dunn_posthoc'),
  ]);
  assert.deepEqual(plan.cases.map((c) => [c.order, c.phase, c.id]), [
    [1, 'paul-methods', 'd'], [2, 'paul-methods', 'k'], [3, 'catalogue', 'a'], [4, 'catalogue', 'z'],
  ]);
});

test('UT-PRODE2E-6024: an empty catalogue is CATALOGUE_EMPTY — never a vacuous "full catalogue" pass', () => {
  assert.throws(() => buildRunPlan([]), (e: unknown) => e instanceof ProdSuiteAbort && e.code === 'CATALOGUE_EMPTY');
});

test('UT-PRODE2E-6025: duplicate rows collapse by id; every rule carrying a Paul operation runs; missing ones are listed', () => {
  const plan = buildRunPlan([
    rule('m2', 'STAT-MANN-WHITNEY-U', 'stats.mann_whitney_u'), rule('m1', 'STAT-MANN-WHITNEY-U', 'stats.mann_whitney_u'),
    rule('m1', 'STAT-MANN-WHITNEY-U', 'stats.mann_whitney_u'),
  ]);
  assert.deepEqual(plan.cases.map((c) => c.id), ['m1', 'm2']);
  assert.deepEqual(plan.missingPaulOperations, PAUL_OPERATIONS.filter((op) => op !== 'stats.mann_whitney_u'));
});

test('UT-PRODE2E-6026: the catalogue read pages through and keeps only published SYSTEM rules', async () => {
  const page1 = on('GET', 'page=1', { data: [{ id: 'a', code: 'A', scope: 'system', status: 'published' }, { id: 'b', code: 'B', scope: 'workspace', status: 'published' }], meta: { hasNextPage: true } });
  const page2 = on('GET', 'page=2', { data: [{ id: 'c', code: 'C', scope: 'system', status: 'draft' }, { id: 'd', code: 'D', scope: 'system', status: 'published', operationId: 'stats.correlation' }], meta: { hasNextPage: false } });
  const rules = await fetchActiveCatalogue(client(fakeHttp(page1, page2)));
  assert.deepEqual(rules.map((r) => [r.id, r.operationId]), [['a', null], ['d', 'stats.correlation']]);
});

// ── case seam ───────────────────────────────────────────────────────────

test('UT-PRODE2E-6027: cases run sequentially in plan order; a throwing case is recorded as error and the run continues', async () => {
  const plan = buildRunPlan([rule('b', 'B', null), rule('a', 'A', 'stats.correlation')]);
  const seen: string[] = [];
  const executor = async (c: { id: string }) => {
    seen.push(c.id);
    if (c.id === 'a') throw new Error('boom');
    return { outcome: 'pass' as const, reason: null, facts: { ok: true } };
  };
  const ctx = { client: client(fakeHttp()), organizationId: ORG, workspaceId: WS, fixtures: [] };
  const executed = await runCases([...plan.cases].reverse(), ctx, executor);
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(executed.map((c) => [c.id, c.outcome, c.reason]), [['a', 'error', 'boom'], ['b', 'pass', null]]);
});

test('UT-PRODE2E-6028: the placeholder executor records not-evaluated with a reason — never pass', async () => {
  const result = await recordOnlyExecutor({} as never, {} as never);
  assert.equal(result.outcome, 'not-evaluated');
  assert.match(result.reason ?? '', /AXI-2319/);
});

// ── FR33 / NFR6 report ──────────────────────────────────────────────────

test('UT-PRODE2E-6029: the report summarizes outcomes/phases and is aborted exactly when an abort is recorded', () => {
  const ok = sampleReport();
  assert.equal(ok.status, 'completed');
  assert.deepEqual(ok.summary, { total: 2, byOutcome: { pass: 0, fail: 0, error: 0, 'not-evaluated': 2 }, byPhase: { 'paul-methods': 1, catalogue: 1 } });
  const aborted = sampleReport({}, { phase: 'isolation', code: 'IDENTITY_NOT_CONFINED', message: 'm' });
  assert.equal(aborted.status, 'aborted');
});

test('UT-PRODE2E-6030: serialization is deterministic (fixtures sorted, facts key-sorted) and the Markdown derives from it', () => {
  const a = sampleReport();
  const b = sampleReport();
  assert.equal(serializeReport(a), serializeReport(b));
  assert.deepEqual(a.fixtures.map((f) => f.key), ['tableau1', 'tableau2']);
  assert.deepEqual(Object.keys(a.cases[0].facts), ['a', 'b']);
  assert.equal(renderReportMarkdown(a), renderReportMarkdown(JSON.parse(serializeReport(a))));
});

test('UT-PRODE2E-6031: a report built by the suite carries no URL, hostname or credential (NFR3)', async () => {
  const http = fakeHttp(orgsPage([{ id: ORG, name: 'test' }]), workspace(ORG));
  const report = await runProdSuite({ connect: async () => client(http), config: baseConfig({ fixtureIdsJson: '{' }) });
  const text = serializeReport(report);
  assert.doesNotMatch(text, /https?:\/\//);
  assert.doesNotMatch(text, /api\.test/);
  assert.deepEqual(findSecretShapes(text), []);
});

// ── publication ─────────────────────────────────────────────────────────

test('UT-PRODE2E-6032: the secret scanner names every token / credential shape and passes a clean report', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdEFGH';
  assert.deepEqual(findSecretShapes(`${jwt} Bearer abcdefgh123 AKIAABCDEFGHIJKLMNOP X-Amz-Signature=1 "password": "x"`),
    ['jwt', 'bearer', 'aws-access-key', 'presigned-url', 'password-field']);
  assert.deepEqual(findSecretShapes(serializeReport(sampleReport()) + renderReportMarkdown(sampleReport())), []);
});

test('UT-PRODE2E-6033: publication refuses a report carrying a secret, a wrong schema version or an unsafe run id', () => {
  const dir = tmp();
  try {
    writeReport(dir, sampleReport());
    writeFileSync(path.join(dir, 'report.md'), 'leak: Bearer abcdefghijkl');
    assert.throws(() => planPublication(dir, ''), /refusing to publish report\.md/);
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ ...sampleReport(), schemaVersion: 99 }));
    assert.throws(() => planPublication(dir, ''), /schemaVersion 99/);
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify(sampleReport({ runId: '../x' })));
    assert.throws(() => planPublication(dir, ''), /safe path segment/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('UT-PRODE2E-6034: S3 keys are <prefix>/<date>/<runId>/<file>, repo dir is reports/AXI-2318/<date>-prod-daily-<runId>', () => {
  const r = sampleReport();
  assert.equal(s3KeyFor('', r, 'report.json'), 'prod-e2e/daily/2026-10-29/run-1/report.json');
  assert.equal(s3KeyFor('/custom/p/', r, 'report.md'), 'custom/p/2026-10-29/run-1/report.md');
  assert.equal(repoDirFor(r), 'reports/AXI-2318/2026-10-29-prod-daily-run-1');
  assert.throws(() => safePrefix('a/../b'), /unsafe/);
  assert.throws(() => safePrefix('a b'), /unsafe/);
});

test('UT-PRODE2E-6035: a login failure is recorded as an aborted report (config/LOGIN_FAILED), not a missing one', async () => {
  const report = await runProdSuite({ connect: async () => { throw new Error('prod suite login failed -> HTTP 401'); }, config: baseConfig() });
  assert.equal(report.status, 'aborted');
  assert.deepEqual([report.abort?.phase, report.abort?.code], ['config', 'LOGIN_FAILED']);
});

test('UT-PRODE2E-6036: an isolation abort stops the run before any fixture or catalogue read', async () => {
  const http = fakeHttp(orgsPage([{ id: ORG, name: 'test' }, { id: OTHER_ORG, name: 'CeRAINOM-IgG4' }]), workspace(ORG));
  const report = await runProdSuite({ connect: async () => client(http), config: baseConfig() });
  assert.deepEqual([report.abort?.phase, report.abort?.code], ['isolation', 'FORBIDDEN_ORG_VISIBLE']);
  assert.ok(!http.calls.some((c) => c.url.includes('/datasets') || c.url.includes('/rules')));
  assert.equal(report.cases.length, 0);
});

test('UT-PRODE2E-6037: a run that cannot read its configuration still yields a report naming what is missing', () => {
  const report = configAbortReport(['PROD_E2E_ORG_ID'], { PROD_E2E_RUN_ID: '7-1' }, new Date('2026-10-29T03:17:00Z'));
  assert.equal(report.status, 'aborted');
  assert.deepEqual(report.abort, { phase: 'config', code: 'CONFIG_MISSING', message: 'missing: PROD_E2E_ORG_ID' });
  assert.equal(report.run.runId, '7-1');
});

test('UT-PRODE2E-6038: staging copies ONLY report.json + report.md and the plan lists exactly those two', () => {
  const src = tmp();
  const stage = tmp();
  try {
    writeReport(src, sampleReport());
    writeFileSync(path.join(src, 'trace.zip'), 'bearer-carrying trace');
    const { report, entries } = planPublication(src, '');
    const staged = stageForRepo(entries, report, stage);
    writePublicationPlan(entries, path.join(stage, 'publish-plan.tsv'));
    assert.deepEqual(readdirSync(staged).sort(), ['report.json', 'report.md']);
    const lines = readFileSync(path.join(stage, 'publish-plan.tsv'), 'utf8').trim().split('\n');
    assert.deepEqual(lines.map((l) => path.basename(l.split('\t')[0])), ['report.json', 'report.md']);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
});

/**
 * AXI-2663 (epic AXI-2630, FR73, FR74, AC54, AC55; SI-042). Stack-free proof of the reproduction
 * script: the comparison, the stop at the first differing value, the known residual, the start
 * conditions and the routes the script may never call.
 *
 * `recomputed-heatmap.json` is an independent scipy recomputation of the 42 cells from the two
 * reference files. It feeds these tests only; the script itself never reads it.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compareWithGolden, type Observed, type ObservedCell } from '../../tests/AXI-2630/reproduction/compare';
import { HEATMAP_CELLS, KNOWN_RESIDUAL } from '../../tests/AXI-2630/reproduction/golden';
import { EXIT_BLOCKED, StopRun, declareVariables, planQuestions, type Procedure } from '../../tests/AXI-2630/reproduction/procedure';
import { observedFrom, type ServedPages } from '../../tests/AXI-2630/reproduction/read-results';
import { EXIT_CONFIG, EXIT_OK, endingOf, runReproduction } from '../../tests/AXI-2630/reproduction/reproduce';
import { readReproductionConfig } from '../../tests/AXI-2630/reproduction/run-config';
import { Trace, writeTrace } from '../../tests/AXI-2630/reproduction/trace';

interface Recomputed { reference: string; variable: string; rho: number; qWithinReference: number; qAcrossAllCells: number }

const here = path.dirname(new URL(import.meta.url).pathname);
const recomputed: Recomputed[] = JSON.parse(readFileSync(path.join(here, 'recomputed-heatmap.json'), 'utf8'));

function cellsWith(q: (r: Recomputed) => number): ObservedCell[] {
  return HEATMAP_CELLS.map((cell) => {
    const row = recomputed.find((r) => r.reference === cell.referenceLabel && r.variable === cell.variableLabel) as Recomputed;
    return { reference: cell.reference, variable: cell.variable, rho: row.rho, q: q(row) };
  });
}

function pair(stratum: string, other: string, adjustedP: number) {
  const nB = other === 'HD' || other === 'SD' ? 10 : 26;
  return { stratum, groupA: 'IgG4-RD', groupB: other, nA: 26, nB, adjustedP, adjustmentMethod: 'holm' };
}

function matching(): Observed {
  return {
    image1: {
      operationId: 'stats.dunn_posthoc', figure: true,
      pairs: [
        pair('ENT 059', 'HD', 0.02171), pair('ENT 059', 'SD', 0.02171),
        pair('CER 229', 'HD', 0.03779), pair('CER 229', 'SD', 0.03779),
        pair('CER 215 et 234', 'HD', 0.4372), pair('CER 215 et 234', 'SD', 0.3246),
      ],
    },
    image2: { operationId: 'stats.kruskal_wallis', figure: true, n: 23, groups: 4, h: 4.870814836377756, p: 0.18150483448969706 },
    image3: { operationId: 'stats.mann_whitney_u', figure: true, nFrom: 9, nTo: 14, u: 77.5, p: 0.37051184565070394 },
    image4: {
      operationId: 'stats.correlation_matrix', figure: true, method: 'spearman', familyScope: 'per_reference',
      cells: cellsWith((r) => r.qWithinReference),
    },
  };
}

const residualCell = (o: Observed) =>
  o.image4.cells.find((c) => c.reference === KNOWN_RESIDUAL.reference && c.variable === KNOWN_RESIDUAL.variable) as ObservedCell;

test('UT-REPRO-2663-001 matching values pass, and the run ends with exit 0', () => {
  const comparison = compareWithGolden(matching());

  assert.equal(comparison.verdict, 'all-match');
  assert.equal(comparison.firstMismatch, null);
  assert.equal(endingOf(comparison).exitCode, EXIT_OK);
});

test('UT-REPRO-2663-002 one altered value stops the run and names the value, expected and actual', () => {
  const observed = matching();
  observed.image1.pairs[0].adjustedP = 0.0227;

  const comparison = compareWithGolden(observed);
  const ending = endingOf(comparison);

  assert.equal(comparison.firstMismatch?.id, 'image-1.ENT 059.IgG4-RD-vs-HD.adjusted-p');
  assert.equal(comparison.firstMismatch?.actual, '0.0227');
  assert.equal(ending.exitCode, 1);
  assert.match(ending.message, /ENT 059.*0\.0217.*0\.0227/);
});

test('UT-REPRO-2663-003 nothing after the first mismatch is reported as compared', () => {
  const observed = matching();
  observed.image2.h = 4.9;

  const comparison = compareWithGolden(observed);

  assert.equal(comparison.results.at(-1)?.id, 'image-2.H');
  assert.equal(comparison.results.some((r) => r.id.startsWith('image-3')), false);
});

test('UT-REPRO-2663-004 Mann-Whitney p 0.37051 passes: the Reference check reads the unrounded result', () => {
  const observed = matching();
  observed.image3.p = 0.37051;

  assert.equal(compareWithGolden(observed).verdict, 'all-match');
});

test('UT-REPRO-2663-005 p 0.37049 equals 0.3705 at 4 decimals but rounds to 0.370, so it stops', () => {
  const observed = matching();
  observed.image3.p = 0.37049;

  assert.equal(compareWithGolden(observed).firstMismatch?.id, 'image-3.p');
});

test('UT-REPRO-2663-006 H is compared at the 3 decimals section 20 gives, with no Reference check', () => {
  const observed = matching();
  observed.image2.h = 4.8714;

  assert.equal(compareWithGolden(observed).verdict, 'all-match');
  observed.image2.h = 4.8716;
  assert.equal(compareWithGolden(observed).firstMismatch?.id, 'image-2.H');
});

test('UT-REPRO-2663-007 the known residual is reported as such, not as a match', () => {
  const comparison = compareWithGolden(matching());

  assert.equal(comparison.knownResiduals.length, 1);
  assert.equal(comparison.knownResiduals[0].id, 'image-4.MAG4-22 x IgG4-RD RI.rho');
  assert.equal(comparison.knownResiduals[0].actual, '0.49');
  assert.equal(comparison.knownResiduals[0].expected, '0.50');
  assert.match(endingOf(comparison).message, /Known residual: image-4\.MAG4-22 x IgG4-RD RI\.rho reads 0\.49 against 0\.50/);
});

test('UT-REPRO-2663-008 the residual cell at any other value stops the run', () => {
  const observed = matching();
  residualCell(observed).rho = 0.48;

  assert.equal(compareWithGolden(observed).firstMismatch?.id, 'image-4.MAG4-22 x IgG4-RD RI.rho');
});

test('UT-REPRO-2663-009 the residual allowance is not granted to any other cell', () => {
  const observed = matching();
  const other = observed.image4.cells[0];
  other.rho = (other.rho as number) - 0.01;

  const comparison = compareWithGolden(observed);

  assert.equal(comparison.firstMismatch?.id, 'image-4.CER228 x sIgG4.rho');
  assert.equal(comparison.knownResiduals.length, 0);
});

test('UT-REPRO-2663-010 a run adjusted across all 42 cells stops at the family scope it recorded', () => {
  const observed = matching();
  observed.image4.familyScope = 'global';

  const miss = compareWithGolden(observed).firstMismatch;

  assert.equal(miss?.id, 'image-4.family-scope');
  assert.equal(miss?.expected, 'per_reference');
  assert.equal(miss?.actual, 'global');
});

test('UT-REPRO-2663-011 with no recorded scope, q-values adjusted across all cells stop at the lost star', () => {
  const observed = matching();
  observed.image4.familyScope = undefined;
  observed.image4.cells = cellsWith((r) => r.qAcrossAllCells);

  const miss = compareWithGolden(observed).firstMismatch;

  assert.equal(miss?.id, 'image-4.CER215+234 x TFH.star');
  assert.match(String(miss?.actual), /^no star/);
});

test('UT-REPRO-2663-012 a value the result does not carry stops the run as absent', () => {
  const observed = matching();
  observed.image3.u = undefined;

  const miss = compareWithGolden(observed).firstMismatch;

  assert.equal(miss?.id, 'image-3.U');
  assert.equal(miss?.actual, 'absent from the result');
});

test('UT-REPRO-2663-013 result pages are read into the compared values, numeric strings included', () => {
  const pages = {
    'image-1': { results: [{ operationId: 'stats.dunn_posthoc', chart: {}, rows: [{ feature: 'ENT 059', groupA: 'HD', groupB: 'IgG4-RD', nGroupA: 10, nGroupB: 26, adjustedPValue: '0.0217', adjustmentMethod: 'holm' }] }] },
    'image-2': { results: [{ operationId: 'stats.kruskal_wallis', chart: {}, rows: [{ n: 23, nGroups: 4, hStatistic: 4.87, pValue: 0.18 }] }] },
    'image-3': { results: [{ operationId: 'stats.mann_whitney_u', chart: null, rows: [{ nGroupFrom: 9, nGroupTo: 14, uStatistic: 77.5, pValue: 0.37 }] }] },
    'image-4': { results: [{ operationId: 'stats.correlation_matrix', chart: {}, chartWithheld: 'refused', run: { operationParams: { method: 'spearman', familyScope: 'global' } }, rows: [{ reference: 'a', variable: 'b', rho: 0.5, qValue: 0.01 }] }] },
  } as ServedPages;

  const observed = observedFrom(pages);

  assert.equal(observed.image1.pairs[0].adjustedP, 0.0217);
  assert.equal(observed.image2.h, 4.87);
  assert.equal(observed.image3.figure, false);
  assert.equal(observed.image4.figure, false);
  assert.equal(observed.image4.familyScope, 'global');
});

test('UT-REPRO-2663-014 a test result with several rows is not read as a single value', () => {
  const page = { results: [{ operationId: 'stats.kruskal_wallis', rows: [{ hStatistic: 1 }, { hStatistic: 2 }] }] };
  const pages = { 'image-1': {}, 'image-2': page, 'image-3': {}, 'image-4': {} } as ServedPages;

  assert.equal(observedFrom(pages).image2.h, undefined);
});

const FULL_ENV = {
  BASE_URL: 'http://localhost:5174', API_BASE_URL: 'http://localhost:3001', HANDOVER_WORKSPACE_ID: 'ws',
  E2E_INVESTIGATOR_PASSWORD: 'from-env-1', HANDOVER_PROVISIONER_EMAIL: 'p@example.test',
  HANDOVER_PROVISIONER_PASSWORD: 'from-env-2', GUIDED_ANALYSIS_LLM_TRANSPORT: 'recorded',
};

test('UT-REPRO-2663-015 a complete environment starts, with reports under reports/AXI-2630', () => {
  const parsed = readReproductionConfig(FULL_ENV);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.config.reportRoot, 'reports/AXI-2630');
});

for (const name of ['E2E_INVESTIGATOR_PASSWORD', 'HANDOVER_PROVISIONER_EMAIL', 'HANDOVER_PROVISIONER_PASSWORD']) {
  test(`UT-REPRO-2663-016 ${name} has no default: without it the run does not start`, () => {
    const parsed = readReproductionConfig({ ...FULL_ENV, [name]: undefined });

    assert.equal(parsed.ok, false);
    assert.match(JSON.stringify(!parsed.ok && parsed.problems), new RegExp(name));
  });
}

for (const [name, url] of [['API_BASE_URL', 'http://localhost:3000'], ['BASE_URL', 'http://localhost:5173']]) {
  test(`UT-REPRO-2663-017 ${name} on the shared demo port is refused`, () => {
    const parsed = readReproductionConfig({ ...FULL_ENV, [name]: url });

    assert.equal(parsed.ok, false);
    assert.match(JSON.stringify(!parsed.ok && parsed.problems), /shared demo stack/);
  });
}

test('UT-REPRO-2663-018 a transport other than recorded is refused', () => {
  const parsed = readReproductionConfig({ ...FULL_ENV, GUIDED_ANALYSIS_LLM_TRANSPORT: 'live' });

  assert.equal(parsed.ok, false);
  assert.match(JSON.stringify(!parsed.ok && parsed.problems), /recorded/);
});

test('UT-REPRO-2663-019 an empty environment exits 2 with a clear message and writes no report', async () => {
  const outcome = await runReproduction({}, tmpdir());

  assert.equal(outcome.exitCode, EXIT_CONFIG);
  assert.equal(outcome.reportDir, null);
  assert.match(outcome.message, /E2E_INVESTIGATOR_PASSWORD is not set/);
});

const SOURCES = ['compare', 'golden', 'procedure', 'read-results', 'reproduce', 'run', 'run-config', 'trace'];
const sourceOf = (name: string) => readFileSync(path.join(here, '../../tests/AXI-2630/reproduction', `${name}.ts`), 'utf8');
const codeOf = (name: string) =>
  sourceOf(name).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^import .*$/gm, '');

test('UT-REPRO-2663-020 the script calls no approval, sign-off, signing or publication route', () => {
  const forbidden = /\/(approve|approval|sign|sign-off|signoff|publish|accept|decisions?|interpretations?)\b/i;

  for (const name of SOURCES) assert.equal(forbidden.test(codeOf(name)), false, name);
});

test('UT-REPRO-2663-021 the script loads no env file, salts no upload and writes no database', () => {
  const forbidden = /dotenv|\.env['"`]|saltedVariant|prisma|psql|\bpg\b/i;

  for (const name of SOURCES) assert.equal(forbidden.test(codeOf(name)), false, name);
});

test('UT-REPRO-2663-022 the trace is written under its slug, as text, and never as trace.zip', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'axi2663-'));
  const trace = new Trace();
  trace.record('6 finalise', { sapVersionId: '11111111-2222-3333-4444-555555555555', configVersion: `p@1.0.0+sha256:${'a'.repeat(64)}` });

  const dir = writeTrace(root, '2026-11-18-mag4-reproduction-test', trace, { exitCode: 0, verdict: 'ALL VALUES MATCH', message: 'ok' });

  assert.deepEqual(readdirSync(dir).sort(), ['REPORT.md', 'trace.json']);
  rmSync(root, { recursive: true });
});

test('UT-REPRO-2663-023 a trace holding a bearer token is refused before anything is written', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'axi2663-'));
  const trace = new Trace();
  trace.record('leak', { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVl' });

  assert.throws(() => writeTrace(root, 'slug', trace, { exitCode: 0, verdict: 'x', message: 'y' }), /secret-shaped/);
  assert.equal(existsSync(path.join(root, 'slug')), false);
  rmSync(root, { recursive: true });
});

function fakeProcedure(answers: Record<string, { status: number; body: unknown }>): Procedure {
  const answer = async (url: string) => {
    const key = Object.keys(answers).find((k) => url.endsWith(k));
    return key ? answers[key] : { status: 200, body: {} };
  };
  const client = { get: answer, post: answer, put: answer, patch: answer } as unknown as Procedure['actors']['investigator'];
  const preset = JSON.parse(readFileSync(path.join(here, '../../fixtures/handover/mag4-new-model-preset.json'), 'utf8'));
  return {
    actors: { investigator: client, provisioner: client, workspaceId: 'ws', organizationId: 'org' },
    trace: new Trace(), preset, repoRoot: '', token: 't', projectId: 'p', sapId: 's', sapVersionId: 'v', revision: 1,
    fieldIdByName: new Map(preset.dataSpecification.fields.map((f: { name: string }) => [f.name, `id-${f.name}`])),
    questionIdByKey: new Map(), runIdByKey: new Map(),
  };
}

const extensionFieldsFor = (p: Procedure) =>
  p.preset.dataSpecification.fields.filter((f) => f.canonicalFieldSource === 'extension').map((f) => `project.p.${f.canonicalField}`);

test('UT-REPRO-2663-024 the variables step stops as blocked by AXI-2587 when its route is not served', async () => {
  const p = fakeProcedure({});
  const contract = { status: 200, body: { canonicalFields: extensionFieldsFor(p), profile: { configVersion: 'x+sha256:ab' } } };
  const blocked = fakeProcedure({ '/extensions': { status: 201, body: {} }, '/sap-standard-fields': { status: 404, body: {} }, '/semantic-contract': contract });

  await assert.rejects(declareVariables(blocked), (e: StopRun) => e.exitCode === EXIT_BLOCKED && /AXI-2587/.test(e.message));
});

test('UT-REPRO-2663-025 question planning stops as blocked by AXI-2590 when no workflow is served', async () => {
  const p = fakeProcedure({});
  const catalog = p.preset.questions.map((q) => ({ ...q.template }));
  const blocked = fakeProcedure({ '/sap-templates': { status: 200, body: catalog } });

  await assert.rejects(planQuestions(blocked), (e: StopRun) => e.exitCode === EXIT_BLOCKED && /AXI-2590/.test(e.message));
});

test('UT-REPRO-2663-026 the golden table holds 42 cells, 15 stars and one residual', () => {
  const residuals = HEATMAP_CELLS.filter((c) => c.reference === KNOWN_RESIDUAL.reference && c.variable === KNOWN_RESIDUAL.variable);

  assert.equal(HEATMAP_CELLS.length, 42);
  assert.equal(HEATMAP_CELLS.filter((c) => c.star).length, 15);
  assert.equal(residuals.length, 1);
  assert.equal(residuals[0].rho, KNOWN_RESIDUAL.slideRho);
});

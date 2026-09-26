import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, E2E_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1690 - B.W2 Honest gate and ledger (epic AXI-1687, area B).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md`
 * section 4.5 to 4.7 and 5.4, 5.5.
 *
 * HARD RULE FOR THIS FILE (NFR1, zero LLM spend): no scenario opens the planner, calls the
 * API or reaches any endpoint that could touch the platform's Anthropic key. The gate has no
 * browser surface: its facts are FILES (the authored ledger, the frozen corpora, the registry,
 * the CI workflow) and the OFFLINE Jest suites that score the frozen 2026-09-26 corpus.
 * `E2E_LIVE_LLM` is never read here. Ledger values the owner may re-sign are asserted by
 * INVARIANT only, except the Phase-1 planned set, which FR12 fixes.
 */

const GA = 'apps/organization-service/src/guided-analysis';
const LEDGER = () => path.join(BACK_ROOT as string, GA, 'plan/compile/__fixtures__/grados-gate-ledger.json');
const BANK = () => path.join(BACK_ROOT as string, GA, 'plan/compile/__fixtures__/grados-golden-intents.ts');
const CORPUS = () => path.join(BACK_ROOT as string, GA, 'shadow-run/__fixtures__/runs/2026-09-26');
const REGISTRY = () => path.join(BACK_ROOT as string, GA, 'shadow-run/runs/REGISTRY.md');
const CI_YML = () => path.join(BACK_ROOT as string, '.github/workflows/ci.yml');
const PATTERNS = () => path.join(BACK_ROOT as string, 'libs/contracts/src/guided-analysis/analysis-intent.patterns.ts');

const JEST_GATE_SUITES = [
  `${GA}/shadow-run/gate/gate.spec.ts`,
  `${GA}/shadow-run/run-registry.spec.ts`,
  `${GA}/plan/compile/terminal-refusals.spec.ts`,
  `${GA}/plan/compile/grados-golden.spec.ts`,
  `${GA}/plan/compiled-planner.adapter.spec.ts`,
];

function requireBack(): void {
  const missing = missingRepos(['back']);
  test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')} - set AXIOME_*_ROOT`);
}

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test-results' || name === 'playwright-report') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function runJest(suites: readonly string[]): { status: number | null; summary: string } {
  const r = spawnSync('npx', ['jest', ...suites, '--silent'], {
    cwd: BACK_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', E2E_LIVE_LLM: '' },
    timeout: 5 * 60_000,
  });
  return { status: r.status, summary: `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '') };
}

test.describe('AXI-1690 s4.5 - the ledger is authored, complete and typed (AC11, AC12, AC133)', { tag: ['@SI-045'] }, () => {
  test('AC133 AC11 AC12: 46 unique typed rows, Phase-1 planned set fixed, no generator, bank verdicts stay in the back repo', async () => {
    requireBack();
    const ledger = readJson(LEDGER());

    // AC133: every row carries exactly one declared type; every type states outcome and route.
    expect(ledger.rows).toHaveLength(46);
    const ids = ledger.rows.map((r: { bankId: string }) => r.bankId);
    expect(new Set(ids).size).toBe(46);
    expect(ids).toEqual(Array.from({ length: 46 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}`));
    const typeIds = new Set<string>(ledger.types.map((t: { id: string }) => t.id));
    for (const row of ledger.rows) expect(typeIds.has(row.questionType), `${row.bankId} names a declared type`).toBe(true);
    for (const t of ledger.types) {
      expect(['planned', 'gap', 'routed_none']).toContain(t.outcome);
      expect(Object.keys(t)).toContain('route');
      if (t.outcome === 'routed_none') expect(t.route, `${t.id} names its route`).toBeTruthy();
    }
    for (const row of ledger.rows) {
      if (row.verdict === 'planned') expect(row.coverage, `${row.bankId} carries coverage`).toBeTruthy();
      if (row.verdict === 'gap') expect(row.expectedGap?.length, `${row.bankId} carries an alternative`).toBeGreaterThan(0);
    }

    // AC12: FR12 fixes the Phase-1 planned set.
    const planned = ledger.rows.filter((r: { verdict: string }) => r.verdict === 'planned').map((r: { bankId: string }) => r.bankId);
    expect(planned).toEqual(['Q06', 'Q13', 'Q21', 'Q22', 'Q29']);
    expect(ledger.rows.filter((r: { verdict: string }) => r.verdict === 'gap')).toHaveLength(41);

    // AC11: nothing generates the ledger.
    const writers = walk(path.join(BACK_ROOT as string, 'apps'))
      .concat(walk(path.join(BACK_ROOT as string, 'libs')))
      .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.spec.ts'))
      .filter((f) => /(writeFileSync|writeFile)\([^)]*grados-gate-ledger/.test(readFileSync(f, 'utf8')));
    expect(writers).toEqual([]);

    // AC10: every bank row carries verdictByPhase (P1..P4) and a why; the e2e repo exports no verdict.
    const bank = readFileSync(BANK(), 'utf8');
    expect(bank).toMatch(/verdictByPhase: \{ P1: p1, P2: p1, P3: p3, P4: p3 \}/);
    expect(bank).toMatch(/GATE_PHASES = \['P1', 'P2', 'P3', 'P4'\]/);
    const leaked = walk(path.join(E2E_ROOT, 'tests'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('AXI-1690-honest-gate.spec.ts'))
      .filter((f) => readFileSync(f, 'utf8').includes('verdictByPhase'));
    expect(leaked).toEqual([]);
  });
});

test.describe('AXI-1690 s4.6 - the honest gate fails the frozen replay on purpose (AC13..AC20, AC132)', { tag: ['@SI-045'] }, () => {
  test('AC20 AC132 AC13 AC14 AC15 AC16 AC17 AC19: corpus well-formed and joinable; the offline gate suites are green - zero LLM calls', async () => {
    requireBack();
    test.setTimeout(8 * 60_000); // ts-jest cold compile of five suites

    const harness = readJson(path.join(CORPUS(), 'harness.json')).rows;
    const plans = readJson(path.join(CORPUS(), 'plans.json')).rows;
    expect(harness).toHaveLength(46);
    const byCorrelation = new Map<string, number>();
    for (const p of plans) byCorrelation.set(p.correlationId, (byCorrelation.get(p.correlationId) ?? 0) + 1);
    for (const h of harness) {
      expect(h.bank_question_id, 'joins on the bank id, never on question_number').toMatch(/^Q\d{2}$/);
      expect(byCorrelation.get(h.correlationId), `${h.bank_question_id} joins exactly one plan row`).toBe(1);
      expect(Object.keys(h)).not.toContain('question_number');
    }
    // NFR3: ids, hashes and vocabulary only - no question text and no model prose in a corpus row.
    const raw = JSON.stringify([harness, plans]);
    for (const banned of ['"text"', '"explanation"', '"question"', '"stepLabel"', '"why"', '"clinicalQuestion"'])
      expect(raw, `corpus carries no ${banned}`).not.toContain(banned);
    const triples = readdirSync(path.join(BACK_ROOT as string, GA, 'plan/compile/__fixtures__/p9-corpus')).filter((f) => f.endsWith('.json'));
    expect(triples.length).toBeGreaterThan(0);

    const jest = runJest(JEST_GATE_SUITES);
    expect(jest.status, jest.summary.split('\n').filter((l) => /Tests:|Suites:|✕|●/.test(l)).join('\n')).toBe(0);
    expect(jest.summary).toMatch(/Test Suites: 5 passed, 5 total/);
    expect(jest.summary).not.toMatch(/Tests:.*\b(failed)\b/);
  });
});

test.describe('AXI-1690 s4.7 - the Phase-1 three-group overflow is terminal (AC117)', { tag: ['@SI-045'] }, () => {
  test('AC117: compare_groups is exactly two groups in the shape table, and the goldens that named three are withdrawn', async () => {
    requireBack();
    const patterns = readFileSync(PATTERNS(), 'utf8');
    const block = patterns.slice(patterns.indexOf('  compare_groups: {'), patterns.indexOf('  compare_paired: {'));
    expect(block).toMatch(/arity: \{ groups: \{ min: 2, max: 2 \} \}/);

    // The seven three-group goldens (Q01-Q05, Q20, Q43) and the three-site Q35 are gap rows with no golden intent.
    const ledger = readJson(LEDGER());
    for (const id of ['Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q20', 'Q35', 'Q43'])
      expect(ledger.rows.find((r: { bankId: string }) => r.bankId === id).verdict, `${id} is a gap row`).toBe('gap');
    const corpus = readdirSync(path.join(BACK_ROOT as string, GA, 'plan/compile/__fixtures__/p9-corpus'));
    for (const id of ['Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q20', 'Q35', 'Q43'])
      expect(corpus, `${id} has no golden triple`).not.toContain(`${id}.json`);
    // The mocked-provider proof (one call, a none, a platform gap, no hint) is UT-GATE-1690-045 in the suite run of s4.6.
  });
});

test.describe('AXI-1690 s5.4 - the paid-run registry is append-only and CI enforces it (AC9)', { tag: ['@SI-045'] }, () => {
  test('AC9: header, pre-registry row, PR-only CI step', async () => {
    requireBack();
    const registry = readFileSync(REGISTRY(), 'utf8');
    const table = registry.split('\n').filter((l) => l.trim().startsWith('|'));
    expect(table.length).toBeGreaterThanOrEqual(3);
    expect(table[1]).toMatch(/^\|\s*---/);
    expect(table[2]).toMatch(/2026-09-26/);
    expect(table[2]).toMatch(/pre-registry/);

    const ci = readFileSync(CI_YML(), 'utf8');
    const step = ci.slice(ci.indexOf('Paid-run registry is append-only'));
    expect(step.split('\n').slice(0, 6).join('\n')).toMatch(/if: github\.event_name == 'pull_request'/);
    expect(step).toMatch(/guided-analysis:check-registry -- --base "origin\/\$\{\{ github\.base_ref \}\}"/);

    // A committed row is never edited: compare the working tree with HEAD when the file is tracked.
    const head = spawnSync('git', ['show', `HEAD:apps/organization-service/src/guided-analysis/shadow-run/runs/REGISTRY.md`], { cwd: BACK_ROOT, encoding: 'utf8' });
    if (head.status === 0) {
      const committed = head.stdout.split('\n').filter((l) => l.trim().startsWith('|'));
      committed.forEach((row, i) => expect(table[i], `row ${i} unchanged`).toBe(row));
    }
  });
});

test.describe('AXI-1690 s5.5 - the gate refuses to score without its human-signed inputs (AC15, AC18)', { tag: ['@SI-045'] }, () => {
  test('AC15 AC18: no agent-authored truth file, named refusals, unsigned rows - asserted by the gate suite', async () => {
    requireBack();
    // The signed truth file is the owner's (NFR7); this repo asserts only that the gate does not ship a stand-in for it.
    const truth = path.join(BACK_ROOT as string, GA, 'plan/compile/__fixtures__/grados-gate-truth.json');
    const rulings = readJson(path.join(BACK_ROOT as string, GA, 'plan/compile/__fixtures__/grados-gate-rulings.json'));
    if (existsSync(truth)) expect(readJson(truth).signedBy, 'a truth file present must be signed').toBeTruthy();
    // Type rulings are optional until the owner signs; when present each is well formed.
    for (const t of rulings.types ?? []) {
      expect(t.questionType).toBeTruthy();
      expect(t.ruledBy).toBeTruthy();
      expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const src = readFileSync(path.join(BACK_ROOT as string, GA, 'shadow-run/gate/gate-inputs.ts'), 'utf8');
    expect(src).toMatch(/class GateInputMissingError/);
    expect(src).toMatch(/class GateInputUnsignedError/);
    // UT-GATE-1690-018 (a type ruling is inherited, an unruled row scores unsigned) and -038 run in the s4.6 suite.
  });
});

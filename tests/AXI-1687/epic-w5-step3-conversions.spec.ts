import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * Epic AXI-1687, Workflow 5 step 3 — cross-story re-verification pass (2026-09-27).
 *
 * SDLC.md §"E2E Testing Strategy" / Workflow 5 step 3 requires re-checking every
 * `manual`-tagged scenario's stated reason against CURRENT code before an epic is
 * held for sign-off: a reason naming a platform gap that a sibling story already
 * closed converts to a Playwright spec in this same pass, never left stale. Each
 * test below corresponds to one manual-e2e scenario whose blocking reason was
 * re-checked and found FALSE on main as of 2026-09-27 (the sibling story that
 * closed the gap is named in the comment and the manual-e2e row).
 *
 * Offline throughout: Jest (axiome-back), vitest (axiome-front) and pytest
 * (axiome-bio-compute) are shelled out to and their exit codes asserted; no
 * browser page is driven, no HTTP server, database or LLM provider is reached.
 * `E2E_LIVE_LLM` is never set, not even empty (NFR1, zero LLM spend).
 */
test.use({ storageState: { cookies: [], origins: [] } });

const GA = 'apps/organization-service/src/guided-analysis';
const K = 'apps/organization-service/src/rule-runs/kernel';

function requireBack(): void {
  const missing = missingRepos(['back']);
  test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
}

function jest(specs: string[], cwd: string = BACK_ROOT as string, grep?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  const args = grep ? [...specs, '-t', grep] : specs;
  return spawnSync('npx', ['jest', ...args, '--silent'], { cwd, encoding: 'utf8', env, timeout: 5 * 60_000 });
}

const codeOnly = (file: string): string =>
  readFileSync(path.join(BACK_ROOT as string, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

/**
 * Sibling checkouts the shared harness does not resolve on its own (front + bio-compute).
 * FOLLOW-UP (review advisory, W5 step 3 rework 2026-09-27): this local resolver silently
 * falls back to a worktree-suffix/primary guess when the env var is unset or wrong,
 * unlike the shared `harness/sibling-repos.ts` `missingRepos()` gate every other spec in
 * this suite uses. Left as-is here deliberately (the shared AXI-1688 harness itself is out
 * of this story's ownership boundary and is not touched) but the next story to touch this
 * file should fold FRONT_ROOT/BIO_ROOT into that shared harness so both repos fail loudly
 * exactly like BACK_ROOT/DOCS_ROOT/GLOBAL_ROOT do instead of guessing a directory.
 */
function resolveSibling(envName: string, dirName: string, marker: string): string | undefined {
  const fromEnv = process.env[envName];
  if (fromEnv) {
    if (!existsSync(path.join(fromEnv, marker))) {
      throw new Error(`${envName}=${fromEnv} does not look like ${dirName} (missing ${marker})`);
    }
    return fromEnv;
  }
  const parent = path.dirname(BACK_ROOT ?? '');
  const suffix = path.basename(BACK_ROOT ?? '').replace(/^axiome-back/, '');
  return [path.join(parent, `${dirName}${suffix}`), path.join(parent, dirName)].find((c) =>
    existsSync(path.join(c, marker)),
  );
}
const FRONT_ROOT = resolveSibling('AXIOME_FRONT_ROOT', 'axiome-front', 'src/components/guidedAnalysis/PlanPreview.tsx');
const BIO_ROOT = resolveSibling('AXIOME_BIO_COMPUTE_ROOT', 'axiome-bio-compute', 'src/pipelines/stats_execution.py');

function vitest(specs: string[], grep?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.E2E_LIVE_LLM;
  const args = grep ? ['vitest', 'run', ...specs, '-t', grep] : ['vitest', 'run', ...specs];
  return spawnSync('npx', args, { cwd: FRONT_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
}

function pytest(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.E2E_LIVE_LLM;
  return spawnSync('uv', ['run', '--all-extras', 'pytest', ...args, '-q'], {
    cwd: BIO_ROOT,
    encoding: 'utf8',
    env,
    timeout: 5 * 60_000,
  });
}

test.describe('AXI-1687 W5 step 3 — manual-e2e reasons re-checked and converted', () => {
  test.beforeEach(requireBack);

  // ---- C.4 (AXI-1691 section) — claimDisclaimers rendering shipped with AXI-1705 ----
  test('C.4 AC28 the plan\'s claimDisclaimers render exactly as declared, none added/dropped — the FR77-later-story blocker closed with AXI-1705 (UT-HONEST-1705-020/-024) @SI-046', () => {
    test.skip(!FRONT_ROOT, 'axiome-front checkout not found');
    // Corroborating: PlanPreview actually wires plan.claimDisclaimers into <ClaimDisclaimers>, the
    // component the behavioural run below exercises — a real run of the wrong component would be
    // a vacuous pass, so this pins that PlanPreview is not orphaned from ResultHonesty's exports.
    const preview = readFileSync(path.join(FRONT_ROOT as string, 'src/components/guidedAnalysis/PlanPreview.tsx'), 'utf8');
    expect(preview).toMatch(/plan\.claimDisclaimers/);
    expect(preview).toMatch(/ClaimDisclaimers/);
    // Behavioural: renders the declared disclaimers and nothing else (UT-HONEST-1705-020),
    // renders nothing when none are declared (UT-HONEST-1705-024).
    const r = vitest(
      ['src/components/guidedAnalysis/ResultHonesty.test.tsx'],
      'UT-HONEST-1705-020|UT-HONEST-1705-024',
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/2 passed/);
  });

  // ---- K.5 (AXI-1697 section) — AXI-1698 IS merged on axiome-bio-compute main ----
  test('K.5 AC78 AC79 bio-compute stats.mann_whitney_u emits auc/aucCiLow/aucCiHigh; withheld at small n/separation (AXI-1698 merged) @SI-045', () => {
    test.skip(!BIO_ROOT, 'axiome-bio-compute checkout not found');
    const r = pytest(['tests/test_adapters/test_pingouin_comparisons.py', '-k', '1698']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  // ---- K.6 (AXI-1697 section) — AXI-1701 supplies referentIsOneRowPerSubject ----
  test('K.6 FR79 referent-grain.ts asserts referentIsOneRowPerSubject; the narrator arms the interval only on true (AXI-1701 merged) @SI-045', () => {
    const r = jest([`${GA}/plan/referent-grain.spec.ts`, `${GA}/plan/discrimination-narration.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  // ---- H.5 (AXI-1693 section) — AXI-1730 gateway route + AXI-1736 front form ----
  test('H.5 FR38 FR39 the gateway PUT/GET semantic-declaration route exists and is permission-gated (AXI-1730) @SI-014', () => {
    const r = jest(['apps/gateway/src/proxy/discovery-semantic-declaration.controller.spec.ts']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
  test('H.5 FR38 FR39 the SemanticDeclarationPanel form authors and saves a declaration (AXI-1736) @SI-046', () => {
    test.skip(!FRONT_ROOT, 'axiome-front checkout not found');
    const r = vitest(['src/components/dataset/SemanticDeclarationPanel.test.tsx']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  // ---- L.7 (AXI-1703 section) — AXI-1704 IS merged on axiome-bio-compute main ----
  test('L.7 AC83 bio-compute stats.cutoff_tally tallies, Wilson intervals, LR+/LR-, ROC coordinates (AXI-1704 merged) @SI-021', () => {
    test.skip(!BIO_ROOT, 'axiome-bio-compute checkout not found');
    const r = pytest(['tests/test_pipelines/test_cutoff_methods.py', 'tests/test_pipelines/test_cutoff_proposal_execution.py', '-k', '1704']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  // ---- L.5 (AXI-1700 section) — AXI-1730 gateway route + AXI-1736/1740 front form ----
  test('L.5 AC35 AC36 the same DatasetSemanticDeclarationService backs both the gateway-authored declaration and the seed reading IMM-QC-10/11 offer from (AXI-1730/1736/1740) @SI-014 @SI-044', () => {
    const gw = jest(['apps/gateway/src/proxy/discovery-semantic-declaration.controller.spec.ts']);
    expect(gw.status, `${gw.stdout}\n${gw.stderr}`).toBe(0);
    const svc = codeOnly('apps/organization-service/src/datasets/dataset-semantic-declaration.service.ts');
    expect(svc).toMatch(/findCurrent/);
    const qc = jest([
      'apps/organization-service/src/datasets/dataset-semantic-declaration.late-qc.spec.ts',
      'apps/organization-service/src/rule-runs/kernel/qc-declared-resolvers.spec.ts',
    ]);
    expect(qc.status, `${qc.stdout}\n${qc.stderr}`).toBe(0);
  });
  test('L.5 FR38 FR39 the front Semantics tab authors the declaration that the gateway route persists (AXI-1736/1740) @SI-046', () => {
    test.skip(!FRONT_ROOT, 'axiome-front checkout not found');
    const r = vitest(['src/components/dataset/SemanticDeclarationPanel.test.tsx'], 'UT-FE-SEMDECL-1736-011');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  // ---- M.8 (AXI-1701 section) — AXI-1738 persists FAMILY_ADJUST as a RuleRun ----
  test('M.8 AC69 AC72 the executed family step now persists as a FAMILY_ADJUST RuleRun record via plan-execution.service.ts (AXI-1738) @SI-047', () => {
    const svc = codeOnly(`${GA}/execution/plan-execution.service.ts`);
    expect(svc).toMatch(/DerivedRunService/);
    expect(svc).toMatch(/FAMILY_ADJUST/);
    const r = jest(['apps/organization-service/src/rule-runs/derived-run.service.spec.ts'], BACK_ROOT as string, 'UT-RUNKIND-1738-023');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const fam = jest([`${GA}/execution/plan-execution-family.spec.ts`]);
    expect(fam.status, `${fam.stdout}\n${fam.stderr}`).toBe(0);
  });

  // ---- CG1707.4 (AXI-1707 section) — AXI-1743 compiles the chain, AXI-1738 persists each derived step ----
  test('CG1707.4 AC99 Q14 compiles the subject_delta -> delta_direction -> chi_square chain (AXI-1743), each derived step recorded under its own RuleRun kind (AXI-1738); cross-node runtime resolution over a derived node\'s own output is still not built (disclosed gap) @SI-045', () => {
    const compile = jest([`${GA}/plan/compile/composite-delta-direction-test.spec.ts`]);
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
    const persist = jest(['apps/organization-service/src/rule-runs/derived-run.service.spec.ts']);
    expect(persist.status, `${persist.stdout}\n${persist.stderr}`).toBe(0);
  });

  // ---- O.S2.5 (AXI-1708 section) — AXI-1733 wired describe_subject_coverage into the compiler ----
  test('O.S2.5 AC100 (compile half) Q17 compiles a subject-coverage node followed by a describe over the flagged cohort (AXI-1733 RB1733.2) @SI-045', () => {
    const r = jest([
      `${GA}/plan/compile/representation-golden.spec.ts`,
      `${GA}/plan/compile/grados-golden.spec.ts`,
      `${GA}/plan/compile/json-operation-parameters.spec.ts`,
    ]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  // ---- O.S4.4 (AXI-1710 section) — AXI-1741 wired the composite compile side ----
  test('O.S4.4 AC102 (compile half) Q23\'s shape compiles an untrimmed correlate plus a trimmed sensitivity correlate (AXI-1741 CP1741.1/UT-COMPOSITE-1741-002); bio-compute never falls back to an untrimmed r (AXI-1733) @SI-045', () => {
    const compile = jest([`${GA}/plan/compile/composite-correlate-trim.spec.ts`]);
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
    test.skip(!BIO_ROOT, 'axiome-bio-compute checkout not found');
    const compute = pytest(['tests/test_pipelines/test_stats_execution.py', '-k', '1733']);
    expect(compute.status, `${compute.stdout}\n${compute.stderr}`).toBe(0);
  });

  // ---- J.7 (AXI-1705 section) — AXI-1729 serves GET /guided-analysis/shapes; AXI-1736 consumes it ----
  test('J.7 AC73 the gateway serves the shape registry, one entry per compilable shape (GW1729.1, AXI-1729) @SI-046', () => {
    const gw = jest([`${GA}/plan/compile/shape-catalogue.spec.ts`, 'apps/gateway/src/proxy/guided-analysis.controller.spec.ts']);
    expect(gw.status, `${gw.stdout}\n${gw.stderr}`).toBe(0);
  });
  test('J.7 AC73 the unsupported-plan card renders the served shape list, with a local mirror deleted; a failed call shows no remembered list (AXI-1736) @SI-046', () => {
    test.skip(!FRONT_ROOT, 'axiome-front checkout not found');
    const r = vitest(['src/components/guidedAnalysis/UnsupportedPlanCard.test.tsx'], 'UT-FE-UNSUP-010|UT-FE-SHAPES-1736-003');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  // ---- J.8 (AXI-1705 section) — AXI-1735 serves the fields; AXI-1736 renders them ----
  test('J.8 AC76 the run-status family block serves per-member interval/omnibus/unit statement (AXI-1729) plus effect and screenHoldout (AXI-1735) @SI-046', () => {
    const r = jest([
      'apps/organization-service/src/governed-execution/domain/run-detail-family-members.spec.ts',
      'apps/organization-service/src/governed-execution/executor/rule-runs-member-effect-reader.spec.ts',
    ]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
  test('J.8 AC76 the family table renders served effect/interval/omnibus/screen-holdout facts verbatim; an explicit null reads "not computed" (AXI-1736) @SI-046', () => {
    test.skip(!FRONT_ROOT, 'axiome-front checkout not found');
    const r = vitest(['src/components/guidedAnalysis/ResultHonesty.test.tsx'], 'UT-FE-FAMILY-1736-001|UT-FE-FAMILY-1736-003');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  // ---- FU1730.5 (AXI-1730 section) — the front form was built by AXI-1736/AXI-1740 ----
  test('FU1730.5 the SemanticDeclarationPanel form authors a declaration and sends {declaration} only to the server (AXI-1736) @SI-046', () => {
    test.skip(!FRONT_ROOT, 'axiome-front checkout not found');
    const r = vitest(['src/components/dataset/SemanticDeclarationPanel.test.tsx'], 'UT-FE-SEMDECL-1736-011');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  // ---- FE1736.7 (AXI-1736 section) — the harness has a 'user' storageState, but the permission
  // gate itself is proven at the component level, which needs no login at all ----
  test('FE1736.7 a caller without governs_analysis_parameters (canEdit=false) sees the reading and no edit control (UT-FE-SEMDECL-1736-010) @SI-046', () => {
    test.skip(!FRONT_ROOT, 'axiome-front checkout not found');
    const r = vitest(['src/components/dataset/SemanticDeclarationPanel.test.tsx'], 'UT-FE-SEMDECL-1736-010');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

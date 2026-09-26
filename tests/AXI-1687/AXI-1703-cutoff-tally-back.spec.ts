import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1703 - L.W6 Cut-off (back) (epic AXI-1687). Offline: files and Jest only, fixture rows in the
 * shape bio-compute AXI-1704 persists. No planner, API, bio-compute process or provider key is
 * reached; E2E_LIVE_LLM is never read (and is forced empty for the child Jest, never set).
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section L.1 to L.6.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const SRC = 'apps/organization-service/src';
const GA = `${SRC}/guided-analysis`;
const KERNEL = `${SRC}/rule-runs/kernel`;

function requireBack(): void {
  const missing = missingRepos(['back']);
  test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
}
const codeOnly = (file: string): string =>
  readFileSync(path.join(BACK_ROOT as string, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

function jest(specs: string[]) {
  return spawnSync('npx', ['jest', ...specs, '--silent'], {
    cwd: BACK_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', E2E_LIVE_LLM: '' },
    timeout: 5 * 60_000,
  });
}

test.describe('AXI-1703 cut-off back', () => {
  test.beforeEach(requireBack);

  test('L.1 AC83 EC37 the tally binds a CutoffChoice by id only and the binding suite is green @SI-017 @SI-015', () => {
    const ops = codeOnly(`${KERNEL}/cutoff-proposal-operations.ts`);
    expect(ops).toMatch(/CUTOFF_TALLY\s*=\s*'stats\.cutoff_tally'/);
    expect(ops).toMatch(/key:\s*'cutoffChoiceId'[^}]*required:\s*true/);
    expect(ops).not.toMatch(/thresholdId/);
    const binding = codeOnly(`${KERNEL}/cutoff-tally-binding.ts`);
    expect(binding).toMatch(/admitCutoffForApplication/);
    expect(binding).toMatch(/no_cutoff_choice/);
    const r = jest([`${KERNEL}/cutoff-tally-binding.spec.ts`, `${SRC}/rule-runs/rule-runs-tally-choice.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('L.2 AC84 EC13 EC30 the narration suite is green (optimism, declared source, PPV/NPV withheld, ceilings) @SI-045 @SI-048', () => {
    expect(existsSync(path.join(BACK_ROOT as string, `${GA}/plan/cutoff-tally-narration.ts`))).toBe(true);
    const r = jest([`${GA}/plan/cutoff-tally-narration.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('L.3 AC82 the routing suite is green and no planner shape compiles a stats.cutoff_* node @SI-045', () => {
    const r = jest([`${GA}/plan/compile/cutoff-routing.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const shapes = codeOnly(`${GA}/plan/compile/compile-intent.ts`);
    expect(shapes).not.toMatch(/stats\.cutoff_/);
  });

  test('L.4 AC85 FR85 the Youden proposal declares the ROC coordinates column @SI-017', () => {
    const ops = codeOnly(`${KERNEL}/cutoff-proposal-operations.ts`);
    expect(ops).toMatch(/'rocCoordinates'/);
  });

  test('L.5 AC30 AC128 the claim, plan-identity, golden-bank and surface-spec drift suites still pass (no third re-baseline) @SI-045', () => {
    const claims = codeOnly(`${KERNEL}/claim-declarations.ts`);
    expect(claims).toMatch(/'stats\.cutoff_tally':\s*\[\.\.\.CUTOFF,\s*'sampling_design'\]/);
    const r = jest([
      `${GA}/plan/claims-match-operations.spec.ts`,
      `${GA}/plan/compile/plan-identity-rebaseline.spec.ts`,
      `${GA}/plan/compile/grados-golden.spec.ts`,
      `${SRC}/rule-runs/surface-spec/surface-spec-drift.spec.ts`,
      `${KERNEL}/operation-registry.spec.ts`,
    ]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('L.6 EC13 FR84 the optimism statement is owned by the narration layer, not the registry or the binding @SI-045', () => {
    const narration = codeOnly(`${GA}/plan/cutoff-tally-narration.ts`);
    expect(narration).toMatch(/provenance\.optimism/);
    expect(narration).toMatch(/thresholdDerivedOnSameData\s*===\s*true/);
    expect(codeOnly(`${KERNEL}/cutoff-tally-binding.ts`)).not.toMatch(/provenance\.optimism/);
  });
});

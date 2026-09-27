import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1714 (epic AXI-1687 — FR106, S8 catalogue growth). A new plan-parser rule,
 * P37 (WARN), checks a `stats.mann_whitney_u` node's SPECIFIC named pair of levels
 * (`groupFrom`/`groupTo`) against the dataset's own cohort `cellCounts` (FR1) and
 * warns when the smaller of the two named arms is below the governed floor —
 * upgrading FR46's whole-dataset "n per group" narration to the pair a Mann-Whitney
 * node actually compares. Offline: Jest only; `E2E_LIVE_LLM` is removed from the
 * child env (never set, not even empty) — this is a pure plan-validation rule, no
 * LLM turn involved.
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section AXI-1714.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const SRC = 'apps/organization-service/src';
const PLAN = `${SRC}/guided-analysis/plan`;
const COMPILE = `${PLAN}/compile`;

const jest = (specs: string[], grep?: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  const args = grep ? [...specs, '-t', grep] : specs;
  return spawnSync('npx', ['jest', ...args, '--silent'], { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
};

test.describe('AXI-1714 pair-aware minimum-n on Mann-Whitney (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('PN1714.1 a Mann-Whitney pair below the governed floor is flagged P37 (WARN), never a block @SI-045 @SI-017', () => {
    const r = jest([`${PLAN}/plan-rules-pair-aware-min-n.spec.ts`], 'UT-PAIRN-1714-00[178]');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('PN1714.2 a pair meeting the floor, an absent/partial cellCounts, or a non-Mann-Whitney node stays silent @SI-017', () => {
    const r = jest([`${PLAN}/plan-rules-pair-aware-min-n.spec.ts`], 'UT-PAIRN-1714-00[2-6]');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('PN1714.3 the boundary is exact: n = floor is silent, n = floor - 1 warns @SI-017', () => {
    const r = jest([`${PLAN}/plan-rules-pair-aware-min-n.spec.ts`], 'UT-PAIRN-1714-007');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('PN1714.4 plan identity is unmoved: no new re-baseline manifest, golden + identity suites stay green @SI-017', () => {
    const r = jest([`${COMPILE}/plan-identity-rebaseline.spec.ts`, `${COMPILE}/grados-golden.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

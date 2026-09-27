import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1743 (epic AXI-1687 - FR30, FR99, FR103; owner ruling 2026-09-27). The fifth,
 * owner-authorised plan-identity re-baseline: Q14's delta-direction compiled chain
 * (derive.subject_delta -> derive.delta_direction -> stats.chi_square) and
 * compare.sibling_results wired into Q07/Q09-Q12 (dual_representation), bundled as
 * ONE manifest. Offline: Jest only; E2E_LIVE_LLM is removed from the child env
 * (never set, not even empty) — neither new capability is reachable through a live
 * LLM/UI flow yet (no prompt/hint wiring emits the new operationParams fields), so
 * this exercises the compiled-plan structure through hand-built intents, the same
 * way AXI-1707/1711/1733 shipped pure compile-side declarations.
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section AXI-1743.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const SRC = 'apps/organization-service/src';
const COMPILE = `${SRC}/guided-analysis/plan/compile`;
const KERNEL = `${SRC}/rule-runs/kernel`;

const jest = (specs: string[], grep?: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  const args = grep ? [...specs, '-t', grep] : specs;
  return spawnSync('npx', ['jest', ...args, '--silent'], { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
};

test.describe('AXI-1743 delta-direction chain + sibling comparison wiring (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('DR1743.1 AC99/FR99 Q14 compiles a THREE-node prelude chain in dependsOn order, excluded from the correction family @SI-017', () => {
    const r = jest([`${COMPILE}/composite-delta-direction-test.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('DR1743.2 AC103/FR103 dual_representation wires compare.sibling_results only when a prior reading is DECLARED, never fabricated @SI-045 @SI-017', () => {
    const r = jest([`${COMPILE}/composite-sibling-comparison.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('DR1743.3 NFR2 both capabilities are byte-identical when their operationParams are absent (representation-golden + shape fixtures) @SI-017', () => {
    const r = jest([`${COMPILE}/representation-golden.spec.ts`, `${COMPILE}/composite-delta-direction-test.spec.ts`, `${COMPILE}/composite-sibling-comparison.spec.ts`], 'byte-identical|no priorReadingNodeId');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('DR1743.4 AC30 exactly five plan-identity re-baseline manifests exist; no sixth is allowed @SI-017', () => {
    const dir = path.join(BACK_ROOT as string, `${COMPILE}/__fixtures__/rebaselines`);
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBe(5);
    const r = jest([`${KERNEL}/index.spec.ts`, `${COMPILE}/plan-identity-rebaseline.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('DR1743.5 UT-HOLDOUT-1689-004 no held-out fixture id leaks into the guided-analysis unit outside the holdout directory @SI-017', () => {
    const r = jest([`${SRC}/guided-analysis/shadow-run/holdout/holdout.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

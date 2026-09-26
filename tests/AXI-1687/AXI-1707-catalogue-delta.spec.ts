import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1707 - O.W7 Catalogue growth S1: delta referents and direction of change (epic AXI-1687,
 * FR99). Offline: Jest only; E2E_LIVE_LLM is removed from the child env (never set, not even empty).
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section CG1707.1 to CG1707.3.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const SRC = 'apps/organization-service/src';
const KERNEL = `${SRC}/rule-runs/kernel`;

const jest = (specs: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  return spawnSync('npx', ['jest', ...specs, '--silent'], { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
};

test.describe('AXI-1707 delta referents and direction of change (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('CG1707.1 AC99 the delta needs a declared referent and reports missing timepoints per subject @SI-045', () => {
    const r = jest([`${KERNEL}/delta-operation.spec.ts`, '-t', 'referent|absolute delta|percent delta']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('CG1707.2 AC99 direction is delta, direction, chi-square; magnitude is delta, compare_groups; Fisher waits for ruling 5 @SI-045 @SI-017', () => {
    const r = jest([`${KERNEL}/delta-operation.spec.ts`, '-t', 'AC99|Fisher|sign|counts|claim guard']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('CG1707.3 AC30 no third plan-identity re-baseline; kernel export surface stays exact @SI-017', () => {
    const dir = path.join(BACK_ROOT as string, `${SRC}/guided-analysis/plan/compile/__fixtures__/rebaselines`);
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBe(2);
    const r = jest([`${KERNEL}/index.spec.ts`, `${SRC}/guided-analysis/plan/compile/plan-identity-rebaseline.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

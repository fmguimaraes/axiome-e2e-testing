import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1701 - I.W6 Governed family adjustment, back half (epic AXI-1687). Offline: Jest only. No
 * planner, API, bio-compute process or provider key is reached; the child Jest env has
 * E2E_LIVE_LLM removed (never set, not even empty).
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section M.1 to M.8.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const SRC = 'apps/organization-service/src';
const GA = `${SRC}/guided-analysis`;

function requireBack(): void {
  const missing = missingRepos(['back']);
  test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
}
const jest = (specs: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  return spawnSync('npx', ['jest', ...specs, '--silent'], { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
};

test.describe('AXI-1701 governed family adjustment (back)', () => {
  test.beforeEach(requireBack);

  test('M.1 AC69 one upstream-output reader: incomplete, outside-plan and mismatched reads are refused @SI-047', () => {
    const r = jest([`${GA}/family/upstream-output-reader.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('M.2 AC68 AC70 AC72 the family is adjusted per member at the policy alpha, ceilings lift only after a clean adjustment @SI-047 @SI-017', () => {
    const r = jest([`${GA}/family/family-adjust-step.spec.ts`, `${GA}/execution/plan-execution-family.spec.ts`, `${SRC}/rule-runs/kernel/family-adjust-operation.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('M.3 AC69 AC71 EC11 a failed member degrades visibly with both denominators printed; a running member blocks the step @SI-047', () => {
    const r = jest([`${GA}/family/family-adjust-step.spec.ts`, `${GA}/execution/plan-execution-family.spec.ts`, '-t', 'degrade|refuse|does not start|counted|executor failure|no member']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('M.4 AC70 plan rule P14 refuses a reading in the member list and the validator suite stays green @SI-045', () => {
    const r = jest([`${GA}/family/family-membership.spec.ts`, `${GA}/plan/plan-validator.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('M.5 AC70 AC72 the run status reports the adjustment and stays exploratory without one @SI-047 @SI-016', () => {
    const r = jest([`${SRC}/governed-execution/domain/run-detail-family-adjust.spec.ts`, `${SRC}/governed-execution/domain/run-detail.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('M.6 FR79 the subject-grain assertion arms the AUC interval only on a verified one-row-per-subject referent @SI-045', () => {
    const r = jest([`${GA}/plan/referent-grain.spec.ts`, `${GA}/plan/discrimination-narration.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('M.7 AC30 the frozen corpus identity is untouched (exactly two manifests) @SI-045', () => {
    const dir = path.join(BACK_ROOT as string, GA, 'plan/compile/__fixtures__/rebaselines');
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBe(2);
    const r = jest([`${GA}/plan/compile/plan-identity-rebaseline.spec.ts`, `${GA}/plan/compile/grados-golden.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

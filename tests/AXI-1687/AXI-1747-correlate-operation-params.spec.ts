import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1747 (epic AXI-1687 — regression fix). AXI-1741 taught `correlate.shape.ts` to read
 * `operationParams.trimCriterion/trimValue/trimSide`; AXI-1744 taught the live prompt to ask the
 * model for exactly that. Both shipped while `correlate`'s I04 row still forbade `operationParams`
 * outright, so the intent the prompt now solicits was refused by validation before it ever reached
 * the compiler — invisible to AXI-1741/1744's own unit suites, which called `compileIntent`
 * directly and never ran `validateIntent`. Offline: Jest only; `E2E_LIVE_LLM` is removed from the
 * child env (never set, not even empty) — this is a validation/compile-chain defect, not a live
 * planner behaviour, so no LLM turn is involved either way.
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section AXI-1747.
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

test.describe('AXI-1747 correlate operationParams intent-rule fix (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('CP1747.1 the AXI-1744-prompt-shaped correlate intent passes validateIntent AND compiles to the trimmed composite @SI-045 @SI-017', () => {
    const r = jest([`${PLAN}/correlate-operation-params-validation.spec.ts`], 'UT-CORRPARAMS-1747-00[12]');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('CP1747.2 an ordinary correlate question (no trim clause) is unaffected @SI-017', () => {
    const r = jest([`${PLAN}/correlate-operation-params-validation.spec.ts`], 'UT-CORRPARAMS-1747-003');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('CP1747.3 a junk operationParams key on correlate, dual_representation, or delta_direction_test is refused loudly, by I04, by name @SI-017', () => {
    const r = jest([`${PLAN}/correlate-operation-params-validation.spec.ts`], 'refused loudly');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  // Review bounce B1: delta_direction_test admitted its operationParams bag with no declared
  // vocabulary at all — the same class as the original correlate regression, just on the
  // "admits, forbids nothing" side. Its five declared keys still validate and compile.
  test('CP1747.6 delta_direction_test\'s five declared delta keys pass validateIntent and compile the prelude chain @SI-017', () => {
    const r = jest([`${PLAN}/correlate-operation-params-validation.spec.ts`], 'UT-CORRPARAMS-1747-008');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('CP1747.4 class-wide audit: every non-describe, non-connector-citing shape\'s row matches what its compile module actually reads off operationParams @SI-017', () => {
    const r = jest([`${PLAN}/correlate-operation-params-validation.spec.ts`], 'AUDIT');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('CP1747.5 plan identity is unmoved: no sixth re-baseline manifest, golden + rebaseline suites stay green @SI-017', () => {
    const r = jest([`${COMPILE}/plan-identity-rebaseline.spec.ts`, `${COMPILE}/grados-golden.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

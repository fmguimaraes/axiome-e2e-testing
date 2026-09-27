import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1713 - O.W7 Catalogue growth S7: measurement limits on envelope (epic AXI-1687, FR105).
 * Offline: files, Jest and pytest only; no planner, provider key or live run (`E2E_LIVE_LLM`
 * never set, not even empty). Scenario doc:
 * manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section ### AXI-1713.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const K = 'apps/organization-service/src/rule-runs/kernel';
const GA = 'apps/organization-service/src/guided-analysis';

function jest(specs: string[], cwd: string = BACK_ROOT as string) {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  return spawnSync('npx', ['jest', ...specs, '--silent'], { cwd, encoding: 'utf8', env, timeout: 5 * 60_000 });
}

const BIO_ROOT = ((): string | undefined => {
  const parent = path.dirname(BACK_ROOT ?? '');
  const candidates = [
    process.env.AXIOME_BIO_COMPUTE_ROOT,
    path.join(parent, 'axiome-bio-compute-AXI-1713-measurement-limits'),
    path.join(parent, 'axiome-bio-compute'),
  ];
  return candidates.find((c): c is string => !!c && existsSync(path.join(c, 'src/pipelines/describe_execution.py')));
})();

test.describe('AXI-1713 measurement limits', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('MLIM1713.1 describe.below_limit_count is a new registered DESCRIBE operation; the four existing describe ids remain @SI-045 @SI-017', () => {
    const r = jest([`${K}/describe-operations.spec.ts`, `${K}/index.spec.ts`, `${K}/operation-registry.spec.ts`, `${K}/rule-run-operation.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MLIM1713.2 dispatch carries the measure column and every declared threshold snake_case, and refuses an unbound column by name @SI-045', () => {
    const r = jest([`${K}/describe-dispatch.spec.ts`], `${BACK_ROOT}/apps/organization-service` as string);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MLIM1713.3 (FR105) a declared MeasurementLimits entry compiles Q37 to a real node with exact thresholds @SI-045', () => {
    const r = jest([`${GA}/plan/compile/describe-below-limit-count.compile.spec.ts`, `${GA}/plan/compile/compile-intent.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MLIM1713.4 (FR58) a dataset declaring NO MeasurementLimits still throws the compiler\'s ordinary precondition refusal, unchanged @SI-045', () => {
    const r = jest([`${GA}/plan/compile/describe-below-limit-count.compile.spec.ts`], BACK_ROOT as string);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MLIM1713.5 the plan handler stamps the workspace\'s declared limits under the dataset\'s own column name, and a client-sent value is always replaced @SI-045 @SI-017', () => {
    const r = jest([`${GA}/guided-analysis-measurement-limits.spec.ts`, `${GA}/plan/envelope-identity.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MLIM1713.6 nothing in this story moves the p9-corpus plan identity (hard constraint) @SI-045', () => {
    const r = jest([`${GA}/plan/compile/grados-golden.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MLIM1713.7 the bio-compute below_limit_count module classifies measured/censored/missing status with correct threshold priority @SI-017', () => {
    test.skip(!BIO_ROOT, 'axiome-bio-compute checkout not found');
    const r = spawnSync('uv', ['run', '--all-extras', 'pytest', 'tests/test_compute/test_below_limit_count.py', 'tests/test_compute/test_registry.py', '-q'], {
      cwd: BIO_ROOT,
      encoding: 'utf8',
      timeout: 5 * 60_000,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MLIM1713.8 the describe_execution pipeline dispatches below_limit_count and refuses a missing measure column at submit @SI-017', () => {
    test.skip(!BIO_ROOT, 'axiome-bio-compute checkout not found');
    const r = spawnSync('uv', ['run', '--all-extras', 'pytest', 'tests/test_pipelines/test_describe_execution.py', '-q', '-k', 'BelowLimitCount or 017b'], {
      cwd: BIO_ROOT,
      encoding: 'utf8',
      timeout: 5 * 60_000,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

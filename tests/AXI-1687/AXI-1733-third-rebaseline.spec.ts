import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1733 - the bundled third plan-identity re-baseline (epic AXI-1687). Offline: files and Jest
 * only; E2E_LIVE_LLM is never read. Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md
 * section RB1733.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const GA = 'apps/organization-service/src/guided-analysis';

function jest(specs: string[]) {
  return spawnSync('npx', ['jest', ...specs, '--silent'], {
    cwd: BACK_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', E2E_LIVE_LLM: '' },
    timeout: 5 * 60_000,
  });
}

const BIO_ROOT = ((): string | undefined => {
  const parent = path.dirname(BACK_ROOT ?? '');
  const candidates = [process.env.AXIOME_BIO_COMPUTE_ROOT, path.join(parent, 'axiome-bio-compute-AXI-1733-third-rebaseline'), path.join(parent, 'axiome-bio-compute')];
  return candidates.find((c): c is string => !!c && existsSync(path.join(c, 'src/pipelines/stats_execution.py')));
})();

test.describe('AXI-1733 third re-baseline', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('RB1733.1 AC30 exactly five plan-identity manifests exist and the third moves only the FR61 wording on the compiled plan @SI-045', () => {
    const dir = path.join(BACK_ROOT as string, GA, 'plan/compile/__fixtures__/rebaselines');
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(5);
    const r = jest([`${GA}/plan/compile/plan-identity-rebaseline.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('RB1733.2 the describe_subject_coverage shape compiles and the seed declaration activation offers IMM-QC-10/11 @SI-045', () => {
    const r = jest([
      `${GA}/plan/compile/representation-golden.spec.ts`,
      `${GA}/plan/compile/grados-golden.spec.ts`,
      `${GA}/plan/compile/json-operation-parameters.spec.ts`,
    ]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('RB1733.3 FR61 a reading is excluded from the family with the verbatim reason, and the corpus moved only that wording @SI-045', () => {
    const r = jest([`${GA}/plan/compile/fr61-readings-exclusion.spec.ts`, `${GA}/plan/compile/plan-identity-rebaseline.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('RB1733.4 FR102 stats.correlation_trimmed is registered, claim-declared, and named by bio-compute stats_execution @SI-045 @SI-017', () => {
    const r = spawnSync(
      'npx',
      ['jest', `${GA.replace('guided-analysis', 'rule-runs')}/kernel/correlation-trim-operation.spec.ts`, `${GA.replace('guided-analysis', 'rule-runs')}/kernel/operation-registry.spec.ts`, `${GA.replace('guided-analysis', 'rule-runs')}/kernel/bio-compute-operation-contract.spec.ts`, '--silent'],
      {
        cwd: BACK_ROOT,
        encoding: 'utf8',
        env: { ...process.env, CI: '1', E2E_LIVE_LLM: '', ...(BIO_ROOT ? { BIO_COMPUTE_ROOT: BIO_ROOT, REQUIRE_BIO_COMPUTE_CONTRACT: '1' } : {}) },
        timeout: 5 * 60_000,
      },
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('RB1733.5 FR102 the bio-compute trimmed-correlation pipeline names every dropped subject and never falls back to an untrimmed r @SI-045', () => {
    test.skip(!BIO_ROOT, 'axiome-bio-compute checkout not found');
    const r = spawnSync('uv', ['run', '--all-extras', 'pytest', 'tests/test_pipelines/test_stats_execution.py', '-q', '-k', 'Trimmed'], {
      cwd: BIO_ROOT,
      encoding: 'utf8',
      timeout: 5 * 60_000,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

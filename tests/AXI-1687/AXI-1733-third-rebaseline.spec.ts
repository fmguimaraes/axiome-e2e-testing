import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
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

test.describe('AXI-1733 third re-baseline', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('RB1733.1 AC30 exactly three plan-identity manifests exist and the third moves no compiled plan @SI-045', () => {
    const dir = path.join(BACK_ROOT as string, GA, 'plan/compile/__fixtures__/rebaselines');
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(3);
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
});

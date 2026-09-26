import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1693 - D.W4 Dataset semantic declaration and scope (epic AXI-1687). Offline: files and
 * Jest only. No planner, API or provider key is reached; E2E_LIVE_LLM is never read.
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section H.1 to H.4.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const OS = 'apps/organization-service/src';
const GA = `${OS}/guided-analysis`;

function requireBack(): void {
  const missing = missingRepos(['back']);
  test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
}
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const jest = (specs: string[]) =>
  spawnSync('npx', ['jest', ...specs, '--silent'], {
    cwd: BACK_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', E2E_LIVE_LLM: '' },
    timeout: 5 * 60_000,
  });

test.describe('AXI-1693 dataset semantic declaration and scope', () => {
  test.beforeEach(requireBack);

  test('H.1 AC38 AC39 one dataset-level declaration; no PlannerScopeRole exists @SI-002 @SI-014', () => {
    const files = walk(path.join(BACK_ROOT as string, 'libs/contracts/src')).concat(walk(path.join(BACK_ROOT as string, OS)));
    const src = files.filter((f) => f.endsWith('.ts')).map((f) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')).join('\n');
    expect(src).not.toMatch(/PlannerScopeRole/);
    expect(existsSync(path.join(BACK_ROOT as string, 'libs/contracts/src/dataset/dataset-semantic-declaration.ts'))).toBe(true);
    const r = jest([`${OS}/datasets/dataset-semantic-declaration.spec.ts`, `${OS}/datasets/dataset-semantic-declaration.service.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('H.2 AC41 AC45 AC46 AC47 EC28 the executed scope pass pins, refuses and is idempotent @SI-045 @SI-017', () => {
    const r = jest([`${GA}/plan/declared-scope.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('H.3 AC41 AC122 AC124 the second re-baseline is an asserted diff and additivity holds @SI-045', () => {
    const manifest = path.join(BACK_ROOT as string, GA, 'plan/compile/__fixtures__/rebaselines/rebaseline-2-phase-2-fr41-declared-scope.json');
    expect(existsSync(manifest)).toBe(true);
    const r = jest([`${GA}/plan/compile/plan-identity-rebaseline.spec.ts`, `${GA}/plan/compile/grados-golden.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('H.4 AC42 AC40 the gate reads its scope truth from the declaration @SI-014', () => {
    const r = jest([`${GA}/shadow-run/gate/gate-truth-declaration.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

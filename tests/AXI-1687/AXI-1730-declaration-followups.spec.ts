import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1730 - AXI-1693 follow-ups (epic AXI-1687). Offline: files and Jest only. No planner, API or
 * provider key is reached; E2E_LIVE_LLM is never read. Scenario doc:
 * manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section AXI-1730.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const OS = 'apps/organization-service/src';
const GA = `${OS}/guided-analysis`;

function requireBack(): void {
  const missing = missingRepos(['back']);
  test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
}
const jest = (specs: string[]) =>
  spawnSync('npx', ['jest', ...specs, '--silent'], {
    cwd: BACK_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', E2E_LIVE_LLM: '' },
    timeout: 5 * 60_000,
  });

test.describe('AXI-1730 AXI-1693 follow-ups', () => {
  test.beforeEach(requireBack);

  test('FU1730.1 FR41 FR42 a scope refusal in the fallback arm is none with the typed gap, never an unscoped plan @SI-045', () => {
    const r = jest([`${GA}/plan/planner-scope-refusal-fallback.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('FU1730.2 FR38 FR39 the declaration gateway routes are scoped, paginated and permission-gated @SI-014', () => {
    const r = jest(['apps/gateway/src/proxy/discovery-semantic-declaration.controller.spec.ts', `${OS}/datasets/dataset-semantic-declaration.revisions.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('FU1730.3 FR44 AC44 ruling 16 the annotation is idempotent and the script is dry-run by default @SI-045', () => {
    const r = jest([`${GA}/plan/scope-annotation.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const script = readFileSync(path.join(BACK_ROOT as string, 'scripts/annotate-pre-declaration-plans.ts'), 'utf8');
    expect(script).toMatch(/DRY-RUN BY DEFAULT/);
    expect(script).toMatch(/process\.argv\.includes\('--apply'\)/);
  });

  test('FU1730.4 FR41 independenceKey is declared and stamp-only; exactly five plan-identity manifests @SI-002', () => {
    const r = jest(['libs/contracts/src/guided-analysis/independence-key.spec.ts']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const dir = path.join(BACK_ROOT as string, GA, 'plan/compile/__fixtures__/rebaselines');
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(5);
  });
});

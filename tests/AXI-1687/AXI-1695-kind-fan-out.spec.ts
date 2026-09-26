import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1695 - H.W5 Multi-measure fan-out and omnibus (kind expansion) (epic AXI-1687). Offline: files and
 * Jest only. No planner, API or provider key is reached; E2E_LIVE_LLM is never read.
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section I.1 to I.5.
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

test.describe('AXI-1695 multi-measure fan-out and omnibus', () => {
  test.beforeEach(requireBack);

  test('I.1 AC59 AC60 AC62 a kind token expands to one node per measure, capped and typed @SI-045 @SI-002', () => {
    const r = jest([`${GA}/plan/compile/kind-fan.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('I.2 AC61 AC63 AC125 AC126 the wire schema stays at the 12 ceiling and the intent rules cover the domain @SI-002 @SI-017', () => {
    const r = jest([`${GA}/plan/kind-fan-wire.spec.ts`, `libs/contracts/src/guided-analysis/analysis-intent.patterns.spec.ts`, `${GA}/plan/compile/terminal-refusals.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('I.3 AC64 the run status reports the family and each member ceiling @SI-045', () => {
    const r = jest([`${OS}/governed-execution/domain/run-detail.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('I.4 AC65 AC66 AC67 the frozen corpus identity is untouched (exactly two manifests) @SI-045', () => {
    const dir = path.join(BACK_ROOT as string, GA, 'plan/compile/__fixtures__/rebaselines');
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBe(2);
    const r = jest([`${GA}/plan/compile/plan-identity-rebaseline.spec.ts`, `${GA}/plan/compile/grados-golden.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('I.5 AC59 the adapter answers a three-group intent as two contrasts, not a refusal @SI-002', () => {
    const r = jest([`${GA}/plan/compiled-planner.adapter.spec.ts`, `${GA}/plan/compiled-planner-terminal-classes.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

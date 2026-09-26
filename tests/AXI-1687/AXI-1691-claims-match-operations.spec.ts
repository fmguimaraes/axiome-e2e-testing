import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1691 - C.W3 Claims match operations (epic AXI-1687). Offline: files and Jest only.
 * No planner, API or provider key is reached; E2E_LIVE_LLM is never read.
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section C.1 to C.3.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const GA = 'apps/organization-service/src/guided-analysis';

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

test.describe('AXI-1691 claims match operations', () => {
  test.beforeEach(requireBack);

  test('C.1 AC22 AC23 AC24 no code keys the interval claim on a node-type list @SI-045 @SI-017', () => {
    const src = walk(path.join(BACK_ROOT as string, GA))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .map((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .join('\n'),
      )
      .join('\n');
    expect(src).not.toMatch(/reportsInterval|NO_INTERVAL_NODE_TYPES/);
  });

  test('C.1/C.2/C.3 AC22-AC30 AC128 AC129 the offline suites are green @SI-045 @SI-017 @SI-048', () => {
    const manifest = path.join(BACK_ROOT as string, GA, 'plan/compile/__fixtures__/rebaselines/rebaseline-1-phase-1-fr22-fr26-fr27.json');
    expect(existsSync(manifest)).toBe(true);
    const r = spawnSync(
      'npx',
      ['jest', `${GA}/plan/claims-match-operations.spec.ts`, `${GA}/plan/compile/plan-identity-rebaseline.spec.ts`, `${GA}/plan/compiled-planner-terminal-classes.spec.ts`, '--silent'],
      { cwd: BACK_ROOT, encoding: 'utf8', env: { ...process.env, CI: '1', E2E_LIVE_LLM: '' }, timeout: 5 * 60_000 },
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

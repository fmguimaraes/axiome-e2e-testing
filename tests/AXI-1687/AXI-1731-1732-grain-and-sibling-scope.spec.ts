import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1731 (FR79 grain wiring) and AXI-1732 (non-oracular sibling refusal), epic AXI-1687.
 * Offline: Jest only; E2E_LIVE_LLM is removed from the child env (never set, not even empty).
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md, GW1731.1 and SS1732.1.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const PLAN = 'apps/organization-service/src/guided-analysis/plan';
const FAMILY = 'apps/organization-service/src/guided-analysis/family';

const jest = (specs: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  return spawnSync('npx', ['jest', ...specs, '--silent'], { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
};

test.describe('AXI-1731 / AXI-1732 (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('GW1731.1 AC79 the AUC interval is reported only on an asserted subject grain @SI-045', () => {
    const r = jest([`${PLAN}/node-grain-narration.spec.ts`, `${PLAN}/referent-grain.spec.ts`, `${PLAN}/discrimination-narration.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('SS1732.1 AC103 a foreign-tenant sibling and a nonexistent sibling are indistinguishable @SI-045', () => {
    const r = jest([`${FAMILY}/sibling-result-reader.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

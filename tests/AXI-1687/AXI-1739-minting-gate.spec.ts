import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1739 (epic AXI-1687): the gate on statistical Evidence/Decision minting.
 * Offline: Jest only; E2E_LIVE_LLM is removed from the child env (never set, not even empty).
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md, MG1739.1 to MG1739.3.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const SENTENCE = 'apps/organization-service/src/result-sentence';

const jest = (specs: string[], name?: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  const args = ['jest', ...specs, '--silent', ...(name ? ['-t', name] : [])];
  return spawnSync('npx', args, { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
};

test.describe('AXI-1739 (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('MG1739.1 a human-started ad-hoc statistical run mints no Evidence and no Decision by default @SI-045', () => {
    const r = jest([`${SENTENCE}/statistical-sentence.caller.spec.ts`], 'UT-MINTGATE-1739-001');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MG1739.2 a plan-driven run still mints, by plan node or by the durable governed actor @SI-045', () => {
    const r = jest([`${SENTENCE}/statistical-sentence.caller.spec.ts`], 'UT-MINTGATE-1739-002|UT-NARRCALL-1734-030');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MG1739.3 the mode and per-workspace allow-list control minting; unknown mode falls back @SI-045', () => {
    const r = jest([`${SENTENCE}/statistical-sentence.caller.spec.ts`], 'UT-MINTGATE-1739-(003|004|005)');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

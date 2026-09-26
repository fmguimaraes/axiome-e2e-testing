import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1734 (epic AXI-1687): the production caller of the grain-gated AUC / cut-off narrators.
 * Offline: Jest only; E2E_LIVE_LLM is removed from the child env (never set, not even empty).
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md, NC1734.1 to NC1734.4.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const SENTENCE = 'apps/organization-service/src/result-sentence';
const GOVEXEC = 'apps/organization-service/src/governed-execution/executor';
const PLAN = 'apps/organization-service/src/guided-analysis/plan';

const jest = (specs: string[], name?: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  const args = ['jest', ...specs, '--silent', ...(name ? ['-t', name] : [])];
  return spawnSync('npx', args, { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
};

test.describe('AXI-1734 (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('NC1734.1 AC79 the AUC interval reaches a completed run\'s sentence only when its plan node asserts one row per subject @SI-045', () => {
    const r = jest([`${SENTENCE}/statistical-sentence.caller.spec.ts`], 'UT-NARRCALL-1734-(001|002|030|031)');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('NC1734.2 AC83 the cut-off tally sentence reports Wilson intervals only on an asserted grain and keeps the optimism statement @SI-045', () => {
    const r = jest([`${SENTENCE}/statistical-sentence.caller.spec.ts`], 'UT-NARRCALL-1734-(003|004|032)');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('NC1734.3 the run-completion path supplies the plan node for a run\'s own completion and never for a reuse or a dedup @SI-045', () => {
    const r = jest([`${SENTENCE}/statistical-sentence.caller.spec.ts`, `${GOVEXEC}/rule-runs-analysis-runner.spec.ts`], undefined);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('NC1734.4 only the two statistical operations gain a sentence; describe and every other operation are unchanged, and the narrators are untouched @SI-045', () => {
    const r = jest([`${SENTENCE}`, `${PLAN}/node-grain-narration.spec.ts`, `${PLAN}/discrimination-narration.spec.ts`, `${PLAN}/cutoff-tally-narration.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1706 (epic AXI-1687, area M — Validation handoff; FR87-FR91, FR118).
 * Offline: Jest only; E2E_LIVE_LLM is removed from the child env (never set, not even empty).
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md, VH1706.1 to VH1706.6
 * (VH1706.6 asserts only that plan identity does not move — FR91's narration module is not
 * wired into the compiler yet, by design; see the changelog v0.37 entry).
 */
test.use({ storageState: { cookies: [], origins: [] } });
const KERNEL = 'apps/organization-service/src/rule-runs/kernel';
const DECISION_DRAFTS = 'apps/organization-service/src/decision-drafts';
const COMPILE = 'apps/organization-service/src/guided-analysis/plan/compile';

const jest = (specs: string[], name?: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  const args = ['jest', ...specs, '--silent', ...(name ? ['-t', name] : [])];
  return spawnSync('npx', args, { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
};

test.describe('AXI-1706 (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('VH1706.1 a measured subject-overlap count is refused by count only, never by naming a subject/patient id (FR118, EC42) @SI-047', () => {
    const r = jest([`${KERNEL}/cross-snapshot-application.spec.ts`], 'UT-VALHO-1706-1[0-3]');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('VH1706.2 apply() refuses on a measured overlap and never on a zero or absent one (FR118) @SI-047', () => {
    const r = jest([`${DECISION_DRAFTS}/candidate-application.service.spec.ts`], 'AXI-1706');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('VH1706.3 a request to validate a frozen candidate routes to Apply\'s own surface (FR87) @SI-047', () => {
    const r = jest([`${COMPILE}/apply-routing.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('VH1706.4 validating a non-cut-off finding (an AUC, a correlation) has no path, distinct from FR87\'s route (FR90, ruling 37) @SI-047', () => {
    const r = jest([`${COMPILE}/none-routing.spec.ts`], 'UT-VALHO-1706-3[0-2]');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('VH1706.5 a fan\'s holdout narration is one of exactly two states, and an unanchored fan writes no split fact (FR91, EC38) @SI-047', () => {
    const r = jest([`${COMPILE}/panel-holdout-narrative.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('VH1706.6 nothing in this story moves the p9-corpus plan identity (hard constraint) @SI-047', () => {
    const r = jest([`${COMPILE}/grados-golden.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

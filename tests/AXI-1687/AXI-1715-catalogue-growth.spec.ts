import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1715 (epic AXI-1687 — O·W7, FR107/FR111; AC107/AC111). A new `survival_km`
 * shape (declared time/event columns, the already-registered `stats.kaplan_meier`,
 * intent rule I15) and a new `doctrine_out_of_scope` none-route class (calibration,
 * DCA, NRI, IDI, incremental value over clinical covariates, a priori power).
 * FR108/FR109 are documentation-only this story (no new code, see the feature doc's
 * v0.39 changelog entry); FR110 is explicitly OUT OF SCOPE (rulings 39/40 withdrawn,
 * moved to §16). Offline: Jest only; `E2E_LIVE_LLM` is removed from the child env
 * (never set, not even empty) — no LLM turn involved in either mechanism.
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section AXI-1715.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const SRC = 'apps/organization-service/src';
const PLAN = `${SRC}/guided-analysis/plan`;
const COMPILE = `${PLAN}/compile`;

const jest = (specs: string[], grep?: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  const args = grep ? [...specs, '-t', grep] : specs;
  return spawnSync('npx', ['jest', ...args, '--silent'], { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
};

test.describe('AXI-1715 catalogue growth: survival shape + doctrine-list meta class (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('CG1715.1 a conforming survival_km intent on a dataset declaring survivalColumns compiles cleanly @SI-045 @SI-017', () => {
    const r = jest([`${PLAN}/intent-rules.spec.ts`], 'UT-CATGROW-1715-010');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('CG1715.2 I15 fires when the referenced dataset declares no survivalColumns; never fires for another shape @SI-017', () => {
    const r = jest([`${PLAN}/intent-rules.spec.ts`], 'UT-CATGROW-1715-01[12]');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('CG1715.3 survival_km compiles into a compare_groups plan node bound to stats.kaplan_meier, over the per-shape fixture matrix @SI-045 @SI-017', () => {
    const r = jest([`${COMPILE}/compile-intent.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('CG1715.4 calibration/DCA/NRI/IDI/incremental-value/a-priori-power route to doctrine_out_of_scope, "out of the planner\'s scope" @SI-017', () => {
    const r = jest([`${COMPILE}/none-routing.spec.ts`], 'UT-CATGROW-1715-001');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('CG1715.5 the doctrine-list class outranks covariate_adjustment on shared vocabulary; an ordinary confounding question is unaffected @SI-017', () => {
    const r = jest([`${COMPILE}/none-routing.spec.ts`], 'UT-CATGROW-1715-00[23]');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('CG1715.6 plan identity is unmoved: golden bank + per-shape fixtures stay green, no new re-baseline manifest @SI-017', () => {
    const r = jest([`${COMPILE}/grados-golden.spec.ts`, `${COMPILE}/plan-identity-rebaseline.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('CG1715.7 the shape registry totality guard accepts survival_km (I12-keyed, role keys agree with stats.kaplan_meier) @SI-045', () => {
    const r = jest([`${COMPILE}/shape-catalogue.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

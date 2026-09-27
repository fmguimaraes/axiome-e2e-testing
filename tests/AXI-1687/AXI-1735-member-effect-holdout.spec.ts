import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1735 - Q.W8 Per-member effect and screen/holdout stage in the back family block (epic AXI-1687, FR76, FR91).
 * Offline: Jest only; E2E_LIVE_LLM is removed from the child env (never set, not even empty).
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section MFX1735.1 to MFX1735.6.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const SRC = 'apps/organization-service/src';

const jest = (specs: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  return spawnSync('npx', ['jest', ...specs, '--silent'], { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
};

test.describe('AXI-1735 per-member effect and screen/holdout (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('MFX1735.1 AC76 the effect column is declared read-side and is an existing output column @SI-017', () => {
    const r = jest([`${SRC}/rule-runs/kernel/effect-declaration.spec.ts`, '-t', 'already outputs|declares none']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MFX1735.2 AC76 the descriptor effectColumn is three-state @SI-046', () => {
    const r = jest([`${SRC}/rule-runs/kernel/effect-declaration.spec.ts`, `${SRC}/rule-runs/operation-descriptor.contract.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MFX1735.3 AC76 a member effect is one finite declared cell, else an explicit null @SI-046', () => {
    const r = jest([`${SRC}/governed-execution/executor/rule-runs-member-effect-reader.spec.ts`, `${SRC}/governed-execution/domain/run-detail-family-members.spec.ts`, '-t', 'MEMBERFX-1735-00[4-6]|MEMBERFX-1735-009|MEMBERFX-1735-01|1729-009']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MFX1735.4 FR91 screenHoldout is the stamped stage, verbatim, else null @SI-046', () => {
    const r = jest([`${SRC}/governed-execution/domain/run-detail-family-members.spec.ts`, '-t', 'screenHoldout']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MFX1735.5 AC30 exactly five plan-identity manifests; kernel export surface exact @SI-017', () => {
    const dir = path.join(BACK_ROOT as string, `${SRC}/guided-analysis/plan/compile/__fixtures__/rebaselines`);
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBe(5);
    const r = jest([`${SRC}/rule-runs/kernel/index.spec.ts`, `${SRC}/guided-analysis/plan/compile/plan-identity-rebaseline.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

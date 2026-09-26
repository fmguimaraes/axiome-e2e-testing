import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1729 - Q.W8 Gateway additive projections for the front (epic AXI-1687, FR73, FR75, FR76).
 * Offline: Jest only; E2E_LIVE_LLM is removed from the child env (never set, not even empty).
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section GW1729.1 to GW1729.5.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const SRC = 'apps/organization-service/src';

const jest = (specs: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  return spawnSync('npx', ['jest', ...specs, '--silent'], { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
};

test.describe('AXI-1729 gateway additive projections (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('GW1729.1 AC73 the shape list is served from the registry, one entry per compilable shape @SI-046 @SI-045', () => {
    const r = jest([`${SRC}/guided-analysis/plan/compile/shape-catalogue.spec.ts`, 'apps/gateway/src/proxy/guided-analysis.controller.spec.ts']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('GW1729.2 AC75 the descriptor interval is three-state: declared, explicit null, absent only when unserved @SI-046', () => {
    const r = jest([`${SRC}/rule-runs/kernel/operation-descriptor-interval.spec.ts`, `${SRC}/rule-runs/kernel/operation-descriptor.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('GW1729.3 AC76 per-member interval, omnibus marker and unit statement are read from declarations @SI-046', () => {
    const r = jest([`${SRC}/governed-execution/domain/run-detail-family-members.spec.ts`, '-t', 'interval|omnibus|unit statement|no operation binding']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('GW1729.4 AC76 effect and screen/holdout are explicit nulls, never fabricated @SI-046', () => {
    const r = jest([`${SRC}/governed-execution/domain/run-detail-family-members.spec.ts`, '-t', 'explicit nulls']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('GW1729.5 AC30 no third plan-identity re-baseline; kernel export surface stays exact @SI-017', () => {
    const dir = path.join(BACK_ROOT as string, `${SRC}/guided-analysis/plan/compile/__fixtures__/rebaselines`);
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBe(3);
    const r = jest([`${SRC}/rule-runs/kernel/index.spec.ts`, `${SRC}/guided-analysis/plan/compile/plan-identity-rebaseline.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

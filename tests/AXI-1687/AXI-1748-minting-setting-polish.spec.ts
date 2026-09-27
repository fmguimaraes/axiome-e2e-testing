import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1748 (epic AXI-1687): review-advisory polish over AXI-1746 — the resolver
 * cache is evicted on every write, and `mode: null` reverts to the deployment
 * default by deleting the row.
 * Offline: Jest only; E2E_LIVE_LLM is removed from the child env (never set, not even empty).
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md, MP1748.1 to MP1748.4
 * (MP1748.5 is manual, with its reason).
 */
test.use({ storageState: { cookies: [], origins: [] } });
const MINTING_SETTING = 'apps/organization-service/src/statistical-minting-setting';
const PROXY = 'apps/gateway/src/proxy';

const jest = (specs: string[], name?: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  const args = ['jest', ...specs, '--silent', ...(name ? ['-t', name] : [])];
  return spawnSync('npx', args, { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
};

test.describe('AXI-1748 (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('MP1748.1 a valid-mode PUT evicts the resolver cache for the workspace; a refused PUT never does @SI-045', () => {
    const r = jest(
      [`${MINTING_SETTING}/statistical-minting-setting.service.spec.ts`],
      'UT-MINTPOL-1748-00[12]',
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MP1748.2 mode: null deletes the row (never upsert), evicts the cache, and is idempotent on an unset workspace @SI-045', () => {
    const r = jest(
      [`${MINTING_SETTING}/statistical-minting-setting.service.spec.ts`],
      'UT-MINTPOL-1748-00[34]',
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MP1748.3 the RPC bridge relays a null service result as null, and still shapes a non-null record @SI-045', () => {
    const r = jest([`${MINTING_SETTING}/statistical-minting-setting.message.controller.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MP1748.4 the gateway forwards mode: null through to the RPC payload under the same tenancy/permission guards @SI-045', () => {
    const r = jest(
      [`${PROXY}/statistical-minting-setting.controller.spec.ts`],
      'UT-MINTPOL-1748-007',
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

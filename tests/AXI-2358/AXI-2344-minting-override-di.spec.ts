import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from '../AXI-1687/harness/sibling-repos';

/**
 * AXI-2344 (epic AXI-2358): the per-workspace statistical-minting override
 * (AXI-1746, `PUT /workspaces/:id/statistical-minting-setting`) actually changes
 * what a completed STATISTICAL run mints. The defect was a DI wiring fact
 * (`import type` erased the resolver; Nest injected `undefined`), so the evidence
 * is a backend Jest suite that compiles a REAL Nest testing module — the same
 * offline, Jest-through-Playwright shape as AXI-1746/AXI-1748's specs.
 * Offline: Jest only; E2E_LIVE_LLM is removed from the child env (never set, not even empty).
 * Scenario doc: manual-e2e/AXI-2358-Platform-Opening-Headless-Fast-Follow-Defects.md, MO2344.1 to MO2344.4.
 * MO2344.5 (live API round trip on a running stack) is deferred, with its reason, in that doc.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const DI_SPEC = 'apps/organization-service/src/result-sentence/result-sentence.minting-override.di.spec.ts';

const jest = (name: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  return spawnSync('npx', ['jest', DI_SPEC, '--silent', '-t', name], {
    cwd: BACK_ROOT,
    encoding: 'utf8',
    env,
    timeout: 5 * 60_000,
  });
};

test.describe('AXI-2344 (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('MO2344.1 the Nest container injects the real resolver into ResultSentenceService (no erased type, never undefined) @SI-017 @SI-045', () => {
    const r = jest('UT-RULES-7400');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MO2344.2 PUT mode=all mints a human-started run; PUT mode=off blocks a governed run; setting wins over env @SI-017 @SI-045', () => {
    const r = jest('UT-RULES-740[123]');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MO2344.3 the override is confined to its own workspace @SI-017 @SI-045', () => {
    const r = jest('UT-RULES-7404');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MO2344.4 PUT mode=null reverts on the next completion; the client-report render honours the override @SI-017 @SI-045', () => {
    const r = jest('UT-RULES-740[56]');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

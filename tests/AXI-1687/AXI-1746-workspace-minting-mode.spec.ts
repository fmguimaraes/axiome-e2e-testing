import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1746 (epic AXI-1687): a per-workspace DB setting overrides the env
 * STATISTICAL_MINTING_MODE (setting > env; the env allow-list keeps applying
 * under whichever mode is in effect).
 * Offline: Jest only; E2E_LIVE_LLM is removed from the child env (never set, not even empty).
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md, MM1746.1 to MM1746.4
 * (MM1746.5 is manual, with its reason).
 */
test.use({ storageState: { cookies: [], origins: [] } });
const SENTENCE = 'apps/organization-service/src/result-sentence';
const MINTING_SETTING = 'apps/organization-service/src/statistical-minting-setting';
const PROXY = 'apps/gateway/src/proxy';

const jest = (specs: string[], name?: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  const args = ['jest', ...specs, '--silent', ...(name ? ['-t', name] : [])];
  return spawnSync('npx', args, { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
};

test.describe('AXI-1746 (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('MM1746.1 no per-workspace override resolves exactly as the env-only gate did before this story @SI-045', () => {
    const r = jest(
      [`${SENTENCE}/statistical-minting-gate.spec.ts`, `${SENTENCE}/statistical-sentence.caller.spec.ts`],
      'UT-MINTMODE-1746-001|UT-MINTMODE-1746-005|UT-MINTMODE-1746-042',
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MM1746.2 a per-workspace override to off blocks minting a run the env mode would have allowed @SI-045', () => {
    const r = jest(
      [`${SENTENCE}/statistical-minting-gate.spec.ts`, `${SENTENCE}/statistical-sentence.caller.spec.ts`],
      'UT-MINTMODE-1746-00[23]|UT-MINTMODE-1746-04[01]',
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MM1746.3 the write is refused without the governs_analysis_parameters permission; the read stays open @SI-045', () => {
    const r = jest([`${PROXY}/statistical-minting-setting.controller.spec.ts`], 'UT-MINTMODE-1746-0(10|11|12|13|14|15)');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('MM1746.4 an invalid mode value is rejected before the setting is persisted @SI-045', () => {
    const r = jest([`${MINTING_SETTING}/statistical-minting-setting.service.spec.ts`], 'UT-MINTMODE-1746-02[0-4]');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

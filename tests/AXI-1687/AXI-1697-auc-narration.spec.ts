import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1697 - K.W5 Biomarker discrimination, AUC narration (back) (epic AXI-1687). Offline: files
 * and Jest only, fixture rows in the shape bio-compute AXI-1698 persists. No planner, API,
 * bio-compute process or provider key is reached; E2E_LIVE_LLM is never read.
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section K.1 to K.4.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const GA = 'apps/organization-service/src/guided-analysis';
const NARRATION = `${GA}/plan/discrimination-narration.ts`;

function requireBack(): void {
  const missing = missingRepos(['back']);
  test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
}
const codeOnly = (file: string): string =>
  readFileSync(path.join(BACK_ROOT as string, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

function jest(specs: string[]) {
  return spawnSync('npx', ['jest', ...specs, '--silent'], {
    cwd: BACK_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', E2E_LIVE_LLM: '' },
    timeout: 5 * 60_000,
  });
}

test.describe('AXI-1697 AUC narration', () => {
  test.beforeEach(requireBack);

  test('K.1 AC78 the narrator never derives an AUC: no read of uStatistic or effectSize-to-AUC arithmetic @SI-045', () => {
    const src = codeOnly(NARRATION);
    expect(existsSync(path.join(BACK_ROOT as string, NARRATION))).toBe(true);
    expect(src).not.toMatch(/uStatistic/);
    expect(src).not.toMatch(/\(?\s*effect\w*\s*\+\s*1\s*\)?\s*\/\s*2/);
  });

  test('K.2 AC78 AC79 AC80 EC12 the narration and registry suites are green (older artifact, separation, small n, disclaimers) @SI-045 @SI-017', () => {
    const r = jest([`${GA}/plan/discrimination-narration.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('K.3 AC80 the Mann-Whitney output scheme lists the five AUC columns and its claim keys include sampling_design @SI-017 @SI-048', () => {
    const reg = codeOnly('apps/organization-service/src/rule-runs/kernel/operation-registry.ts');
    const block = reg.slice(reg.indexOf("operationId: 'stats.mann_whitney_u'"), reg.indexOf("operationId: 'stats.kruskal_wallis'"));
    for (const c of ['auc', 'aucCiLow', 'aucCiHigh', 'aucCiMethod', 'aucCiLevel']) expect(block).toContain(`'${c}'`);
    const claims = codeOnly('apps/organization-service/src/rule-runs/kernel/claim-declarations.ts');
    expect(claims).toMatch(/'stats\.mann_whitney_u':\s*\[\.\.\.BETWEEN_ARMS,\s*'sampling_design'\]/);
  });

  test('K.4 AC30 AC128 the claim, registry and plan-identity suites still pass with the new columns @SI-045', () => {
    const r = jest([
      `${GA}/plan/claims-match-operations.spec.ts`,
      `${GA}/plan/compile/plan-identity-rebaseline.spec.ts`,
      `${GA}/plan/compile/grados-golden.spec.ts`,
      'apps/organization-service/src/rule-runs/surface-spec/surface-spec-drift.spec.ts',
    ]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

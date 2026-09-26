import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, E2E_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1737 - fourth PlanStatus `superseded` (epic AXI-1687, ruling 16). Offline: files and Jest
 * only. No planner, API or provider key is reached; E2E_LIVE_LLM is never read. Scenario doc:
 * manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section AXI-1737.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const GA = 'apps/organization-service/src/guided-analysis';

function requireBack(): void {
  const missing = missingRepos(['back']);
  test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
}
const jest = (specs: string[]) =>
  spawnSync('npx', ['jest', ...specs, '--silent'], {
    cwd: BACK_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', E2E_LIVE_LLM: '' },
    timeout: 5 * 60_000,
  });

test.describe('AXI-1737 PlanStatus superseded', () => {
  test.beforeEach(requireBack);

  test('PS1737.1 the vocabulary is draft|ignored|run|superseded and superseded is terminal, never reached from run @SI-045', () => {
    const r = jest([`${GA}/plan/plan-status.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('PS1737.2 supersession leaves run plans run; the annotate script sets status and stays dry-run @SI-045', () => {
    const r = jest([`${GA}/plan/scope-annotation.spec.ts`, `${GA}/plan/plan-ledger.service.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const script = readFileSync(path.join(BACK_ROOT as string, 'scripts/annotate-pre-declaration-plans.ts'), 'utf8');
    expect(script).toMatch(/DRY-RUN BY DEFAULT/);
    expect(script).toMatch(/process\.argv\.includes\('--apply'\)/);
    expect(script).toMatch(/supersededStatusFor/);
    expect(script).toMatch(/status: t\.status/);
  });

  test('PS1737.3 the front plan listing labels superseded as Superseded, never Draft @SI-002', () => {
    const suffix = path.basename(E2E_ROOT).replace(/^axiome-e2e-testing/, '');
    const p = [process.env.AXIOME_FRONT_ROOT, path.join(path.dirname(E2E_ROOT), `axiome-front${suffix}`), path.join(path.dirname(E2E_ROOT), 'axiome-front')].find(
      (c) => !!c && existsSync(path.join(c, 'src/lib/guidedAnalysis/planListingSurface.ts')),
    ) as string | undefined;
    test.skip(!p, 'front checkout not found');
    const src = readFileSync(path.join(p as string, 'src/lib/guidedAnalysis/planListingSurface.ts'), 'utf8');
    expect(src).toMatch(/superseded: 'Superseded'/);
    expect(src).toMatch(/KNOWN_PLAN_STATUSES = new Set<string>\(\[[^\]]*'superseded'/);
  });
});

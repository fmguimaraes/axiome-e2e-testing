import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from '../AXI-1687/harness/sibling-repos';

/**
 * AXI-1670 (epic AXI-1575 — "decide the production planner arm"): a live,
 * permission-protected runtime switch for which planner arm
 * (compiled/anthropic/fallback) serves a workspace's guided-analysis requests,
 * with no redeploy. Manual-e2e scenario doc:
 * `axiome-docs/manual-e2e/AXI-1575-Summary-Rule-Authoring-And-Connector-Expansion.md`
 * (AXI-1670 section).
 *
 * Same pattern as this epic's AXI-1746 workspace-minting-mode spec: the
 * subject under test — a permission gate, a per-workspace DB override and a
 * "no redeploy" live-routing claim — is fully provable offline against the
 * real reader (orchestrator, resolver, proxy controller, front-end hook +
 * component), so this shells to the real suites and asserts their exit codes
 * rather than driving a browser against a live stack. No LLM call is made
 * (`E2E_LIVE_LLM` is never set, not even empty).
 */
test.use({ storageState: { cookies: [], origins: [] } });

const GUIDED = 'apps/organization-service/src/guided-analysis';
const PROXY = 'apps/gateway/src/proxy';

function requireBack(): void {
  const missing = missingRepos(['back']);
  test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
}

function jest(specs: string[], name?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  const args = ['jest', ...specs, '--silent', ...(name ? ['-t', name] : [])];
  return spawnSync('npx', args, { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
}

/**
 * FOLLOW-UP (same debt the AXI-1687 W5 step3 spec already notes): no shared
 * front-root resolver exists in `harness/sibling-repos.ts` yet, so this
 * mirrors that file's local `resolveSibling` rather than inventing a second
 * shape. Fold both into the shared harness together, next time either moves.
 */
function resolveFrontRoot(): string | undefined {
  const fromEnv = process.env.AXIOME_FRONT_ROOT;
  const marker = 'src/components/guidedAnalysis/PlannerArmToggle.tsx';
  if (fromEnv) return existsSync(path.join(fromEnv, marker)) ? fromEnv : undefined;
  const parent = path.dirname(BACK_ROOT ?? '');
  const suffix = path.basename(BACK_ROOT ?? '').replace(/^axiome-back/, '');
  return [path.join(parent, `axiome-front${suffix}`), path.join(parent, 'axiome-front')].find((c) =>
    existsSync(path.join(c, marker)),
  );
}
const FRONT_ROOT = resolveFrontRoot();

function vitest(specs: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.E2E_LIVE_LLM;
  return spawnSync('npx', ['vitest', 'run', ...specs], { cwd: FRONT_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
}

test.describe('AXI-1670 (back) — resolver, service, orchestrator routing, proxy controller', () => {
  test.beforeEach(requireBack);

  test('no override resolves exactly as pre-AXI-1670 env-only behaviour @SI-045', () => {
    const r = jest(
      [`${GUIDED}/plan/plan-orchestrator.planner-arm-routing.spec.ts`],
      'omitting the resolver/instances entirely',
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('a write is visible to the very next plan request — the switch is consulted LIVE, per call @SI-045', () => {
    const r = jest(
      [`${GUIDED}/plan/plan-orchestrator.planner-arm-routing.spec.ts`],
      'repeated call re-resolves per call',
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('a repository failure resolves to no override (deny-nothing), never throws @SI-045', () => {
    const r = jest([`${GUIDED}/planner-arm-setting/planner-arm.resolver.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('the write is refused without governs_analysis_parameters; the read stays open @SI-010', () => {
    const r = jest([`${PROXY}/planner-arm-setting.controller.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('put derives updatedBy server-side and rejects an unknown arm value @SI-045', () => {
    const r = jest([`${GUIDED}/planner-arm-setting/planner-arm-setting.service.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

test.describe('AXI-1670 (front) — permission-gated control on the guided analysis question page', () => {
  test('the control renders only for a permitted user; a selection routes through save() @SI-046', () => {
    test.skip(!FRONT_ROOT, 'axiome-front checkout not found');
    const r = vitest([
      'src/hooks/usePlannerArmSetting.test.tsx',
      'src/components/guidedAnalysis/PlannerArmToggle.test.tsx',
    ]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from '../AXI-1687/harness/sibling-repos';

/**
 * AXI-1890 (epic AXI-1883 — UI/UX Hardening, "Access control gating").
 * Manual-e2e scenario doc:
 * `axiome-docs/manual-e2e/AXI-1883-UI-UX-Hardening.md`.
 *
 * AC10 covers THREE gated surfaces (FR16 Discovery Workbench, FR17 planner
 * override, FR18 API Access link). Investigation found FR16 and FR17 already
 * implemented and backend-enforced by pre-existing permissions
 * (`guided_analysis:view`, `governs_analysis_parameters` respectively) —
 * this spec proves that by running their EXISTING unit suites (never
 * rewritten here) and confirming the front-end source still reads the same
 * gate. Only FR18 is new work in this story, pinned by its own new specs.
 *
 * Same strategy as this epic's sibling permission-gate specs
 * (`AXI-1575/AXI-1670-planner-arm-switch.spec.ts`,
 * `AXI-1687/AXI-1746-workspace-minting-mode.spec.ts`): the subject under
 * test — a permission declared identically on the UI's read and the
 * gateway's write/read guard (NFR1) — is fully provable offline against the
 * real reader (permission constants, role seed, proxy controller, front-end
 * hook), so this shells to the real jest/vitest suites and asserts their
 * exit codes rather than driving a browser.
 *
 * Why not a browser run against a live worktree stack: this story changes
 * backend code (a new permission + a new gateway endpoint), so a live E2E
 * needs an isolated worktree stack. `axiome-infra/scripts/wt-up.sh`, run
 * against this story's single-submodule worktrees, resolved the worktree
 * slug against the PRIMARY `axiome-global` checkout (not an isolated
 * worktree — the script expects a superrepo-level worktree with every
 * submodule present) and refused to write `axiome-infra/.env` because it
 * already held an unrelated secret key the script does not generate
 * (`GUIDED_ANALYSIS_ANTHROPIC_API_KEY`). Forcing it (`WT_ENV_FORCE=1`)
 * would have overwritten the PRIMARY checkout's `.env`, shared by every
 * other concurrent session — reported, not forced. This file is authored
 * and its jest/vitest shells are run (status asserted below); no Chromium
 * `page` fixture is driven against a live stack for this story.
 *
 * Run: `npx playwright test tests/AXI-1883/AXI-1890-access-control-gating.spec.ts
 * --project=chromium --no-deps` — `--no-deps` is required (same reason the
 * `shadow-run-api` project in `playwright.config.ts` documents): this spec has
 * no UI interaction and does not consume the `setup` project's `storageState`
 * (overridden to empty below), but the `chromium` project still declares
 * `dependencies: ['setup']`, which would otherwise force a live-stack admin
 * login this spec never needs.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const LIBS_COMMON_PERMISSIONS = 'libs/common/src/permissions';
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

/** Same local resolver this epic's AXI-1670 spec already uses, for the same reason: no shared front-root resolver exists in `harness/sibling-repos.ts` yet. */
function resolveFrontRoot(): string | undefined {
  const fromEnv = process.env.AXIOME_FRONT_ROOT;
  const marker = 'src/hooks/useDatasetApiAccessCapability.ts';
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

function readFront(relPath: string): string {
  if (!FRONT_ROOT) throw new Error('axiome-front checkout not found');
  return readFileSync(path.join(FRONT_ROOT, relPath), 'utf8');
}

test.describe('AXI-1890 (back) — dataset:api_access permission + its role seed (FR18)', () => {
  test.beforeEach(requireBack);

  test('the permission string is defined and seeded onto viewer/editor/approver/admin, denied to sponsor_viewer @SI-011', () => {
    const r = jest([`${LIBS_COMMON_PERMISSIONS}/permissions.constants.spec.ts`], 'dataset:api_access');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('GET /dataset-api-access declares @RequirePermission(dataset:api_access) and requires a workspace context @SI-010', () => {
    const r = jest([`${PROXY}/dataset-api-access.controller.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

test.describe('AXI-1890 (front) — the API Access link/page gate (FR18)', () => {
  test('the gate requires BOTH the client permission AND a live backend call to agree @SI-032', () => {
    test.skip(!FRONT_ROOT, 'axiome-front checkout not found');
    const r = vitest(['src/hooks/useDatasetApiAccessCapability.test.tsx']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('WorkspaceDatasets.tsx hides the link behind the same dataset:api_access source (source check) @SI-032', () => {
    test.skip(!FRONT_ROOT, 'axiome-front checkout not found');
    const src = readFront('src/pages/WorkspaceDatasets.tsx');
    expect(src).toMatch(/hasPermission\(roleId, 'dataset:api_access'\)/);
    // the button is now conditionally rendered, never unconditional
    expect(src).not.toMatch(/>\s*\n\s*<button\s*\n\s*onClick=\{\(\) => navigate\('\/datasets\/api-access'\)\}/);
  });

  test("DatasetApiAccess.tsx gates a direct URL visit, not only the link (source check) @SI-032", () => {
    test.skip(!FRONT_ROOT, 'axiome-front checkout not found');
    const src = readFront('src/pages/DatasetApiAccess.tsx');
    expect(src).toMatch(/useDatasetApiAccessCapability/);
    expect(src).toMatch(/Access denied/);
  });
});

test.describe('AXI-1890 — FR16 (Discovery Workbench) and FR17 (planner override) already gated (verified, no new code)', () => {
  test.beforeEach(requireBack);

  test('FR16: guided_analysis:view is required on the plan/session/execute routes @SI-046', () => {
    const r = jest([`${PROXY}/guided-analysis.controller.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('FR17: the planner-override write is refused without governs_analysis_parameters @SI-010', () => {
    const r = jest([`${PROXY}/planner-arm-setting.controller.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('FR16 (front): DiscoveryWorkbench and the workbench entry read guided_analysis:view (source check) @SI-046', () => {
    test.skip(!FRONT_ROOT, 'axiome-front checkout not found');
    const workbench = readFront('src/pages/DiscoveryWorkbench.tsx');
    expect(workbench).toMatch(/hasPermission\(roleId, 'guided_analysis:view'\)/);
    expect(workbench).toMatch(/Access denied/);
    const list = readFront('src/pages/ProjectViewAnalyses.tsx');
    expect(list).toMatch(/hasPermission\(roleId, 'guided_analysis:view'\)/);
  });

  test('FR17 (front): PlannerArmToggle renders nothing without governs_analysis_parameters (its own spec) @SI-046', () => {
    test.skip(!FRONT_ROOT, 'axiome-front checkout not found');
    const r = vitest(['src/components/guidedAnalysis/PlannerArmToggle.test.tsx']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

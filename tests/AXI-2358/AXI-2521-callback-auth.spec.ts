import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from '../AXI-1687/harness/sibling-repos';

/**
 * AXI-2521 (epic AXI-2358): the org-service render result callback
 * (`POST /internal/render/:specId/result`) had no guard, so any caller able to
 * reach it could write any `dvi_` key into that spec's render cache. It now
 * requires the job token `RenderService.render()` mints and bio-compute echoes
 * as `Authorization: Bearer`, bound to `job_id = render_<specId>` and
 * `run_type = dataview_render`. The same defect class on
 * `/internal/candidates/:profileId/{result,progress}` is fixed the same way.
 *
 * The evidence is a backend Jest suite that boots a REAL Nest HTTP app around
 * the controller with the REAL `JobTokenService` (real HS256 JWTs) and drives it
 * with supertest — the offline Jest-through-Playwright shape of AXI-2344.
 * Offline: Jest only; E2E_LIVE_LLM is removed from the child env.
 * Scenario doc: manual-e2e/AXI-2358-Platform-Opening-Headless-Fast-Follow-Defects.md, 2521.1 to 2521.4.
 * 2521.5 (live stack, unauthenticated POST against a running org-service) is
 * deferred with its reason in that doc.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const SPECS = [
  'apps/organization-service/src/render/render.callback.controller.spec.ts',
  'apps/organization-service/src/candidates/candidates.callback.controller.spec.ts',
  'apps/organization-service/src/render/render.service.spec.ts',
];

const jest = (name: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  return spawnSync('npx', ['jest', ...SPECS, '--silent', '-t', name], {
    cwd: BACK_ROOT,
    encoding: 'utf8',
    env,
    timeout: 5 * 60_000,
  });
};

/** A `-t` filter that matches nothing exits 0 with "0 total" — refuse that. */
const expectRan = (r: ReturnType<typeof jest>, atLeast: number) => {
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  const m = /Tests:[^\n]*?(\d+) passed/.exec(r.stderr);
  expect(r.stderr, 'no failed test').not.toMatch(/Tests:[^\n]*\d+ failed/);
  expect(Number(m?.[1] ?? 0), r.stderr).toBeGreaterThanOrEqual(atLeast);
};

test.describe('AXI-2521 (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('AC1 — a render callback with no / non-Bearer / forged / expired token is refused 401 and caches nothing (2521.1) @SI-018 @SI-020', () => {
    expectRan(jest('UT-VIEW-706[0-3]'), 4);
  });

  test("AC2 — another spec's render token, or another run type's token for the same id, is refused 403 (2521.2) @SI-018 @SI-020", () => {
    expectRan(jest('UT-VIEW-706[45]'), 2);
  });

  test('AC3 — the token render() actually dispatches is accepted for its spec; snapshotId is still forwarded (2521.3) @SI-018 @SI-020', () => {
    expectRan(jest('UT-VIEW-(706[67]|7029)'), 3);
  });

  test('AC4 — the candidates result/progress callbacks refuse a missing, foreign or profiling token and accept their own (2521.4) @SI-018 @SI-020', () => {
    expectRan(jest('UT-VIEW-(706[89]|707[0-2])'), 7);
  });
});

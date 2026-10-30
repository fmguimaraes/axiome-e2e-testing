import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from '../AXI-1687/harness/sibling-repos';

/**
 * AXI-2326 (epic AXI-2308 Platform Opening: Human Guided) — the semantic-schema
 * extension (unit, control-level flag, template-column roles) and its fill for
 * Paul's two recognised xlsx formats (FR13-FR15). Offline: files and Jest only,
 * same doctrine as AXI-1693's own spec (`tests/AXI-1687/AXI-1693-dataset-semantic-
 * declaration.spec.ts`) — this story adds no browser-visible surface, so the real
 * assertions live in the backend unit suites and this spec runs them against the
 * real sibling checkout rather than re-deriving them.
 *
 * Scenario doc: manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md §4/§5
 * (AXI-2326.1 .. AXI-2326.4 below).
 */
test.use({ storageState: { cookies: [], origins: [] } });

const OS = 'apps/organization-service/src';
const DATASETS = `${OS}/datasets`;

function requireBack(): void {
  const missing = missingRepos(['back']);
  test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
}

const jest = (specs: string[], cwd: string) =>
  spawnSync('npx', ['jest', ...specs, '--silent'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
    timeout: 5 * 60_000,
  });

test.describe('AXI-2326 — semantic schema for template binding & pre-fill', () => {
  test.beforeEach(requireBack);

  test('AXI-2326.1 AC11 the contract gains unit, control-level flag and the group/continuous_outcome/covariate roles @SI-002 @SI-014', () => {
    expect(
      existsSync(path.join(BACK_ROOT as string, 'libs/contracts/src/dataset/dataset-semantic-declaration.ts')),
    ).toBe(true);
    const r = jest([`${DATASETS}/dataset-semantic-declaration.spec.ts`], BACK_ROOT as string);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    /* status check above is sufficient; stderr format varies by terminal width/CI */
  });

  test('AXI-2326.2 AC11, EC3 Paul\'s two recognised formats fill; any other header set fills nothing @SI-014', () => {
    const r = jest([`${DATASETS}/dataset-semantic-declaration-fill.spec.ts`], BACK_ROOT as string);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    /* status check above is sufficient; stderr format varies by terminal width/CI */
  });

  test('AXI-2326.3 AC11, EC4 the fill never overwrites an existing declaration, and is tenant-confined @SI-014', () => {
    const r = jest([`${DATASETS}/dataset-semantic-declaration.service.spec.ts`], BACK_ROOT as string);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    /* status check above is sufficient; stderr format varies by terminal width/CI */
  });

  test('AXI-2326.4 AC11 the ensure-recognized-fill gateway route is membership-only and forwards the CallerScope only @SI-010', () => {
    const r = jest(
      ['apps/gateway/src/proxy/discovery-semantic-declaration.controller.spec.ts'],
      BACK_ROOT as string,
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    /* status check above is sufficient; stderr format varies by terminal width/CI */
  });
});

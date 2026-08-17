import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { parseQuarantine, quarantineList } from '../../scripts/quarantine-report';

/**
 * Flake quarantine (AXI-1271 — FR38/FR39, NFR2, AC18).
 *
 * Verifies the quarantine parser: a `@flaky <AXI-BUG>` test is detected with its
 * linked bug, and a `@flaky` without a bug is flagged (quarantine is never
 * silent). The demo quarantined test below carries a real linked bug (AXI-1273)
 * and is excluded from the merge gate by `--grep-invert @flaky`.
 */
const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test.describe('AXI-1271 — flake quarantine', () => {
  test('AC18 — a quarantined test is detected with its linked bug', () => {
    expect(parseQuarantine('x.spec.ts', `  test('AC1 — sometimes red @flaky AXI-1273', async () => {});`)).toEqual([
      { file: 'x.spec.ts', title: 'AC1 — sometimes red @flaky AXI-1273', bug: 'AXI-1273' },
    ]);
  });

  test('AC18 — a quarantined test without a linked bug is flagged (not silent)', () => {
    const q = parseQuarantine('x.spec.ts', `  test('AC1 — flaky no bug @flaky', async () => {});`);
    expect(q).toEqual([{ file: 'x.spec.ts', title: 'AC1 — flaky no bug @flaky', bug: null }]);
  });

  test('AC18 — the live suite lists the demo quarantined spec with its bug', () => {
    const demo = quarantineList(testsDir).find((q) => /AXI-1273/.test(q.title));
    expect(demo).toBeTruthy();
    expect(demo?.bug).toBe('AXI-1273');
  });

  // Demo quarantined test: excluded from the merge gate (`--grep-invert @flaky`),
  // still reported by the quarantine report, and carrying a linked bug (AXI-1273).
  test('AC18 — demo quarantined spec is excluded from the gate @flaky AXI-1273', { tag: '@flaky' }, async () => {
    expect(true).toBe(true);
  });
});

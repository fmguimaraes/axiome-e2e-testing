import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { lintSource, lintSpecs } from '../../scripts/lint-specs';

/**
 * Spec-convention binding (AXI-1265 — FR15/FR16/FR17/FR18, NFR4/NFR5/NFR10, AC9/AC10).
 *
 * Verifies the linter that enforces the binding: `test()` titles must lead with
 * the AC/FR/NFR IDs they verify, fixed sleeps are rejected, and raw CSS/XPath
 * selectors are flagged. Then asserts the whole live suite already complies —
 * so the convention is enforced, not merely documented.
 */
const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test.describe('AXI-1265 — spec-convention linter', () => {
  test('AC10 — a title not leading with an AC/FR/NFR ID is an error', () => {
    const v = lintSource('x.spec.ts', `test('filter persists across reload', async () => {});`); // lint-specs-ignore
    expect(v.some((x) => x.rule === 'title-leads-with-ac-id' && x.severity === 'error')).toBe(true);
  });

  test('AC10 — a title leading with AC IDs passes', () => {
    const v = lintSource('x.spec.ts', `test('AC3 AC4 — filter persists across reload', async () => {});`); // lint-specs-ignore
    expect(v.filter((x) => x.rule === 'title-leads-with-ac-id')).toEqual([]);
  });

  test('NFR4 — a fixed-duration sleep is an error', () => {
    const v = lintSource('x.spec.ts', `await page.waitForTimeout(1000);`); // lint-specs-ignore
    expect(v.some((x) => x.rule === 'no-fixed-sleep' && x.severity === 'error')).toBe(true);
  });

  test('NFR5 — a raw CSS/XPath locator is a warning', () => {
    const v = lintSource('x.spec.ts', `page.locator('.some-class');`); // lint-specs-ignore
    expect(v.some((x) => x.rule === 'prefer-semantic-selector' && x.severity === 'warning')).toBe(true);
  });

  test('AC9 AC10 — every spec in the live suite complies (no errors)', () => {
    const errors = lintSpecs(testsDir).filter((v) => v.severity === 'error');
    expect(errors).toEqual([]);
  });
});

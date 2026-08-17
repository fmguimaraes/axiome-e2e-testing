import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { parseJUnitTotals, buildFigure, renderFigure, crossStoryFlows } from '../../scripts/epic-acceptance';

/**
 * Epic acceptance figure (AXI-1270 — FR34/FR35, AC17).
 *
 * Verifies the acceptance figure derives from a real JUnit report (not an
 * assertion) and lists the epic's cross-story `epic-*.spec.ts` flows, so the
 * Workflow-5 integrated-E2E figure and the Workflow-6 PQ citation rest on a
 * machine record.
 */
const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'AXI-1260');

test.describe('AXI-1270 — epic acceptance figure', () => {
  const xml = `<testsuites tests="31" failures="0" errors="0" skipped="1"><testsuite/></testsuites>`;

  test('AC17 — totals parse from the JUnit report root', () => {
    expect(parseJUnitTotals(xml)).toEqual({ total: 31, failures: 0, skipped: 1 });
  });

  test('AC17 — a green figure derives from the report, not an assertion', () => {
    const f = buildFigure('AXI-1260', xml, testsDir);
    expect(f.green).toBe(true);
    expect(f.passed).toBe(30);
    expect(f.total).toBe(31);
  });

  test('AC17 — a failing report yields a RED figure', () => {
    const red = buildFigure('AXI-1260', `<testsuites tests="10" failures="2" skipped="0"></testsuites>`, testsDir);
    expect(red.green).toBe(false);
    expect(red.failed).toBe(2);
    expect(renderFigure(red)).toMatch(/RED/);
  });

  test('AC17 — the figure lists the epic cross-story flows and cites manual residue', () => {
    expect(crossStoryFlows(testsDir)).toContain('epic-toolchain.spec.ts');
    expect(renderFigure(buildFigure('AXI-1260', xml, testsDir))).toMatch(/Manual residue/);
  });
});

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import {
  parseJUnitTotals, buildFigure, renderFigure, crossStoryFlows,
  splitTitle, lastGotoPath, toDeeplink, buildDeeplinkRows, renderDeeplinkTable,
} from '../../scripts/epic-acceptance';

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

test.describe('AXI-1270 — verifiability table (Feature / Description / Deeplink)', () => {
  test('AC17 — a title leading with AC/FR/NFR IDs splits into feature and description', () => {
    expect(splitTitle('AC3 AC4 — filter persists across reload'))
      .toEqual({ feature: 'AC3 AC4', description: 'filter persists across reload' });
  });

  test('AC17 — an untagged title falls back to the whole string as the description', () => {
    expect(splitTitle('smoke check')).toEqual({ feature: '(untagged)', description: 'smoke check' });
  });

  test('AC17 — the last page.goto step wins over an earlier one', () => {
    const steps = [
      { title: "page.goto('/login')" },
      { title: 'expect.toBeVisible', steps: [{ title: "page.goto('/workspaces/42')" }] },
    ];
    expect(lastGotoPath(steps)).toBe('/workspaces/42');
  });

  test('AC17 — no goto step yields no path', () => {
    expect(lastGotoPath([{ title: 'expect.toBeVisible' }])).toBeUndefined();
  });

  test('AC17 — a relative goto path resolves against BASE_URL; an absolute one passes through', () => {
    expect(toDeeplink('/workspaces/42')).toMatch(/\/workspaces\/42$/);
    expect(toDeeplink('https://staging.axiome.example/help/9')).toBe('https://staging.axiome.example/help/9');
    expect(toDeeplink(undefined)).not.toBe('');
  });

  test('AC17 — a JSON reporter tree flattens into one row per executed test with its deeplink', () => {
    const report = {
      suites: [{
        specs: [{ title: 'AC1 — opens the workspace detail page', tests: [{
          results: [{ steps: [{ title: "page.goto('/workspaces/7')" }] }],
        }] }],
        suites: [{
          specs: [{ title: 'AC2 — filters the dataset list', tests: [{
            results: [{ steps: [] }],
          }] }],
        }],
      }],
    };
    const rows = buildDeeplinkRows(report);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      feature: 'AC1', description: 'opens the workspace detail page',
      deeplink: expect.stringContaining('/workspaces/7'),
    });
    expect(rows[1].feature).toBe('AC2');
  });

  test('AC17 — the rendered table is a markdown pipe table with a clickable deeplink per row', () => {
    const md = renderDeeplinkTable([
      { feature: 'AC1', description: 'opens the workspace detail page', deeplink: 'http://localhost:5173/workspaces/7' },
    ]);
    expect(md).toContain('| Feature | Description | Deeplink |');
    expect(md).toContain('[Open](http://localhost:5173/workspaces/7)');
  });

  test('AC17 — no executed tests yields no table', () => {
    expect(renderDeeplinkTable([])).toBe('');
  });
});

import { test, expect } from '@playwright/test';
import { specAcMap, parseScenarios, featureIds, buildCoverage } from '../../scripts/coverage-report';

/**
 * Coverage report (AXI-1266 — FR19/FR20/FR21, AC11).
 *
 * Verifies the report maps AC IDs to specs and detects the two failure modes:
 * a `playwright` scenario with no spec (gap) and a spec citing an unknown ID
 * (orphan). Pure-function fixtures keep it deterministic and cross-repo-free.
 */
test.describe('AXI-1266 — coverage report', () => {
  test('AC11 — maps AC IDs from test titles to spec files', () => {
    const map = specAcMap([
      { file: 'a/AXI-1-foo.spec.ts', source: `test('AC1 AC2 — x', async () => {});` },
      { file: 'a/AXI-2-bar.spec.ts', source: `test('AC2 — y', async () => {});` },
    ]);
    expect(map.AC1).toEqual(['AXI-1-foo.spec.ts']);
    expect(map.AC2).toEqual(['AXI-1-foo.spec.ts', 'AXI-2-bar.spec.ts']);
  });

  test('AC11 — flags a playwright scenario with no covering spec as a gap', () => {
    const scenarios = parseScenarios([
      { file: 'E.md', source: '### Covered flow\n_ACs:_ AC1\n_automation:_ playwright\n\n### Uncovered flow\n_ACs:_ AC9\n_automation:_ playwright\n' },
    ]);
    const cov = buildCoverage({ AC1: ['s.spec.ts'] }, scenarios, new Set(['AC1', 'AC9']));
    expect(cov.gaps.map((g) => g.heading)).toEqual(['Uncovered flow']);
  });

  test('AC11 — a manual scenario without a spec is not a gap', () => {
    const scenarios = parseScenarios([
      { file: 'E.md', source: '### Feel check\n_ACs:_ AC9\n_automation:_ manual — needs human eyes\n' },
    ]);
    const cov = buildCoverage({}, scenarios, new Set(['AC9']));
    expect(cov.gaps).toEqual([]);
  });

  test('AC11 — flags a spec citing an ID absent from the Feature docs as an orphan', () => {
    const validIds = featureIds([{ source: 'Defines AC1 and AC2 only.' }]);
    const cov = buildCoverage({ AC1: ['s.spec.ts'], AC99: ['s.spec.ts'] }, [], validIds);
    expect(cov.orphans).toEqual([{ spec: 's.spec.ts', id: 'AC99' }]);
  });
});

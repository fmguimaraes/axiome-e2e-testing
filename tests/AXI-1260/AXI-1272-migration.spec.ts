import { test, expect } from '@playwright/test';
import { fileStatus } from '../../scripts/migration-status';

/**
 * Lazy-migration mechanics (AXI-1272 — FR36/FR37, AC21).
 *
 * Verifies the conversion-state summary: playwright / manual / untagged counts,
 * and that a `manual` scenario without a stated reason is flagged (FR37 — a
 * scenario retagged manual must say why, never left as a silent gap).
 */
test.describe('AXI-1272 — lazy migration status', () => {
  const sample = [
    '### Automated flow',
    '_ACs:_ AC1',
    '_automation:_ playwright',
    '',
    '### Feel check',
    '_ACs:_ AC2',
    '_automation:_ manual — needs human judgement',
    '',
    '### Legacy flow',
    '_ACs:_ AC3',
    '',
  ].join('\n');

  test('AC21 — counts playwright, manual, and untagged scenarios', () => {
    const s = fileStatus('AXI-1260-Foo.md', sample);
    expect(s.playwright).toBe(1);
    expect(s.manual).toBe(1);
    expect(s.untagged).toBe(1);
    expect(s.manualMissingReason).toEqual([]);
  });

  test('FR37 — a manual scenario without a stated reason is flagged', () => {
    const s = fileStatus('AXI-1260-Foo.md', '### Bare manual\n_ACs:_ AC4\n_automation:_ manual\n');
    expect(s.manual).toBe(1);
    expect(s.manualMissingReason).toEqual(['Bare manual']);
  });
});

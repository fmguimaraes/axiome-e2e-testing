import { test, expect } from '@playwright/test';
import { deriveLabel, buildComment, gateReport } from '../../scripts/story-e2e-gate';
import { INFRA_FAULT_EXIT_CODE } from '../../preflight/preflight';

/**
 * Workflow 4 step-g gate (AXI-1269 — FR32/FR33, AC15/AC16).
 *
 * The label is derived purely from the run's exit code, so `e2e-pass` can never
 * be an asserted claim (AC16); an infrastructure fault is distinct from a test
 * failure (FR28); and the comment cites the run, scenario file, and spec paths
 * (FR33).
 */
test.describe('AXI-1269 — Workflow 4 step-g gate', () => {
  test('AC16 — e2e-pass only from exit code 0', () => {
    expect(deriveLabel(0)).toBe('e2e-pass');
  });

  test('AC16 — any non-zero, non-infra exit is e2e-fail (never asserted pass)', () => {
    expect(deriveLabel(1)).toBe('e2e-fail');
    expect(deriveLabel(2)).toBe('e2e-fail');
  });

  test('FR28 — the reserved infra-fault code is a distinct environment fault, not e2e-fail', () => {
    expect(deriveLabel(INFRA_FAULT_EXIT_CODE)).toBe('infra-fault');
  });

  test('AC15 FR33 — the comment cites the run result, scenario file, and spec paths', () => {
    const r = gateReport('AXI-1260', 'AXI-1269', 0);
    expect(r.label).toBe('e2e-pass');
    expect(r.comment).toContain('tests/AXI-1260/AXI-1269-*.spec.ts');
    expect(r.comment).toContain('manual-e2e/AXI-1260-*.md');
    expect(r.comment).toContain('exit 0');
  });

  test('FR28 — an infra-fault comment says "not a defect" and blocks rework routing', () => {
    const comment = buildComment({
      label: 'infra-fault', exitCode: INFRA_FAULT_EXIT_CODE, epic: 'AXI-1260',
      story: 'AXI-1269', specGlob: 'x', scenarioFile: 'y',
    });
    expect(comment).toMatch(/not a defect/i);
    expect(comment).toMatch(/do not route to rework/i);
  });
});

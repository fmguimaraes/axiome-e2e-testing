import { test, expect } from '@playwright/test';
import { runSteps } from '../../staging/steps/runSteps';
import type { Step } from '../../staging/steps/types';

/**
 * AXI-1371 — step-graph runner (dev-epic-context: "ordering is a declared
 * dependency graph, not script sequence"). Pure, no REST calls.
 * Manual-E2E §AXI-1368 §5.5.
 *
 * @SI-044.
 */

function recordingStep(id: string, dependsOn: string[], order: string[]): Step<unknown> {
  return { id, dependsOn, run: async () => void order.push(id) };
}

test.describe('Step graph — dependency-ordered execution', () => {
  test('FR5 — runs steps in dependency order regardless of declaration order', async () => {
    const order: string[] = [];
    const steps = [recordingStep('c', ['b'], order), recordingStep('a', [], order), recordingStep('b', ['a'], order)];
    await runSteps(steps, {});
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('FR5 — a step with no dependencies runs without waiting on declaration position', async () => {
    const order: string[] = [];
    const steps = [recordingStep('first', [], order), recordingStep('second', [], order)];
    await runSteps(steps, {});
    expect(order).toEqual(['first', 'second']);
  });

  test('FR5 — an unknown dependency fails loudly instead of running out of order', async () => {
    const steps = [recordingStep('a', ['missing'], [])];
    await expect(runSteps(steps, {})).rejects.toThrow(/unknown step/);
  });

  test('FR5 — a cycle fails loudly instead of hanging or silently dropping a step', async () => {
    const steps = [recordingStep('a', ['b'], []), recordingStep('b', ['a'], [])];
    await expect(runSteps(steps, {})).rejects.toThrow(/cycle/);
  });
});

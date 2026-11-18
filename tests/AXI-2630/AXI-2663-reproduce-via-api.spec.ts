/**
 * AXI-2663 (epic AXI-2630, FR73, FR74, AC54, AC55; SI-042). The MAG4 reproduction as one headless
 * scenario. Runs in the `handover-api` project: no browser, no storage state, no trace.
 */
import { expect, test } from '@playwright/test';
import { runReproduction } from './reproduction/reproduce';

test.describe('AXI-2663 MAG4 reproduction via API @SI-042', () => {
  test('AC55 AXI-2663.1 a new project built through the API reports every section 20 value as matching @SI-042', async () => {
    test.setTimeout(30 * 60 * 1000);

    const outcome = await runReproduction(process.env, process.cwd());

    expect(outcome.exitCode, `${outcome.verdict}: ${outcome.message}`).toBe(0);
  });
});

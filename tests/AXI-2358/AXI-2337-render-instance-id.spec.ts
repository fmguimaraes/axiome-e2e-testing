import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { ingestFixture } from '../AXI-2309/harness/chart-style';
import { pollAnyCandidate, renderAndPoll, renderWith } from './AXI-2337-render-harness';

/**
 * AXI-2337 (epic AXI-2358 — restores Headless FR12–FR15).
 *
 * Scenario doc: manual-e2e/AXI-2358-Platform-Opening-Headless-Fast-Follow-Defects.md,
 * "AXI-2337" section (2337.1, 2337.2; 2337.3/2337.4 are `manual`, covered by
 * unit tests).
 *
 * API-level only. Reuses AXI-2312's fixture + ingestion helper read-only
 * (`chart-style-multi.csv`: `group` 8 A / 8 B rows) and renders any gallery
 * candidate spec of that raw dataset — the render path under test is
 * template-agnostic, and `rowCountInput` (rows reaching the renderer AFTER
 * filters) is the observable for global-filter application, independent of
 * the renderer's own binding resolution (AXI-2347).
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const DVI = /^dvi_[0-9a-f]{16}$/;
const GROUP_A = [{ slicer_id: 'col_group', op: 'in', values: ['A'] }];

let api: Api;
let t: Tenant;
let specId: string;
let unfilteredRows: number;
let unfilteredId: string;

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  const datasetId = await ingestFixture(api, t);
  specId = (await pollAnyCandidate(api, t, datasetId)).id;
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-2337 — render-then-poll resolves; global filters applied (FR12/FR15)', { tag: ['@SI-018', '@SI-017'] }, () => {
  test('FR12 — a render reaches ready under the instance id it was dispatched with (2337.1)', async () => {
    const { dispatched, ready } = await renderAndPoll(api, t, specId);

    expect(dispatched.instanceId).toMatch(DVI);
    expect(ready.status === 'ready' || ready.status === 'hit', JSON.stringify(ready)).toBe(true);
    expect(ready.instanceId, 'poll answered a different key than the dispatch').toBe(dispatched.instanceId);
    expect(ready.payload).toBeTruthy();
    expect(typeof ready.rowCountInput).toBe('number');
    unfilteredRows = ready.rowCountInput;
    unfilteredId = dispatched.instanceId;

    // A second render is a cache HIT on the SAME key — the artifact really
    // landed where the dispatch said it would.
    const again = await renderWith(api, t, specId);
    expect(again.cacheHit, JSON.stringify(again)).toBe(true);
    expect(again.instanceId).toBe(dispatched.instanceId);
  });

  test('FR12 FR15 — a global slicer filter renders a filtered payload under its own key (2337.2)', async () => {
    const { dispatched, ready } = await renderAndPoll(api, t, specId, GROUP_A);

    expect(dispatched.instanceId).toMatch(DVI);
    expect(dispatched.instanceId, 'a filtered render shares the unfiltered key').not.toBe(unfilteredId);
    expect(ready.instanceId).toBe(dispatched.instanceId);
    expect(ready.rowCountInput, 'global filter not applied — same row count as unfiltered').toBeLessThan(unfilteredRows);
    expect(ready.rowCountInput).toBeGreaterThan(0);
  });
});

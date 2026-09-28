import { test, expect, type Page, type Request } from '@playwright/test';
import {
  seedLiveWorkbench, primeWorkspace, declineHoldoutUrl, publishedRuleCode, runLiveScreen, SCREEN_OP, type Seeded,
} from '../AXI-1717/harness/live-workbench';

/**
 * AXI-1864 - a `json` operation parameter reaches the wire PARSED
 * (epic AXI-1775, FR15). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` section 17.
 * Tags: @SI-046 (the workbench Screen surface), @SI-045 (the governed screen step).
 *
 * AUTHORED, NOT EXECUTED - deferred on AXI-1818 (a 15-minute JWT against a 24.1-minute
 * batch contaminates every baseline in this suite; the suite has no CI signal either).
 * No `e2e-pass` is claimed for it. See section 17.2 of the scenario doc.
 *
 * The defect: the run-config parameter editor dispatched on
 * `boolean | enum | string | number` only, so a parameter the served descriptor declares
 * as `type: 'json'` fell through to the plain text input and its RAW TEXT was written into
 * `operationParams`. `stats.screen_shortlist` declares `comparisons` that way, so every
 * submit carried a JSON STRING where the kernel wants an array and the preflight answered
 * 400 "Rule run rejected" for every user.
 *
 * WHY THIS ASSERTS ON THE PAYLOAD, NOT ON THE RESULT: in preview mode the Screen node
 * renders a plausible result card whether or not a governed run ever happened - that is
 * exactly what masked this defect when it was found by hand. A spec that read the rendered
 * result would be green against the bug. The observable that actually separates the two
 * states is the TYPE of `operationParams.comparisons` on the request.
 */
const PREFLIGHT = /\/api\/v1\/rule-runs\/preflight$/;
const SUBMIT = /\/discovery\/analyses\/[^/]+\/steps\/screen\/submit$/;

const open = (page: Page, s: Seeded) => page.goto(`/projects/${s.projectId}/discovery-workbench?analysisId=${s.declaredAnalysisId}`);
const restored = (page: Page) => expect(page.getByTestId('discovery-workbench')).toHaveAttribute('data-restore-status', 'restored', { timeout: 60_000 });

/** Every request whose body carries `operationParams`, from either route. */
function recordParamCarriers(page: Page): { bodies: () => any[] } {
  const seen: Request[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && (PREFLIGHT.test(req.url()) || SUBMIT.test(req.url()))) seen.push(req);
  });
  return { bodies: () => seen.map((r) => r.postDataJSON()).filter(Boolean) };
}

test.describe('AXI-1864 - a json operation parameter is submitted parsed, never as its text (UI, real backend)', { tag: ['@SI-046', '@SI-045'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 360_000 });

  let s: Seeded;
  let code: string;

  test.beforeAll(async () => {
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1864-${tag}`, `AXI-1864 json param ${tag}`);
    code = await publishedRuleCode(s, SCREEN_OP);
    const declined = await s.api.post(declineHoldoutUrl(s.declaredAnalysisId, 'split'), { reason: 'axi-1864: exploratory arm' }, s.t.headers);
    expect(declined.body.declined, JSON.stringify(declined.body)).toBe(true);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR15 - the screen run carries `comparisons` as an ARRAY, and the preflight does not refuse it', async ({ page }) => {
    await primeWorkspace(page, s);
    await open(page, s);
    await restored(page);

    const carriers = recordParamCarriers(page);
    await runLiveScreen(page, code);

    const withComparisons = carriers.bodies()
      .map((b) => b?.operationParams?.comparisons)
      .filter((c) => c !== undefined);

    expect(withComparisons.length, 'the screen launch never carried a `comparisons` parameter — the assertion below would be vacuous').toBeGreaterThan(0);

    // The regression, stated as the exact substitution that caused it: a string
    // here is the pre-fix payload, and it is what the backend answered 400 to.
    for (const c of withComparisons) {
      expect(typeof c, `comparisons was sent as a ${typeof c}; the kernel refuses anything but an array`).not.toBe('string');
      expect(Array.isArray(c)).toBe(true);
      expect(c.length).toBeGreaterThan(0);
      for (const pair of c) expect(Object.keys(pair).sort()).toEqual(['from', 'to']);
    }
  });

  test('FR15 - no preflight in the screen launch was refused for a malformed operand', async ({ page }) => {
    await primeWorkspace(page, s);
    await open(page, s);
    await restored(page);

    const refused: number[] = [];
    page.on('response', (res) => { if (PREFLIGHT.test(res.url()) && res.status() >= 400) refused.push(res.status()); });

    await runLiveScreen(page, code);

    // Pre-fix this was a 400 "Rule run rejected" on the launch's own preflight.
    expect(refused, 'a preflight in the screen launch was refused — the run-config payload is malformed').toEqual([]);
  });
});

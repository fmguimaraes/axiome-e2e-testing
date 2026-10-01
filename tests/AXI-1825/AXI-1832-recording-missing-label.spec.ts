import { test, expect, Page } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import { ingestFixture } from '../AXI-1435/harness/seed';
import { anchorDataset } from '../AXI-1604/harness/anchor-dataset';
import { ensureTenant1832 } from './harness/tenant';

/**
 * AXI-1832 (epic AXI-1825 — rework, bounce #1: missing E2E automation; the
 * code itself, `unsupportedReasonLabel`'s new `recording_missing` case in
 * `axiome-front/src/lib/guidedAnalysis/unsupportedPlan.ts`, was found correct
 * in review with no defects).
 *
 * Proves the `recording_missing` label actually RENDERS in the live
 * `UnsupportedPlanCard` (`data-testid="ga-unsupported-reason"`), not just
 * that the pure function returns the right string in a unit test — the same
 * live-DOM gap `tests/AXI-1603/epic-unsupported-plan-ui.spec.ts` closes for
 * the `refused`/`precondition`/`no_shape` reasons.
 *
 * Forcing `recording_missing` deterministically, with ZERO live LLM spend:
 * per AXI-1758/AXI-1838 (`planner.service.ts` `plan()`'s interception guard,
 * ~line 243), `RecordedTransport` is checked BEFORE any shape classification
 * — a request whose exact payload has no committed recording under
 * `apps/organization-service/src/llm-debug/recordings/` is refused with
 * `unsupportedReason: 'recording_missing'` regardless of what the question
 * asks. This spec asks a question with a run-unique random suffix (never
 * recorded, never will be), which guarantees a cache miss every run — no
 * `E2E_LIVE_LLM` opt-in needed, matching the epic's recorded-transport
 * standing default (CLAUDE.md § LLM Calls).
 *
 * Mutation-proofing (epic gotcha: a latently-green assertion passes whether
 * the bug is there or not, AXI-1807): the assertion below is the EXACT label
 * string from `UNSUPPORTED_REASON_LABELS.recording_missing`, which differs
 * from both the `DEFAULT_UNSUPPORTED_REASON_LABEL` fallback ("No further
 * detail was reported for this outcome.") and every other reason's label —
 * reverting the story's one-line map addition changes this test's observed
 * text and fails it.
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const UNSUPPORTED_QUESTION = `AXI-1832 recording_missing probe ${Date.now()}-${Math.random().toString(36).slice(2)}`;

let api: Api;
let workspaceId: string;
let projectId: string;
let anchor: Awaited<ReturnType<typeof anchorDataset>>;

async function seedWorkspaceScope(page: Page, orgId: string): Promise<void> {
  await page.addInitScript(
    ([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [workspaceId, orgId] as const,
  );
}

let orgId: string;

test.beforeAll(async () => {
  api = await adminApi();
  const tenant = await ensureTenant1832(api);
  workspaceId = tenant.workspaceId;
  orgId = tenant.orgId;
  projectId = tenant.projectId;
  await ingestFixture(api, tenant, 'statistical-trigger.csv');
  anchor = await anchorDataset(api, workspaceId, projectId);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test(
  'FR25 AC17 — the live guided panel renders the recording_missing label for a never-recorded question',
  { tag: ['@SI-046'] },
  async ({ page }) => {
    test.skip(!anchor, 'no dataset available in the seeded tenant');
    await seedWorkspaceScope(page, orgId);
    await page.goto(`/guided-analysis?scope=project&projectId=${projectId}&workspaceId=${workspaceId}`);

    await expect(page.getByTestId('ga-question')).toBeVisible({ timeout: 25_000 });
    await page.getByTestId('ga-question').fill(UNSUPPORTED_QUESTION);
    await page.getByTestId('ga-send').click();

    await expect(page.getByTestId('ga-unsupported-state')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('ga-unsupported-question')).toHaveText(UNSUPPORTED_QUESTION);
    await expect(page.getByTestId('ga-unsupported-reason')).toHaveText(
      'No recorded answer is available for this question yet.',
    );

    // FR25 — still no run affordance for this reason either.
    await expect(page.getByTestId('plan-run')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^run$/i })).toHaveCount(0);
  },
);

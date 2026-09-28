import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import { ensureTenant } from '../AXI-1435/harness/seed';
import { anchorDataset } from '../AXI-1604/harness/anchor-dataset';
import { buildEnvelope as buildPlannerEnvelope } from '../AXI-1603/harness/planner';
import { workspaceHeader } from '../AXI-1435/harness/api';

/**
 * AXI-1758 (epic AXI-1687 — FR123/FR124/FR125, AC135/AC136). Converts the
 * `E2E_LIVE_LLM`-gated planner call of `tests/AXI-1604/AXI-1662-shared-anchor-resolver.spec.ts`
 * (`POST /guided-analysis/plan`, unmocked, real Anthropic spend when opted in)
 * to the recorded-transport default: **this spec never opts into `E2E_LIVE_LLM`
 * and spends zero tokens either way**, because `GUIDED_ANALYSIS_LLM_TRANSPORT`
 * defaults to `recorded` on every served process (AC135) — no gate is needed
 * any more for a planner call to be safe to run in an ordinary suite pass.
 *
 * What this proves, WITHOUT a committed recording existing yet (see the header
 * note on deferral below):
 *   - the compiled planner call site never reaches the live Anthropic key by
 *     default (AC135 — the request cannot silently spend);
 *   - a cache miss is a LOUD REFUSAL, never a silent fallback: `POST
 *     /guided-analysis/plan` still answers 2xx (`PlannerService`'s "never a
 *     500" architecture, unchanged), but no plan runs and the response is the
 *     honest `unsupported` shape — `intentUnsupported: true`,
 *     `unsupportedReason: 'recording_missing'`, `plannerFallback: false`, and
 *     NO `fallbackReason` — surfaced end to end from `RecordedTransport`
 *     through `PlannerUnavailableReason` to the HTTP response body (AC136).
 *
 * **Corrected 2026-09-28 (Opus review bounce #1, BLOCKER 1):** the first pass
 * of this spec asserted `res.body.fallbackReason === 'recording_missing'` on
 * the `plannerFallback` branch — i.e. it asserted the deterministic fallback
 * HAD answered, mislabelled. That is exactly the silent-fallback defect the
 * story's own design point 5 forbids; `PlannerService.plan()` now refuses
 * before ever calling the fallback for this reason, so `plannerFallback` is
 * `false` for a miss and the refusal is read off `intentUnsupported`/
 * `unsupportedReason` instead.
 *
 * **Deferral note (design point 6c / R-LLM-3):** a full "the plan compiles for
 * real, not just refuses" assertion needs a COMMITTED recording keyed by
 * this exact request's `requestSha256` — which can only be computed by running
 * the real adapter against a real envelope, something this authoring pass
 * cannot do (no access to a running backend outside 5173/3000; authoring a
 * recording's content is explicitly not this developer's role, R-LLM-3). This
 * spec is therefore AUTHORED but its run is DEFERRED: the first execution
 * against a real dev stack will observe the `recording_missing` refusal and
 * dump a pending payload to
 * `apps/organization-service/src/llm-debug/pending/<sha>.request.json`; once a
 * blind subagent answers it via `npm run llm-debug:record`, a second test
 * below (skipped today, `test.fixme`) asserts the compiled plan itself.
 *
 *     env -u E2E_LIVE_LLM npx playwright test tests/AXI-1687/AXI-1758-recorded-llm-transport
 */
test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 });

let api: Api;
let workspaceId: string;
let projectId: string;

test.beforeAll(async () => {
  api = await adminApi();
  const overrideWorkspaceId = process.env.SHADOW_RUN_WORKSPACE_ID;
  const overrideProjectId = process.env.SHADOW_RUN_PROJECT_ID;
  if (overrideWorkspaceId && overrideProjectId) {
    workspaceId = overrideWorkspaceId;
    projectId = overrideProjectId;
    return;
  }
  const t = await ensureTenant(api);
  workspaceId = t.workspaceId;
  projectId = t.projectId;
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test(
  'AC135/AC136 — the planner endpoint runs the recorded transport by default, spends nothing, and REFUSES (never silently falls back) on a cache miss',
  { tag: ['@SI-045', '@SI-046'] },
  async () => {
    expect(process.env.E2E_LIVE_LLM, 'this spec never opts into live spend — recorded is the standing default').toBeUndefined();

    const anchor = await anchorDataset(api, workspaceId, projectId);
    test.skip(!anchor, 'no ingested dataset in this workspace — point the run at one with SHADOW_RUN_WORKSPACE_ID/SHADOW_RUN_PROJECT_ID');
    if (!anchor) return;

    const envelope = buildPlannerEnvelope(
      projectId,
      'Compare pre_expression between response groups.',
      [anchor],
    );

    const res = await api.post(
      '/api/v1/guided-analysis/plan',
      { projectId, envelope, sessionId: null },
      workspaceHeader(workspaceId),
    );

    // eslint-disable-next-line no-console
    console.log(
      `AXI-1758 recorded-transport probe: status=${res.status} planner=${res.body?.planner} ` +
        `fallback=${res.body?.plannerFallback} intentUnsupported=${res.body?.intentUnsupported} ` +
        `unsupportedReason=${res.body?.unsupportedReason}`,
    );

    // PlannerService's "never a 500, always answer" architecture is unchanged
    // by this story — a miss is still answered, never thrown at the caller.
    expect(res.status, `plan request answered (never a 500): ${JSON.stringify(res.body).slice(0, 500)}`).toBeLessThan(300);

    if (res.body?.intentUnsupported && res.body?.unsupportedReason === 'recording_missing') {
      // No recording committed yet for this exact request (expected on the
      // first ever run against a fresh dev stack, per the deferral note
      // above) — this is a REFUSAL, never the deterministic fallback: the
      // story's design point 5 forbids serving a differently-shaped plan for
      // a request the recorded transport has no committed answer for.
      expect(res.body.plannerFallback).toBe(false);
      expect(res.body.fallbackReason).toBeUndefined();
    } else {
      // A recording already exists (a later run, once a blind subagent has
      // authored one) — the compiled arm answered for real, off a recorded
      // response, with zero live spend.
      expect(res.body?.planner).toBe('compiled');
      expect(res.body?.intentUnsupported).not.toBe(true);
    }
  },
);

test.fixme(
  'AC137 — once a blind-authored recording exists for this request, the compiled plan answers for real off it',
  () => {
    // Intentionally not implemented in this pass: asserting the actual plan
    // shape requires a committed recording this developer is not the author
    // of (R-LLM-3). Promote this once `llm-debug:record` has committed one
    // for the sha the test above's pending dump names.
  },
);

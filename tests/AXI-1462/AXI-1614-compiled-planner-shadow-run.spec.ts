import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import { ensureTenant } from '../AXI-1435/harness/seed';
import { anchorDataset } from './harness/governed';
import { runShadowBank, writeShadowRunRows } from './harness/shadow';

/**
 * AXI-1614 (epic AXI-1603 — FR28, AC21, SI-042). The compiled-planner shadow
 * run: exercises the whole Grados bank once against the backend's CURRENTLY
 * configured `GUIDED_ANALYSIS_LLM_PROVIDER`, live, and writes the raw
 * per-question rows the `axiome-back` aggregation script formats into the FR28
 * Markdown report.
 *
 * Run against the local demo stack twice — once per provider — restarting the
 * backend with `GUIDED_ANALYSIS_LLM_PROVIDER=compiled` and again with
 * `GUIDED_ANALYSIS_LLM_PROVIDER=anthropic` between runs (no staging tier
 * exists, per the story's own technical requirement). `SHADOW_RUN_PROVIDER`
 * tells THIS harness which label to stamp on the rows it writes — it does not,
 * and cannot, change what the already-running backend process is configured
 * with (`planner.factory.ts` reads the env var once, at module construction).
 *
 *     SHADOW_RUN_PROVIDER=compiled npx playwright test AXI-1614-compiled-planner-shadow-run
 *     SHADOW_RUN_PROVIDER=anthropic npx playwright test AXI-1614-compiled-planner-shadow-run
 *     npm --workspace organization-service run guided-analysis:shadow-report -- \
 *       --in ../axiome-e2e-testing/tests/AXI-1462/harness/shadow-run/compiled.json \
 *       --in ../axiome-e2e-testing/tests/AXI-1462/harness/shadow-run/anthropic.json
 *
 * A 46-question live run against a real Anthropic-backed provider can take
 * several minutes per provider (up to 5 attempts x 150s deadline on a hard
 * case) — this spec's own timeout is sized generously rather than tuned.
 *
 * AXI-1616 — `ensureTenant()`'s own dedicated workspace ("AXI-1435 Statistical
 * Trigger Surface") carries no ingested dataset, so `anchorDataset()` always
 * returns `null` there and the run skips (honest, not a defect — AC21's own
 * comment already documents this as "deferred to the W5 acceptance
 * environment"). `SHADOW_RUN_WORKSPACE_ID`/`SHADOW_RUN_PROJECT_ID` let the
 * operator point the run at a workspace/project that already has a real
 * ingested dataset (e.g. the seeded "Public Datasets — IO Benchmarks" /
 * "Riaz 2017 — Nivolumab Melanoma" pair) instead — never fabricated, always a
 * real dataset already in the tenant. Unset, behaviour is unchanged
 * (`ensureTenant()`).
 */
test.describe.configure({ mode: 'serial', timeout: 30 * 60_000 });

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
  'AC21 — the Grados bank runs once against the configured provider and writes the raw shadow-run rows',
  { tag: ['@SI-045'] },
  async () => {
    const provider = process.env.SHADOW_RUN_PROVIDER ?? 'unspecified';
    const dataset = await anchorDataset(api, workspaceId, projectId);
    test.skip(!dataset, 'could not anchor a dataset for the shadow run — deferred to the W5 acceptance environment');
    if (!dataset) return;

    const rows = await runShadowBank(api, workspaceId, projectId, provider, [dataset]);
    expect(rows).toHaveLength(46);

    const path = writeShadowRunRows(provider, rows);
    // eslint-disable-next-line no-console
    console.log(`wrote ${rows.length} shadow-run rows for provider '${provider}' to ${path}`);
  },
);

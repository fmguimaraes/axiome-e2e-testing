import { test, expect } from '@playwright/test';
import { ensureTenant } from '../AXI-1435/harness/seed';
import { anchorDataset } from '../AXI-1604/harness/anchor-dataset';
import {
  createAdminShadowRunAuth,
  runShadowBankGuarded,
  shouldRunArm,
  writeShadowRunRows,
  writeShadowRunSummary,
  type ShadowRunAuth,
} from './harness/shadow';

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
 *
 * AXI-1677 adds three operator controls, all defaulting to the previous
 * behaviour:
 *
 *   SHADOW_RUN_DATASET_ID   Anchor EXACTLY this dataset instead of the first
 *                           available one in the workspace. The workspace the
 *                           run uses holds ~150 datasets, many of them
 *                           intermediate `*_result.parquet` files with a NULL
 *                           `file_hash`, so "the first one" is neither stable
 *                           across runs nor necessarily anchorable. A gate
 *                           measurement names its own input. A targeted id that
 *                           cannot be reached THROWS — it never falls back.
 *                           (`tests/AXI-1604/AXI-1677-synthetic-grados-seed.spec.ts`
 *                           seeds and prints an id suitable for this.)
 *
 *   SHADOW_RUN_ARMS         Comma-separated provider arms this operator intends
 *                           to run, e.g. `compiled`. An invocation whose
 *                           SHADOW_RUN_PROVIDER is not in the list SKIPS, so one
 *                           env setting can drive both invocations and the
 *                           legacy one becomes a no-op. FR30(c) v0.5 withdrew
 *                           the "no lower than the legacy arm's" clause, so the
 *                           amended gate no longer compares the arms and no
 *                           longer needs a second paid 46-question run. Unset,
 *                           every arm runs, exactly as before.
 *
 *   SHADOW_RUN_REAUTH_EVERY How many questions between proactive token
 *                           re-mints (default 10, `0` disables). The E2E access
 *                           token's TTL is shorter than a full 46-question run:
 *                           on 2026-09-25 it expired at Q8 of the legacy arm and
 *                           39 of 46 rows were 401s recorded as `unavailable`.
 *                           A 401 that survives a refresh now FAILS the run.
 *
 * AXI-1749 (owner go on AXI-1716, B2): this spec now goes through
 * `runShadowBankGuarded`, never the unguarded `runShadowBank` — the FR50/FR53
 * guard (`GUIDED_ANALYSIS_LIVE_SPEND_GO` + a `GO:`-marked run-registry row,
 * `decideHarnessLiveSpend`) and `SHADOW_RUN_QUESTIONS` (a NAMED subset of the
 * bank, in bank order) both now apply. A cheap Haiku 4.5 smoke run against
 * three questions, rather than a full 46-question live bank, is:
 *
 *     GUIDED_ANALYSIS_LIVE_SPEND_GO=RUN-2026-09-27-01 \
 *     SHADOW_RUN_REGISTRY_PATH=<path-to-REGISTRY.md-with-that-row-GO:-marked> \
 *     SHADOW_RUN_QUESTIONS=3,4,5,6,8,13,21,31,39 \
 *     SHADOW_RUN_PROVIDER=compiled \
 *     npx playwright test AXI-1614-compiled-planner-shadow-run
 *
 * The assertion below is `rows.length === result.questionIds.length` — the
 * SELECTED subset's size, never a hardcoded 46 — so the same spec runs the
 * full bank (unset `SHADOW_RUN_QUESTIONS`) or a named subset without an edit.
 * A subset run's rows and summary land at a PER-RUN filename (suffixed by the
 * go's registry row id) rather than overwriting a prior full-bank
 * `<provider>.json` — see `writeShadowRunRows`'s own doc for why that file is
 * never a valid frozen corpus to overwrite.
 */
test.describe.configure({ mode: 'serial', timeout: 30 * 60_000 });

let auth: ShadowRunAuth;
let workspaceId: string;
let projectId: string;

test.beforeAll(async () => {
  auth = await createAdminShadowRunAuth();
  const overrideWorkspaceId = process.env.SHADOW_RUN_WORKSPACE_ID;
  const overrideProjectId = process.env.SHADOW_RUN_PROJECT_ID;
  if (overrideWorkspaceId && overrideProjectId) {
    workspaceId = overrideWorkspaceId;
    projectId = overrideProjectId;
    return;
  }
  const t = await ensureTenant(auth.api());
  workspaceId = t.workspaceId;
  projectId = t.projectId;
});

test.afterAll(async () => {
  await auth?.api().ctx.dispose();
});

test(
  'AC21 — the Grados bank runs once against the configured provider and writes the raw shadow-run rows',
  { tag: ['@SI-045'] },
  async () => {
    const provider = process.env.SHADOW_RUN_PROVIDER ?? 'unspecified';
    const arms = process.env.SHADOW_RUN_ARMS;
    test.skip(
      !shouldRunArm(arms, provider),
      `provider '${provider}' is not in SHADOW_RUN_ARMS='${arms}' — this arm is not being run`,
    );

    const dataset = await anchorDataset(auth.api(), workspaceId, projectId, {
      datasetId: process.env.SHADOW_RUN_DATASET_ID,
    });
    test.skip(!dataset, 'could not anchor a dataset for the shadow run — deferred to the W5 acceptance environment');
    if (!dataset) return;

    const reauthEvery = process.env.SHADOW_RUN_REAUTH_EVERY;
    // AXI-1749 (B2): `runShadowBankGuarded` — the FR50/FR53 guarded entry
    // point, not the unguarded `runShadowBank` this spec called before. It
    // reads `GUIDED_ANALYSIS_LIVE_SPEND_GO` + the run registry itself
    // (`decideHarnessLiveSpend`) and honours `SHADOW_RUN_QUESTIONS` (a NAMED
    // subset, e.g. a 3-question Haiku smoke run), aborting on the first
    // provider 400 rather than burning the rest of a bank a bad request has
    // already shown is wrong-shaped for this provider/schema combination.
    const result = await runShadowBankGuarded(auth, workspaceId, projectId, provider, [dataset], {
      ...(reauthEvery === undefined ? {} : { reauthEveryQuestions: Number(reauthEvery) }),
    });
    // The bank's size (46) is no longer the invariant — `SHADOW_RUN_QUESTIONS`
    // can select any non-empty subset. What is invariant is that the result
    // carries exactly one row per question the guard actually SELECTED,
    // whether the run completed, was refused before any call, or aborted
    // partway on a 400 (every remaining selected question still gets a
    // `not_answered` row — see `runShadowBankGuarded`'s own doc).
    expect(result.rows).toHaveLength(result.questionIds.length);

    // AXI-1749 (B2): a NAMED subset writes to a per-run filename, never
    // overwriting a prior full-bank `<provider>.json` — `compiled.json` is
    // explicitly NOT a valid frozen corpus for exactly that overwrite reason
    // (`harness/shadow.ts`'s own header). The full, unselected bank run keeps
    // the original fixed filename (empty suffix), so this is a no-op for
    // every invocation that predates AXI-1749.
    const questionsEnv = process.env.SHADOW_RUN_QUESTIONS?.trim();
    const filenameSuffix = questionsEnv ? `-${result.guard.rowId ?? 'unregistered'}` : '';
    const path = writeShadowRunRows(provider, result.rows, filenameSuffix);
    const summaryPath = writeShadowRunSummary(provider, {
      status: result.status,
      guard: result.guard,
      questionIds: result.questionIds,
      abortedAtQuestionId: result.abortedAtQuestionId,
    });
    // eslint-disable-next-line no-console
    console.log(
      `wrote ${result.rows.length} shadow-run rows for provider '${provider}' to ${path} ` +
        `(status=${result.status}, summary=${summaryPath})`,
    );
  },
);

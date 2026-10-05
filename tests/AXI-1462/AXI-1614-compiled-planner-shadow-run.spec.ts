import { test, expect } from '@playwright/test';
import { ensureTenant } from '../AXI-1435/harness/seed';
import { anchorDataset } from '../AXI-1604/harness/anchor-dataset';
import {
  createAdminShadowRunAuth,
  runShadowBankGuarded,
  shadowRunEvidenceVerdict,
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
 *
 * AXI-1716 (epic AXI-1687) — a FREE bank run. Against a backend running the
 * recorded transport (`GUIDED_ANALYSIS_LLM_TRANSPORT=recorded`, the standing
 * default since AXI-1758) this spec needs NO registry row and NO
 * `GUIDED_ANALYSIS_LIVE_SPEND_GO`, because there is nothing to authorise: the
 * answers come from `llm-debug/recordings/`, no key is read and nothing is spent.
 *
 *     SHADOW_RUN_PROVIDER=compiled \
 *     SHADOW_RUN_QUESTIONS=3,4,5 \
 *     npx playwright test AXI-1614-compiled-planner-shadow-run
 *
 * The harness does not take the operator's word for that. It asks the backend it
 * is about to hit (`GET /api/v1/guided-analysis/llm-transport`, answered by
 * organization-service out of the same `resolveLlmTransportMode` the transport
 * seam itself calls) and trusts only that answer. A `live` backend, or one that
 * cannot be asked, still goes through the UNCHANGED FR116 procedure above. A
 * question with no recording comes back `unsupported`/`recording_missing` and
 * the gate scores it `not_answered` — which is correct, and means "go author
 * that recording", not "the guard refused".
 *
 * AXI-1830 (epic AXI-1825) — the spec FAILS when the run is not evidence about
 * the provider under test (`shadowRunEvidenceVerdict`, `harness/shadow.ts`):
 * guard-refused, INVALID, any `provider_not_configured` fallback, a backend
 * serving a different arm than `SHADOW_RUN_PROVIDER`, or zero questions
 * answered by the provider. So a recorded first pass whose every question is
 * `recording_missing` is now RED — author the pending recordings and re-run.
 * The rows and sidecar are written before the verdict either way.
 */
// AXI-1844 (FR115 full-bank timeout sizing; revised in the AXI-1844 rework).
// The prior flat `30 * 60_000` risked exactly what FR115 forbids: "a failed
// run is never superseded by re-running unchanged code" — a spec TIMEOUT is a
// failed run by that rule, and burns one of FR115's two allowed held runs for
// no scientific reason at all. The 2026-09-26 full bank measured 16.4 min.
// `describe.configure({ timeout })` governs this spec's TEST body only, never
// its `beforeAll`/`afterAll` HOOKS (Playwright's own split — see
// `playwright.config.ts`'s comment, which raises the GLOBAL `timeout` to cover
// hooks for exactly this reason; this describe's hooks above do a login +
// tenant/dataset lookup, comfortably inside that global 120s, so they need no
// override here).
//
// THIS STORY'S FIRST PASS sized the timeout to the mathematically EXHAUSTIVE
// worst case — 46 questions x 5 repair attempts (the ladder's own ceiling) x
// 150s (the compiled arm's per-attempt planner deadline, NFR6), serial, plus a
// 10-minute setup/teardown allowance — which comes to 585 minutes (9h45m).
// That number is not wrong as an upper bound, but it is the wrong number to
// hold a KEY-BEARING LIVE CONTAINER open for: a run that is genuinely HUNG
// (not doing legitimate repair work, just stuck — a network wedge, a deadlock,
// a provider outage the retry loop never escapes cleanly) would sit unkilled
// for up to 9h45m before Playwright ever intervenes, which is a much larger
// live-spend/availability exposure than the scientific loss of occasionally
// cutting off a genuinely slow-but-still-working run early (that run is simply
// re-run — FR115's own remedy for a failed run, at zero scientific cost, since
// nothing about a timeout corrupts the bank).
//
// REVISED to a fixed 150-minute (2h30m) cap:
//
//   - ~9x the largest full-bank run measured to date (16.4 min) — no real run
//     has ever needed anywhere close to this;
//   - after the fixed 10-minute setup/teardown allowance, the remaining 140
//     minutes (8400s) over 46 questions is ~182s/question on average — about
//     1.2x the compiled arm's single-attempt planner deadline (150s) per
//     question, so the cap comfortably absorbs the ordinary case (most
//     questions answered first attempt) plus a MINORITY of questions needing
//     one genuine repair retry. It does NOT try to absorb a broadly degraded
//     run averaging 2+ attempts per question (that would need ~240 min) —
//     such a run is, by this point, indistinguishable from one that has
//     stopped doing useful repair work, and the correct response is to kill
//     it and re-run (FR115's own remedy for a failed run, at zero scientific
//     cost — nothing about a timeout corrupts the bank), not to wait it out;
//   - bounds how long a hung run can hold a live provider key/container to
//     under 2.5 hours instead of nearly 10 — the actual defect this revision
//     fixes: the mathematically exhaustive worst case is a real upper bound,
//     but sizing the TIMEOUT to it means a truly stuck (not merely slow)
//     process is left holding a paid, key-bearing container for up to 9h45m
//     before anything intervenes.
//
// If the bank's growth or the repair ladder's shape ever pushes genuine runs
// close to this cap, raise it explicitly and re-justify against the THEN
// current measured full-bank duration — never silently re-derive it from the
// worst-case product above, which is what produced the 9h45m number this
// comment replaces.
const FR115_FULL_BANK_TIMEOUT_MINUTES = 150; // ~9x the 16.4-minute 2026-09-26 measured run
const FR115_FULL_BANK_TIMEOUT_MS = FR115_FULL_BANK_TIMEOUT_MINUTES * 60_000;

test.describe.configure({ mode: 'serial', timeout: FR115_FULL_BANK_TIMEOUT_MS });

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
    // AXI-1865: the Riaz bank gets its own tag so its rows never sit beside a Grados run.
    const bankTag = process.env.SHADOW_RUN_BANK?.trim() === 'riaz' ? '-riaz10' : '';
    const filenameSuffix =
      questionsEnv || bankTag ? `${bankTag}-${result.guard.rowId ?? 'unregistered'}` : '';
    const path = writeShadowRunRows(provider, result.rows, filenameSuffix);
    // AXI-1716: the sidecar now also carries the SERVING backend's own transport
    // statement and the run's provenance (label + budget). A recorded run is
    // labelled `claude-code` with a budget of `0 USD (claude-code, blind)`; the
    // back's report prints these verbatim, so a free run can never be read as a
    // paid one later.
    const summaryPath = writeShadowRunSummary(provider, {
      status: result.status,
      guard: result.guard,
      transport: result.transport,
      provenance: result.provenance,
      questionIds: result.questionIds,
      abortedAtQuestionId: result.abortedAtQuestionId,
    });
    // eslint-disable-next-line no-console
    console.log(
      `wrote ${result.rows.length} shadow-run rows for provider '${provider}' to ${path} ` +
        `(status=${result.status}, transport=${result.transport.mode}, ` +
        `label=${result.provenance.label}, budget=${result.provenance.budget}, summary=${summaryPath})`,
    );

    // AXI-1830 (epic AXI-1825): one row per question is NOT a pass on its own.
    // The FR113 recorded first pass (2026-09-28) wrote 9/9 `fallback` rows
    // (`provider_not_configured`, ~70 ms) and this spec went green. The run
    // must be evidence about the provider under test — not guard-refused, not
    // INVALID, not served by an unconfigured or different arm, and answered by
    // the provider at least once. Checked AFTER the artefacts are written, so a
    // failed run still leaves its honest rows and sidecar behind.
    const verdict = shadowRunEvidenceVerdict(result, provider);
    expect(verdict.ok, verdict.ok ? undefined : verdict.message).toBe(true);
  },
);

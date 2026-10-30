import { test, expect } from '@playwright/test';
import { runCases, type CaseContext, type ExecutedCase } from './harness/prod-suite/cases';
import { prodSuiteEnabled } from './harness/prod-suite/config';
import { provisionFixtures, resolveFixtures } from './harness/prod-suite/fixtures';
import { loadPaulReference, type PaulReference } from './harness/prod-suite/paul-reference';
import { createPassRuleExecutor } from './harness/prod-suite/pass-rule-executor';
import { findSecretShapes } from './harness/prod-suite/publish';
import { buildReport, renderReportMarkdown, serializeReport } from './harness/prod-suite/report';
import { buildRunPlan, fetchActiveCatalogue, PAUL_OPERATIONS, type PlannedCase } from './harness/prod-suite/run-plan';
import { renderInstanceState, waitForIngestion } from './harness/pass-rule-standin';
import { LocalTestOrgWorld } from './prod-suite-fixtures';

/**
 * AXI-2319 (epic AXI-2309 Platform Opening: Headless — FR31, FR14, AC12;
 * SI-042 + SI-053) — verification of the prod E2E PASS RULE against a running
 * local/demo stack, inside AXI-2318's self-provisioned stand-in for the
 * dedicated test org (`LocalTestOrgWorld`), running as the confined identity.
 *
 * It drives the very executor the daily prod run uses (`createPassRuleExecutor`
 * — `dailyExecutor` is one instance of it) over the live active catalogue:
 * Paul's methods judged on his slide numbers + R parity (positively, and
 * negatively with a perturbed expectation), the same-day re-run re-executed
 * rather than replayed from the dedup cache, a DESCRIBE re-run answered from
 * the cache recorded `not-evaluated` (never pass), a catalogue rule's verdict
 * following its default chart, and the rules the suite cannot judge recorded
 * `not-evaluated` with a reason. NEVER runs against production: it needs the
 * platform admin to build its stand-in, so it skips whenever the daily-suite
 * switch is on.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2309-Platform-Opening-Headless.md
 * § "AXI-2319 — Prod E2E pass rule" (AXI-2319.1 .. .6, .8).
 */

test.use({ storageState: { cookies: [], origins: [] }, trace: 'off' });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-042', '@SI-053'] };

let world: LocalTestOrgWorld;
let ctx: CaseContext;
let plan: PlannedCase[];
let paulResults: ExecutedCase[] = [];
const executed: ExecutedCase[] = [];

const firstOf = (operationId: string, phase: PlannedCase['phase'] = 'catalogue') => {
  const hit = plan.find((c) => c.operationId === operationId && c.phase === phase);
  if (!hit) throw new Error(`the live catalogue has no active ${operationId} rule`);
  return hit;
};
const summary = (cases: ExecutedCase[]) => cases.map((c) => `${c.order} ${c.operationId} · ${c.outcome} · ${c.reason ?? ''}`);

/** A copy of the committed reference with one expectation changed (the negative scenario). */
function perturbed(ref: PaulReference, mutate: (r: PaulReference) => void): PaulReference {
  const copy = JSON.parse(JSON.stringify(ref)) as PaulReference;
  mutate(copy);
  return copy;
}

/**
 * A provisioned stand-in test org: fresh org + workspace + confined identity,
 * the two fixtures uploaded and ingested. Fresh datasets mean nothing it runs
 * can dedup onto another world's runs (the fingerprint keys on the dataset version).
 */
async function standIn(): Promise<{ world: LocalTestOrgWorld; ctx: CaseContext }> {
  const w = await LocalTestOrgWorld.create();
  const ids = await provisionFixtures(w.identity, w.config('{}'));
  await waitForIngestion(w.identity, w.workspaceId, Object.values(ids));
  const fixtures = await resolveFixtures(w.identity, w.workspaceId, JSON.stringify(ids));
  return { world: w, ctx: { client: w.identity, organizationId: w.organizationId, workspaceId: w.workspaceId, fixtures } };
}

test.describe('AXI-2319 — prod E2E pass rule (local stand-in for the test org)', TAGS, () => {
  test.skip(prodSuiteEnabled(process.env), 'pass-rule verification spec needs the platform admin — never run it on prod');

  test.beforeAll(async () => {
    test.setTimeout(5 * 60_000);
    ({ world, ctx } = await standIn());
    plan = buildRunPlan(await fetchActiveCatalogue(world.identity)).cases;
  });

  test.afterAll(async () => {
    await world?.dispose();
  });

  test("AC12 FR31 — AXI-2319.1 every active rule carrying Paul's methods reproduces his slide numbers and R on the live platform", async () => {
    test.setTimeout(20 * 60_000);
    const paul = plan.filter((c) => c.phase === 'paul-methods');
    expect(new Set(paul.map((c) => c.operationId))).toEqual(new Set(PAUL_OPERATIONS));
    paulResults = await runCases(paul, ctx, createPassRuleExecutor());
    executed.push(...paulResults);
    expect(summary(paulResults.filter((c) => c.outcome !== 'pass')), "Paul's methods not passing").toEqual([]);
    for (const c of paulResults) {
      // Non-vacuous: every declared check was actually read off a live result row.
      expect(c.facts.checksPassed, `${c.code} checks`).toBe(c.facts.checksExpected);
      expect(Number(c.facts.checksExpected), `${c.code} declared checks`).toBeGreaterThan(0);
      expect(c.facts.runsSucceeded, `${c.code} runs`).toBe(c.facts.probes);
    }
    const dunn = paulResults.find((c) => c.operationId === 'stats.dunn_posthoc')!;
    expect(dunn.facts['observed.dunn-ent059.adjustedPValue[HD vs IgG4-RD]']).toBeCloseTo(0.0217266, 6);
  });

  test('FR31 — AXI-2319.2 a same-day re-run is never judged from the dedup cache: it passes only on a fresh re-executed run', async () => {
    test.setTimeout(5 * 60_000);
    const spearman = firstOf('stats.correlation', 'paul-methods');
    const [again] = await runCases([spearman], ctx, createPassRuleExecutor());
    // Every probe deduped onto step .1's runs — the platform's FR17 dedup, which
    // ignores the date. The pass rule must then re-execute, not replay the cache.
    expect(again.facts.deduped, 'every probe deduped onto the earlier run').toBe(again.facts.probes);
    const before = paulResults.find((c) => c.id === spearman.id)!;
    if (again.outcome === 'pass') {
      expect(again.facts.reExecuted, 'a pass rests on fresh re-executed runs only').toBe(again.facts.probes);
      expect(again.facts.firstRunId).not.toBe(before.facts.firstRunId);
      return;
    }
    // Live today (2026-10-30): AXI-2044's replay row is stamped with no
    // workspace, so the confined identity cannot read it — the case FAILS and
    // says so (platform defect, reported to the lead). Never a pass.
    expect(again.outcome).toBe('fail');
    expect(again.reason).toMatch(/run not readable by the suite identity|run refused \(re-execute /);
    test.info().annotations.push({ type: 'platform-defect', description: again.reason ?? '' });
  });

  test("FR31 — AXI-2319.3 a wrong expectation fails the case and names the check (negative: one slide target AND one R value)", async () => {
    test.setTimeout(8 * 60_000);
    // Its own fresh stand-in: in the main world every Dunn probe would now
    // dedup onto step .1 and fail on the re-execution defect (step .2), not on
    // the values this scenario is about.
    const fresh = await standIn();
    try {
      const freshPlan = buildRunPlan(await fetchActiveCatalogue(fresh.world.identity)).cases;
      const dunn = freshPlan.find((c) => c.operationId === 'stats.dunn_posthoc' && c.phase === 'paul-methods')!;
      const wrong = perturbed(loadPaulReference(), (r) => {
        r.probes.find((p) => p.id === 'dunn-ent059')!.checks[0].target = '0.023';
        const row = r.r.probes.find((p) => p.id === 'dunn-ent059')!.rows.find((x) => x.row.groupA === 'HD' && x.row.groupB === 'SD')!;
        row.values.zStatistic *= 1 + 1e-6;
      });
      const [c] = await runCases([dunn], fresh.ctx, createPassRuleExecutor({ reference: wrong }));
      expect(c.outcome).toBe('fail');
      expect(c.facts.runsSucceeded, 'every run itself succeeded — the failure is the values').toBe(c.facts.probes);
      expect(c.facts.deduped).toBe(0);
      // Exactly the two perturbed checks fail, and nothing else.
      expect(c.facts.checksPassed).toBe(Number(c.facts.checksExpected) - 2);
      expect(c.reason).toMatch(/^2 failed: dunn-ent059: adjustedPValue\[HD vs IgG4-RD\] vs Paul's slide: .* rounds to 0\.022, slide says 0\.023/);
      expect(c.reason).toMatch(/zStatistic\[HD vs SD\] vs R: .*relative Δ/);
    } finally {
      await fresh.world.dispose();
    }
  });

  test("AC12 FR31 FR14 — AXI-2319.4 a catalogue rule's verdict follows its default chart: run SUCCEEDED, recommended chart minted, render state read independently", async () => {
    test.setTimeout(5 * 60_000);
    const [count] = await runCases([firstOf('describe.count')], ctx, createPassRuleExecutor());
    executed.push(count);
    expect(count.facts.runStatus, count.reason ?? '').toBe('SUCCEEDED');
    expect(count.facts.chartDeclaration).toBe('gallery');
    expect(typeof count.facts.chartSpecId, 'a recommended-origin chart was minted for the result').toBe('string');
    if (count.outcome === 'pass') {
      expect(count.facts.chartRendered).toBe(true);
      expect(count.facts.chartState).toBe('rendered');
    } else {
      // The verdict must agree with what the server shows for that render, read here on its own.
      expect(count.outcome).toBe('fail');
      expect(count.reason).toMatch(/^default chart: /);
      expect(count.facts.chartRendered).toBe(false);
      if (count.facts.chartState === 'never-ready') {
        const seen = await renderInstanceState(ctx.client, ctx.workspaceId, String(count.facts.chartInstanceId));
        expect(seen.status === 'ready' && seen.hasPayload && !seen.payloadError, 'render is NOT ready with a clean payload').toBe(false);
      }
    }
  });

  test('FR31 — AXI-2319.8 a DESCRIBE rule re-run the same day is answered from the dedup cache and is not-evaluated, never pass', async () => {
    test.setTimeout(5 * 60_000);
    // Step .4 already ran this rule in this world; the platform dedups DESCRIBE
    // before executing (AXI-1558) and DESCRIBE has no re-execute path, so today's
    // engine does not run — exactly the day-2+ state of every DESCRIBE recipe on prod.
    const [again] = await runCases([firstOf('describe.count')], ctx, createPassRuleExecutor());
    executed.push(again);
    expect(again.facts.deduped, 'the re-run deduped onto step .4').toBe(true);
    expect(again.facts.reExecuted).toBe(false);
    expect(again.outcome, again.reason ?? '').toBe('not-evaluated');
    expect(again.facts.engineRanToday).toBe(false);
    expect(again.reason).toMatch(/^engine did not run today: deduped onto \S+, no re-execute path for DESCRIBE$/);
    expect(again.facts.chartState, 'a cached run is never judged on its chart').toBeUndefined();
  });

  test('FR31 — AXI-2319.5 a rule the suite cannot judge is not-evaluated with its reason, never pass', async () => {
    test.setTimeout(5 * 60_000);
    const cases = [firstOf('stats.anosim'), firstOf('stats.kaplan_meier')];
    const interpret = plan.find((c) => c.phase === 'catalogue' && c.operationId === null);
    if (interpret) cases.push(interpret);
    const results = await runCases(cases, ctx, createPassRuleExecutor());
    executed.push(...results);
    // runCases executes (and returns) in plan order, not in the order given here.
    const byId = (id: string | undefined) => results.find((c) => c.id === id);
    const [anosim, km, noOp] = [byId(cases[0].id)!, byId(cases[1].id)!, byId(interpret?.id)];
    expect(anosim.outcome, anosim.reason ?? '').toBe('not-evaluated');
    expect(anosim.facts.runStatus, 'the run itself is still judged').toBe('SUCCEEDED');
    expect(anosim.reason).toMatch(/result-surface only/);
    expect(km.outcome).toBe('not-evaluated');
    expect(km.reason).toMatch(/no recipe for stats\.kaplan_meier/);
    if (noOp) {
      expect(noOp.outcome).toBe('not-evaluated');
      expect(noOp.reason).toMatch(/no recipe/);
    }
    expect(results.some((c) => c.outcome === 'pass')).toBe(false);
  });

  test('FR33 NFR3 — AXI-2319.6 the judged cases still make a schema-v1 report with scalar facts and nothing secret', async () => {
    expect(executed.length).toBeGreaterThan(0);
    const report = buildReport({
      run: { runId: 'local-axi2319', trigger: 'local', gitSha: null, targetLabel: 'local-stand-in', startedAt: '2026-10-30T00:00:00.000Z', finishedAt: '2026-10-30T00:00:00.000Z' },
      abort: null, testOrg: { organizationId: world.organizationId, workspaceId: world.workspaceId }, fixtures: ctx.fixtures,
      plan: { paulOperations: [...PAUL_OPERATIONS], missingPaulOperations: [] }, cases: executed,
    });
    expect(report.schemaVersion).toBe(1);
    for (const c of report.cases) {
      for (const v of Object.values(c.facts)) expect(v === null || ['string', 'number', 'boolean'].includes(typeof v)).toBe(true);
    }
    for (const text of [serializeReport(report), renderReportMarkdown(report)]) {
      expect(findSecretShapes(text)).toEqual([]);
      expect(text).not.toMatch(/https?:\/\//i);
      expect(text.includes(world.email)).toBe(false);
    }
    expect(report.summary.byOutcome.pass).toBeGreaterThan(0);
  });
});

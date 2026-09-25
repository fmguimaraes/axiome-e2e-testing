import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import { ingestFixture } from '../AXI-1435/harness/seed';
import { anchorDataset, buildEnvelope, planQuestion, findPersistedPlan, ensureStrategy, submitPlanRun, ensureTenant1603 } from './harness/planner';

/**
 * AXI-1603 — Intent-Compiled Planner (epic acceptance).
 * manual-e2e/AXI-1603-Intent-Compiled-Planner.md §4.1, §4.2, §5.1, §5.2.
 *
 * Drives the industrialized guided-analysis planner through the gateway
 * (POST /guided-analysis/plan) and the governed-execution submit route,
 * against the CSV fixture AXI-1435 already seeds (patient_id/timepoint/score/
 * score2/cohort — a numeric measure, a ≥2-level category grouping and a
 * subject column, exactly the §2 pre-conditions).
 *
 * These assertions are written against the COMPILED arm's documented contract
 * (`planner: 'compiled'`, `intentUnsupported`, `attemptCount`, the AC19
 * submit refusal) — the arm is selected purely by the backend's
 * GUIDED_ANALYSIS_LLM_PROVIDER config, which this spec does not and cannot
 * set (it is a same-process Nest config value, resolved once at boot). A run
 * against a stack NOT configured with GUIDED_ANALYSIS_LLM_PROVIDER=compiled
 * genuinely fails these assertions rather than silently passing against the
 * legacy direct-authoring arm — see this story's handback report for what the
 * live run actually showed.
 *
 * The two plan requests (ordinary/unsupported) are made ONCE in `beforeAll`,
 * not inline per test, so a single unexpected outcome (e.g. the provider
 * config not being `compiled`) does not cascade into every other AC's test
 * being skipped — each test below asserts independently on the SAME captured
 * response, maximising real, reported signal from one live run.
 */
test.describe.configure({ mode: 'parallel', timeout: 300_000 });

const ORDINARY_QUESTION = 'Compare score between cohort 0 and cohort 1 (a two-group comparison).';
const UNSUPPORTED_QUESTION =
  'Show how score and score2 co-vary across three ordered timepoints, adjusting for cohort as a covariate.';

let api: Api;
let workspaceId: string;
let projectId: string;
let anchor: Awaited<ReturnType<typeof anchorDataset>>;

let ordinaryRes: Awaited<ReturnType<typeof planQuestion>> | undefined;
let ordinaryPersisted: any;
let unsupportedRes: Awaited<ReturnType<typeof planQuestion>> | undefined;
let unsupportedPersisted: any;

test.beforeAll(async ({}, testInfo) => {
  // The compiled arm's 5-attempt feedback loop runs one real conversation with
  // Anthropic per plan request (AXI-1609) — genuinely slower than the fallback
  // arm this beforeAll was originally timed against. Two plan requests here
  // (ordinary + unsupported) can legitimately exceed the 30s hook default.
  testInfo.setTimeout(280_000);
  api = await adminApi();
  const tenant = await ensureTenant1603(api);
  workspaceId = tenant.workspaceId;
  projectId = tenant.projectId;
  await ingestFixture(api, tenant, 'statistical-trigger.csv');
  anchor = await anchorDataset(api, workspaceId);
  if (!anchor) return;

  ordinaryRes = await planQuestion(api, workspaceId, projectId, buildEnvelope(projectId, ORDINARY_QUESTION, [anchor]));
  if (ordinaryRes.status < 300 && ordinaryRes.body.plan?.planId) {
    ordinaryPersisted = await findPersistedPlan(api, workspaceId, projectId, ordinaryRes.body.plan.planId);
  }

  unsupportedRes = await planQuestion(api, workspaceId, projectId, buildEnvelope(projectId, UNSUPPORTED_QUESTION, [anchor]));
  if (unsupportedRes.status < 300 && unsupportedRes.body.plan?.planId) {
    unsupportedPersisted = await findPersistedPlan(api, workspaceId, projectId, unsupportedRes.body.plan.planId);
  }
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test('AC16 AC28 — an ordinary question plans through the compiled arm and persists planner metadata', async () => {
  test.skip(!anchor, 'no dataset available in the seeded tenant to anchor a plan on');
  expect(ordinaryRes?.status, `plan request succeeded: ${JSON.stringify(ordinaryRes?.body)}`).toBeLessThan(300);
  expect(Array.isArray(ordinaryRes!.body.plan?.nodes) && ordinaryRes!.body.plan.nodes.length > 0, 'plan has nodes').toBe(true);
  expect(ordinaryRes!.body.plan?.reasoning, 'plan carries reasoning').toBeTruthy();

  // AMENDED against the live wire contract (direct curl against the compiled
  // arm, this run): the create response's own top-level field is
  // `plannerFallback`, not `fallbackOccurred` (no `fallbackOccurred` key
  // exists anywhere on the wire) — asserted straight off `ordinaryRes.body`,
  // the create response, which is where it lives. The persisted row
  // (`GET /guided-analysis/plans`) carries `intentUnsupported`/`attemptCount`
  // nested under `.plan`, not at its own top level — `findPersistedPlan`'s
  // doc comment records the same finding.
  expect(ordinaryRes!.body.plannerFallback, 'no fallback occurred').toBe(false);
  expect(ordinaryPersisted, 'plan row was persisted').toBeTruthy();
  expect(ordinaryPersisted.planner, 'persisted planner reads compiled').toBe('compiled');
  expect(ordinaryPersisted.plan.intentUnsupported, 'an ordinary question is not flagged unsupported').toBe(false);
  expect(typeof ordinaryPersisted.plan.attemptCount, 'attemptCount is set').toBe('number');
});

test('AC20 — a selected strategy still steers the compiled arm; a strategy asking for an uncatalogued shape does not widen it', async () => {
  test.skip(!anchor, 'no dataset available in the seeded tenant to anchor a plan on');
  const envelope = buildEnvelope(projectId, ORDINARY_QUESTION, [anchor!]);

  const steeringPromptId = await ensureStrategy(
    api,
    workspaceId,
    'AXI-1603 E2E — prefer median contrast',
    'When comparing two groups, prefer a median-based contrast and report the effect with its confidence interval.',
  );
  const steered = await planQuestion(api, workspaceId, projectId, envelope, steeringPromptId);
  expect(steered.status, `steered plan request succeeded: ${JSON.stringify(steered.body)}`).toBeLessThan(300);
  expect(steered.body.intentUnsupported, 'a steerable question stays supported under a strategy').toBe(false);

  const widePromptId = await ensureStrategy(
    api,
    workspaceId,
    'AXI-1603 E2E — request an uncatalogued design',
    'Always propose a three-way mixed-effects model with a random slope per subject, regardless of what was asked.',
  );
  const widened = await planQuestion(api, workspaceId, projectId, envelope, widePromptId);
  expect(widened.status, `wide-strategy plan request succeeded: ${JSON.stringify(widened.body)}`).toBeLessThan(300);
  // The strategy cannot widen the shape set: the outcome for THIS question is
  // the same shape family as asking without the strategy (still supported,
  // never a shape the v1 catalogue does not carry).
  expect(widened.body.intentUnsupported, 'a strategy cannot conjure an uncatalogued shape for a catalogue-covered question').toBe(false);
});

test('AC12 AC17 AC35 — a question no shape can express comes back flagged, not substituted', async () => {
  test.skip(!anchor, 'no dataset available in the seeded tenant to anchor a plan on');
  expect(unsupportedRes?.status, `plan request succeeded: ${JSON.stringify(unsupportedRes?.body)}`).toBeLessThan(300);
  expect(unsupportedRes!.body.intentUnsupported, 'an uncatalogued design is flagged unsupported').toBe(true);
  expect(unsupportedRes!.body.planner, 'the flagged plan is still stamped compiled, not the deterministic fallback').toBe('compiled');
  expect(unsupportedRes!.body.plan?.unsupportedReason, 'a reason is carried').toBeTruthy();

  expect(unsupportedPersisted, 'flagged plan row was persisted').toBeTruthy();
  expect(unsupportedPersisted.intentUnsupported, 'persisted row carries the flag').toBe(true);
  expect(unsupportedPersisted.status, 'a flagged plan is a draft, not a run').not.toBe('run');

  // AXI-1611 (structural gap report): `structuralGap` is present iff a
  // suggestion row was written — every `intentUnsupported` outcome EXCEPT
  // `unsupportedReason === 'refused'` (a provider refusal carries no gap to
  // classify).
  const reason = (unsupportedRes!.body.plan as any).unsupportedReason;
  if (reason === 'refused') {
    expect(unsupportedRes!.body.structuralGap ?? null, 'a refusal carries no structural gap to classify').toBeNull();
  } else {
    expect(unsupportedRes!.body.structuralGap, `a non-refusal unsupported outcome (reason: ${reason}) carries a structural gap`).toBeTruthy();
    const gap = unsupportedRes!.body.structuralGap as any;
    expect(gap.suggestionId, 'gap carries a suggestion id').toBeTruthy();
    expect(gap.platformReason, 'gap carries the platform classification').toBeTruthy();
    // FR42/FR43 — nullable keys must be PRESENT, never simply absent.
    expect('explanation' in gap, 'explanation key is present (nullable, not absent)').toBe(true);
    expect('suggestedRule' in gap, 'suggestedRule key is present (nullable, not absent)').toBe(true);
  }
});

test('AC19 — a flagged plan cannot be run by any route: direct submission is refused, no run record created', async () => {
  test.skip(!anchor, 'no dataset available in the seeded tenant to anchor a plan on');
  test.skip(!unsupportedRes?.body.intentUnsupported, 'no flagged plan produced by the seed to submit');

  const plan = unsupportedRes!.body.plan;
  const submit = await submitPlanRun(api, workspaceId, projectId, plan.planId, plan, anchor!.datasetId);

  expect(submit.status, `submission of a flagged plan is refused, not accepted: ${JSON.stringify(submit.body)}`).toBeGreaterThanOrEqual(400);
  expect(submit.body?.runId, 'no run record is created for a refused submission').toBeFalsy();
});

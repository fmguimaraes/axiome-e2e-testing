import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import {
  ensureTenant, ensureProject, ingestFixture, datasetVersionHash, ensureDefaultAnalysis,
  createViewAnalysis, bindEnvelope, ensureApprovedDiscoveryConfig, instantiatePlan, NAMES,
} from './harness/seed';

/**
 * AXI-1531 (epic AXI-1507 — FR27, AC-DEMO; SI-045, SI-046) — the first live
 * execution of the discovery composition (AXI-1516) against a running stack.
 * The epic's own debt note calls scenario D.9 (`manual-e2e/AXI-1507-…md`) "the
 * single most load-bearing unexecuted check" — this file is what makes it run
 * headless, via `POST /v1/discovery/*`, the SAME contract the canvas trigger
 * (`StartDiscoveryPlanModal`, axiome-front) calls.
 *
 * WHAT THIS COVERS, AND WHY THIS IS THE STRUCTURAL HALF OF D.9. AXI-1508's
 * context-admission BLOCK is dormant until TWO facts both hold: the referent is
 * a registered discovery step, AND its envelope is MEASURED ABSENT.
 * Instantiation is the ONLY writer of the registration
 * (`discovery_plan_instances`), and it structurally REQUIRES a bound envelope
 * (`DiscoveryPlanService#instantiate` refuses with no envelope) — so a live,
 * backdoor-free probe cannot un-bind an already-bound envelope (it is
 * IMMUTABLE, no delete route — AXI-1508's own NFR8 doctrine) to reach the
 * "registered AND absent" state envelope-side. The manual scenario's own
 * procedure for that half is a direct DB delete, which this repo's own
 * doctrine forbids in a spec (`AXI-1369-no-backdoor.spec.ts` flags a raw
 * Prisma/pg import as a defect, not a technique) — so that half stays
 * MANUAL-ONLY, tracked as epic debt (see this file's closing comment).
 *
 * What IS fully live-reachable, and is exactly what D.9's own three
 * paragraphs describe together: (1) the registration act ITSELF enforces the
 * envelope precondition — `D.9-ARM-1` proves a container cannot be armed
 * without first measuring an envelope present, which is the other side of the
 * same coin AXI-1508 gates on; (2) `D.9-DORMANT` proves an ordinary,
 * unregistered analysis carries neither an envelope nor a registration —
 * the two facts the guard is dormant without. D.7 (happy path) and D.8
 * (second instantiation refused) are exercised first because D.9 depends on
 * a genuinely registered container.
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });

let api: Api;
let t: Awaited<ReturnType<typeof ensureTenant>>;
let projectId: string;
let smallDatasetId: string;
let smallHash: string;

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  projectId = await ensureProject(api, t, NAMES.project);
  smallDatasetId = await ingestFixture(api, t, NAMES.smallFixture);
  smallHash = await datasetVersionHash(api, t, smallDatasetId);
  await ensureApprovedDiscoveryConfig(api, t);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test('FR27/FR28 (D.7) — the nine steps compose into the EXISTING container', { tag: ['@SI-045', '@SI-046'] }, async () => {
  const viewAnalysisId = await ensureDefaultAnalysis(api, t, projectId, smallDatasetId);
  const bound = await bindEnvelope(api, t, viewAnalysisId);
  expect([200, 201], `envelope bind: ${JSON.stringify(bound.body)}`).toContain(bound.status);

  const res = await instantiatePlan(api, t, {
    viewAnalysisId, projectId, datasetId: smallDatasetId, datasetVersionHash: smallHash,
    questionKey: 'axi-1531-d7',
  });
  expect(res.status, `instantiate: ${JSON.stringify(res.body)}`).toBe(201);
  // Idempotent re-run of this spec dedupes onto D.8's "already holds an
  // instance" refusal instead of a fresh `instantiated: true` — both are
  // proof the SAME container never gets a second registration.
  if (res.body.instantiated) {
    expect(res.body.instance.viewAnalysisId, 'composes into the EXISTING analysis, not a new one').toBe(viewAnalysisId);
    expect(res.body.instance.templateId).toBe('DISCOVERY-BIOMARKER-9');
  } else {
    expect(res.body.reasons.join(' ')).toMatch(/already holds an instantiated discovery plan/);
  }
});

test('FR27 (D.8) — a second plan in the SAME container is refused', { tag: ['@SI-045'] }, async () => {
  const viewAnalysisId = await ensureDefaultAnalysis(api, t, projectId, smallDatasetId);
  const res = await instantiatePlan(api, t, {
    viewAnalysisId, projectId, datasetId: smallDatasetId, datasetVersionHash: smallHash,
    questionKey: 'axi-1531-d8-repeat',
  });
  expect(res.status, `instantiate: ${JSON.stringify(res.body)}`).toBe(201);
  expect(res.body.instantiated, 'a second registration on the same container is refused').toBe(false);
  expect(res.body.reasons.join(' ')).toMatch(/already holds an instantiated discovery plan/);
});

test('FR1/FR27 (D.9-ARM-1) — a container cannot be REGISTERED (armed) without a measured envelope', { tag: ['@SI-017', '@SI-045'] }, async () => {
  const viewAnalysisId = await createViewAnalysis(api, t, projectId, smallDatasetId, 'AXI-1531 D.9 — no envelope');

  const beforeEnvelope = await api.get(`/api/v1/discovery/analyses/${viewAnalysisId}/envelope`, t.headers);
  expect(beforeEnvelope.body, 'a freshly created analysis carries no envelope').toBeFalsy();

  const res = await instantiatePlan(api, t, {
    viewAnalysisId, projectId, datasetId: smallDatasetId, datasetVersionHash: smallHash,
    questionKey: 'axi-1531-d9-arm',
  });
  expect(res.status, `instantiate: ${JSON.stringify(res.body)}`).toBe(201);
  expect(res.body.instantiated, 'no envelope, so the registration act itself is refused').toBe(false);
  expect(res.body.reasons.join(' ')).toMatch(/no context envelope is bound to this analysis/);
  expect(res.body.reasons.join(' ')).toMatch(/tissue.*disease.*panel.*gate definition.*denominator.*timepoint.*cohort/);
});

test('FR1/FR2 (D.9-DORMANT) — an ordinary, unregistered analysis is unaffected', { tag: ['@SI-017'] }, async () => {
  const viewAnalysisId = await createViewAnalysis(api, t, projectId, smallDatasetId, 'AXI-1531 D.9 — ordinary analysis');
  const envelope = await api.get(`/api/v1/discovery/analyses/${viewAnalysisId}/envelope`, t.headers);
  expect(envelope.status).toBe(200);
  expect(envelope.body, 'no envelope is bound — nothing armed this container').toBeFalsy();
});

/**
 * NOT automated here, and why: the ENVELOPE half of D.9's arming proof
 * (`envelopeBound: false` inside an ALREADY-registered container) requires the
 * envelope to be measured absent AFTER registration — and the envelope is
 * immutable with no delete route by design (AXI-1508, NFR8). The manual
 * scenario's own procedure for that half is a direct DB delete, which this
 * repo's own doctrine forbids in a spec. This is the SAME limitation the
 * epic's dev-epic-context already records as the reason D.9 shipped
 * unexecuted; this file closes the REACHABLE two-thirds of it (the
 * registration-requires-envelope precondition, and the dormant/unregistered
 * control) and leaves the DB-only third exactly where it was, documented
 * rather than silently dropped.
 *
 * ALSO DISCOVERED WHILE WIRING THIS UP (routed to the epic lead, not fixed
 * here — out of this story's front-end-trigger scope): the live demo stack's
 * `organization-service` image throws `The column "defer_snapshot" does not
 * exist in the current database` on a discovery plan's own internal QC-check
 * nodes (`RuleRunsService` chained-artifact submission path), even after
 * `prisma migrate deploy` reports the schema fully up to date — a stale
 * generated-client/build drift, not a migration gap. This is what stops the
 * template's OWN `stats.screen_shortlist` node from ever reaching a verdict
 * live in THIS environment, and is unrelated to AXI-1531's front-end or REST
 * changes (confirmed: it reproduces on an unmodified `origin/main` image).
 */

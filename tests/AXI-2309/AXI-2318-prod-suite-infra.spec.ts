import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForbiddenReferenceError } from './harness/prod-suite/api-client';
import { ProdSuiteAbort } from './harness/prod-suite/abort';
import { prodSuiteEnabled } from './harness/prod-suite/config';
import { provisionFixtures, resolveFixtures, PROD_SUITE_FIXTURES } from './harness/prod-suite/fixtures';
import { verifyIsolation } from './harness/prod-suite/isolation-guard';
import { findSecretShapes, planPublication } from './harness/prod-suite/publish';
import { writeReport } from './harness/prod-suite/report';
import { buildRunPlan, fetchActiveCatalogue, PAUL_OPERATIONS } from './harness/prod-suite/run-plan';
import { runProdSuite } from './harness/prod-suite/suite';
import { API_BASE_URL } from '../../config/env';
import { LocalTestOrgWorld } from './prod-suite-fixtures';

/**
 * AXI-2318 (epic AXI-2309 Platform Opening: Headless) — verification of the
 * prod E2E suite INFRASTRUCTURE against a running local/demo stack, inside a
 * self-provisioned stand-in for the dedicated test org (`LocalTestOrgWorld`).
 * It exercises the very harness the daily prod run uses: the isolation guard
 * (EC9) positively and negatively, fixtures uploaded once and resolved by ID
 * (FR29), the run order over the live catalogue (FR30), and the whole suite
 * producing a publishable report (FR33/NFR6).
 *
 * NEVER runs against production: it needs the platform admin to build its
 * stand-in, so it skips whenever the daily-suite switch is on.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2309-Platform-Opening-Headless.md
 * § "AXI-2318 — Prod E2E suite infra" (AXI-2318.2 .. .7).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-042'] };
const NEVER_ISSUED = '00000000-0000-4000-8000-000000000000';

let world: LocalTestOrgWorld;
let fixtureIds: Record<string, string>;

async function abortOf(promise: Promise<unknown>): Promise<ProdSuiteAbort> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err, 'expected a hard failure (ProdSuiteAbort)').toBeInstanceOf(ProdSuiteAbort);
  return err as ProdSuiteAbort;
}

test.describe('AXI-2318 — prod E2E suite infra (local stand-in for the test org)', TAGS, () => {
  test.skip(prodSuiteEnabled(process.env), 'infra verification spec needs the platform admin — never run it on prod');

  test.beforeAll(async () => {
    world = await LocalTestOrgWorld.create();
  });

  test.afterAll(async () => {
    await world?.dispose();
  });

  test('AC11 EC9 NFR5 — a confined test identity passes the isolation guard', async () => {
    const verdict = await verifyIsolation(world.identity, world.config('{}'));
    expect(verdict).toEqual({ organizationId: world.organizationId, workspaceId: world.workspaceId });
  });

  test('AC11 EC9 NFR5 — an identity that can resolve other organizations is a hard failure', async () => {
    // The admin sees every org, the decoy forbidden org included: the id-based check fires first.
    const abort = await abortOf(verifyIsolation(world.admin, world.config('{}')));
    expect([abort.phase, abort.code]).toEqual(['isolation', 'FORBIDDEN_ORG_VISIBLE']);
  });

  test('AC11 EC9 — a forbidden org id is refused, and the client never even sends a request naming it', async () => {
    const forbidden = world.config('{}', { forbiddenOrgIds: [world.organizationId] });
    expect((await abortOf(verifyIsolation(world.identity, forbidden))).code).toBe('CONFIGURED_ORG_FORBIDDEN');
    const disarmed = world.config('{}', { forbiddenOrgIds: [] });
    expect((await abortOf(verifyIsolation(world.identity, disarmed))).code, 'an empty forbidden list fails closed').toBe('FORBIDDEN_IDS_MISSING');
    const tripwired = await world.identityClient([world.organizationId]);
    const err = await tripwired.get(`/api/v1/organizations/${world.organizationId}`).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenReferenceError);
  });

  test('AC11 FR29 — fixtures are uploaded once, then resolved by ID with their bytes verified', async () => {
    fixtureIds = await provisionFixtures(world.identity, world.config('{}'));
    expect(await world.datasetCount()).toBe(PROD_SUITE_FIXTURES.length);
    expect(await provisionFixtures(world.identity, world.config('{}'))).toEqual(fixtureIds);
    expect(await world.datasetCount(), 're-provisioning must not upload again').toBe(PROD_SUITE_FIXTURES.length);
    const resolved = await resolveFixtures(world.identity, world.workspaceId, JSON.stringify(fixtureIds));
    expect(resolved.map((f) => f.datasetId)).toEqual(PROD_SUITE_FIXTURES.map((f) => fixtureIds[f.key]));
  });

  test('AC11 FR29 — an id that does not resolve is a hard failure, never a re-upload', async () => {
    const broken = JSON.stringify({ ...fixtureIds, tableau1: NEVER_ISSUED });
    const abort = await abortOf(resolveFixtures(world.identity, world.workspaceId, broken));
    expect([abort.phase, abort.code]).toEqual(['fixtures', 'FIXTURE_NOT_FOUND']);
    expect(await world.datasetCount()).toBe(PROD_SUITE_FIXTURES.length);
  });

  test("AC11 FR30 — over the live catalogue, Paul's methods come first, then every other active rule once", async () => {
    const catalogue = await fetchActiveCatalogue(world.identity);
    const plan = buildRunPlan(catalogue);
    const paulCount = catalogue.filter((r) => PAUL_OPERATIONS.includes(r.operationId ?? '')).length;
    expect(paulCount).toBeGreaterThan(0);
    expect(plan.cases.length - paulCount, 'catalogue cases beyond Paul\'s methods').toBeGreaterThan(0);
    expect(plan.cases.slice(0, paulCount).every((c) => c.phase === 'paul-methods')).toBe(true);
    expect(plan.cases.slice(paulCount).every((c) => c.phase === 'catalogue')).toBe(true);
    expect(new Set(plan.cases.map((c) => c.id)).size).toBe(new Set(catalogue.map((r) => r.id)).size);
    expect(plan.missingPaulOperations).toEqual([]);
  });

  test('AC11 AC13 FR28 FR33 NFR6 — the daily suite runs end to end and yields a publishable report', async () => {
    test.setTimeout(300_000);
    const config = world.config(JSON.stringify(fixtureIds));
    const report = await runProdSuite({ connect: () => world.identityClient(), config });
    expect(report.abort).toBeNull();
    expect(report.status).toBe('completed');
    expect(report.summary.total).toBeGreaterThan(0);
    expect(report.summary.byOutcome['not-evaluated']).toBe(report.summary.total);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'axi2318-report-'));
    try {
      for (const file of writeReport(dir, report)) {
        const text = readFileSync(file, 'utf8');
        expect(findSecretShapes(text)).toEqual([]);
        expect(text).not.toMatch(/https?:\/\//i);
        expect(text.includes(new URL(API_BASE_URL).host)).toBe(false);
        expect(text.includes(world.email)).toBe(false);
      }
      const { entries } = planPublication(dir, 'prod-e2e/daily');
      expect(entries.map((e) => e.s3Key)).toEqual(['report.json', 'report.md'].map(
        (f) => `prod-e2e/daily/${report.run.startedAt.slice(0, 10)}/${config.runId}/${f}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

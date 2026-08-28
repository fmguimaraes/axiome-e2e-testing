import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertGovernanceCounterNonZero, summarizeEventCoverage } from './governanceEventsStaging';
import { checkGovernanceEventsShape } from '../fixtures/validateFixture';
import { TENANT_FIXTURE } from '../fixtures/tenantFixture';
import type { GovernanceEventExpectation } from '../fixtures/types';

/**
 * UT-STAGE-111..117 (SI-044) — FR14/AC13 (Capture Spec §15.1, AXI-1379).
 * Covers the AC13 hard gate (`assertGovernanceCounterNonZero`), the
 * feed-coverage summarizer (`summarizeEventCoverage` — pure, no network),
 * and the fixture-level 3-author/no-duplicate-kind shape check. See
 * `staging/steps/UT.md` and `governanceEventsStaging.ts`'s module doc for
 * why this story soft-logs (does not hard-assert) full 8-kind feed variety.
 */

function metrics(governanceEventsCount: number) {
  return { activeProjectsCount: 1, ingestionJobsCount: 1, qcJobsCount: 0, governanceEventsCount, windowDays: 7 };
}

test('UT-STAGE-111 (AC13): assertGovernanceCounterNonZero does not throw when governanceEventsCount is positive', () => {
  assert.doesNotThrow(() => assertGovernanceCounterNonZero(metrics(3)));
});

test('UT-STAGE-112 (AC13): assertGovernanceCounterNonZero throws loudly when governanceEventsCount is zero — a real gate, not a soft warning', () => {
  assert.throws(() => assertGovernanceCounterNonZero(metrics(0)), /AC13 violation/);
});

const EXPECTED: GovernanceEventExpectation[] = [
  { kind: 'interpretation_published', authorHandle: 'cast-clinician', description: 'x' },
  { kind: 'threshold_declared', authorHandle: 'cast-biologist', description: 'x' },
  { kind: 'dataset_ingested', authorHandle: 'cast-bioinformatician', description: 'x' },
];

test('UT-STAGE-113: summarizeEventCoverage counts distinct performedBy values from the live feed', () => {
  const feed = [
    { action: 'member_added', performedBy: 'user-a', severity: 'info' },
    { action: 'ingestion_completed', performedBy: 'user-b', severity: 'info' },
    { action: 'member_added', performedBy: 'user-a', severity: 'info' },
  ];
  const summary = summarizeEventCoverage(feed, EXPECTED);
  assert.equal(summary.distinctAuthors, 2);
  assert.equal(summary.feedEntryCount, 3);
});

test('UT-STAGE-114: summarizeEventCoverage reports expectedAuthors from the declared fixture list, not the live feed', () => {
  const summary = summarizeEventCoverage([], EXPECTED);
  assert.equal(summary.expectedAuthors, 3);
  assert.equal(summary.feedEntryCount, 0);
});

test('UT-STAGE-115: summarizeEventCoverage is stable on an empty live feed (no throw, zero counts)', () => {
  assert.deepEqual(summarizeEventCoverage([], []), { distinctAuthors: 0, feedEntryCount: 0, expectedAuthors: 0 });
});

test('UT-STAGE-116 (AC13): checkGovernanceEventsShape passes on the live TENANT_FIXTURE — 8 declared kinds, >= 3 distinct authors', () => {
  assert.deepEqual(checkGovernanceEventsShape(TENANT_FIXTURE), []);
});

test('UT-STAGE-117 (AC13): checkGovernanceEventsShape flags a fixture whose declared events span fewer than 3 authors', () => {
  const fixture = {
    ...TENANT_FIXTURE,
    content: { ...TENANT_FIXTURE.content, events: EXPECTED.slice(0, 1) },
  };
  const violations = checkGovernanceEventsShape(fixture);
  assert.ok(violations.some((v) => v.rule === 'AC13'));
});

import { SERVICE_HANDLE, recordTouched } from './context';
import { requireWorkspaceId } from './datasetIngestion';
import { projectHeaders } from './projectProvisioning';
import type { GovernanceEventExpectation } from '../fixtures/types';
import type { ProvisioningContext } from './context';
import type { Step } from './types';

/**
 * FR14/AC13 (Capture Spec §15.1, AXI-1379) — read-only verification of the
 * governance events feed and its counters. This step creates NOTHING: every
 * `content.events[]` kind (see that type's doc) is the byproduct of a REST
 * action a DIFFERENT step already performs for its own domain reason. What
 * this step does is confirm, over REST, what actually comes back — and be
 * honest about what does not.
 *
 * CONFIRMED BACKEND GAP (this story's investigation, read-only — SI-044 is
 * REST-only, no backend change here): `GET /api/v1/home/events`
 * (`home.service.ts`, a live UNION across 9 domain audit-log tables) and
 * `GET /api/v1/overview/events` (`overview.service.ts`, backed by the
 * `OverviewEvent` table, itself populated by a 5-minute `@Cron` projector in
 * `event-normalization.service.ts`) are the only two REST-readable "events
 * feed" surfaces the frontend actually renders (`EventsFeed.tsx` on the Home
 * page and on each Overview tab — confirmed by reading both). Between them
 * they cover only 2 of this story's 8 governance-event kinds:
 *   - `interpretation_published` -> projected into `overview_events`
 *     (category `governance`) by `projectInterpretationEvents()`, on the
 *     5-minute cron.
 *   - `dataset_ingested` -> unioned into `/home/events` via
 *     `ingestion_audit_logs`, but landed in `event-mapping.config.ts` under
 *     category `operational`, not `governance`.
 * The other 6 kinds (`threshold_declared`, `snapshot_created`,
 * `evidence_declared`, `external_member_invited`, `comment_resolved`,
 * `attestation_computed`) each write a REAL, correctly-attributed audit
 * entry of their own (`thresholdAuditLog`, none for snapshots,
 * `declarationDraftAuditLog`, `clientExplorationAuditLog`, event-service's
 * separate hash-chained log, `attestationAuditLog`) that neither the
 * `home.service.ts` union nor `EventNormalizationService`'s cron source list
 * reads. No REST route exists to add coverage from the toolkit side — this
 * is a genuine, evidenced product gap (closing it means widening those two
 * projectors' source lists in `axiome-back`), logged here for a follow-up
 * story rather than worked around with a synthetic write. `POST
 * /api/v1/engagement/events` was investigated and rejected as a workaround:
 * it is ADMIN-gated (`assertAdmin`, `engagement.controller.ts`) and always
 * attributes the event to the CALLER, so it cannot produce cast-authored
 * events at all, and its own closed `EngagementEventType`/
 * `EngagementArtifactType` enums have no member for 5 of the 6 missing kinds
 * regardless.
 *
 * What this step DOES hard-assert (AC13's "no counter reads zero", the
 * portion that IS checkable over REST): `GET /api/v1/home/metrics`'s
 * `governanceEventsCount` (a live count of `workspaceAuditLog` rows with
 * `member_added`/`member_removed`/`role_changed`/`status_change` actions,
 * `home.service.ts` `getMetrics`) — non-zero because every cast member's
 * workspace-role grant across this epic's earlier stories writes exactly
 * that action. What it SOFT-logs (DEFERRED, same pattern as AXI-1378's
 * external-thread message count): the full 8-kind/3-author feed-variety
 * claim, pending the backend projector fix above.
 */
export const verifyGovernanceEventsStep: Step<ProvisioningContext> = {
  id: 'verify-governance-events',
  dependsOn: ['ensure-attestation', 'ensure-sponsor-export', 'verify-external-scoping'],
  async run(ctx) {
    const content = ctx.fixture.content;
    const primary = content.datasets.find((d) => d.role === 'de_table');
    if (!primary) return;
    const workspaceId = requireWorkspaceId(ctx, primary.workspaceName);
    const metrics = await fetchHomeMetrics(ctx);
    assertGovernanceCounterNonZero(metrics);
    const feed = await fetchWorkspaceFeed(ctx, workspaceId);
    reportCoverage(feed, content.events);
    recordTouched(ctx, { kind: 'governance-events-verification', name: 'home-metrics-non-zero', id: workspaceId, action: 'linked' });
  },
};

// ─── Counters (AC13 "no counter reads zero") ───────────────────────────

interface HomeMetrics {
  activeProjectsCount: number;
  ingestionJobsCount: number;
  qcJobsCount: number;
  governanceEventsCount: number;
  windowDays: number;
}

async function fetchHomeMetrics(ctx: ProvisioningContext): Promise<HomeMetrics> {
  const res = await ctx.client.as<HomeMetrics>(SERVICE_HANDLE, 'GET', '/api/v1/home/metrics');
  if (!res.ok || !res.body) throw new Error(`fetching home metrics failed (status ${res.status})`);
  return res.body;
}

/** Exported for unit testing — pure, no network. Hard gate: the AC13 clause
 *  this toolkit CAN verify without waiting on a cron cycle. */
export function assertGovernanceCounterNonZero(metrics: HomeMetrics): void {
  if (metrics.governanceEventsCount > 0) return;
  throw new Error(
    `AC13 violation: /api/v1/home/metrics.governanceEventsCount reads 0 within the ${metrics.windowDays}-day window — ` +
      'expected non-zero from this tenant\'s workspace-role grants (member_added/role_changed audit rows)',
  );
}

// ─── Feed coverage (soft-logged, DEFERRED — see module doc) ────────────

interface HomeEvent {
  action: string;
  performedBy: string;
  severity: string;
}

async function fetchWorkspaceFeed(ctx: ProvisioningContext, workspaceId: string): Promise<HomeEvent[]> {
  const res = await ctx.client.as<{ data: HomeEvent[] }>(SERVICE_HANDLE, 'GET', `/api/v1/home/events?workspaceId=${workspaceId}&limit=100`, undefined, projectHeaders(workspaceId));
  return res.ok ? (res.body?.data ?? []) : [];
}

/** Exported for unit testing — pure, no network. */
export function summarizeEventCoverage(feed: HomeEvent[], expected: GovernanceEventExpectation[]): { distinctAuthors: number; feedEntryCount: number; expectedAuthors: number } {
  const distinctAuthors = new Set(feed.map((e) => e.performedBy)).size;
  const expectedAuthors = new Set(expected.map((e) => e.authorHandle)).size;
  return { distinctAuthors, feedEntryCount: feed.length, expectedAuthors };
}

function reportCoverage(feed: HomeEvent[], expected: GovernanceEventExpectation[]): void {
  const summary = summarizeEventCoverage(feed, expected);
  console.log(`[staging] governance events: /home/events returned ${summary.feedEntryCount} entries, ${summary.distinctAuthors} distinct author(s) (declared expectation: ${expected.length} kinds across ${summary.expectedAuthors} authors)`);
  console.log('[staging] DEFERRED (AC13 feed-variety, see governanceEventsStaging.ts module doc): only interpretation_published and dataset_ingested are currently projected into any REST-readable feed; the other 6 declared kinds write real, correctly-attributed audit rows that no existing projector reads — a confirmed backend gap, not fixed in this story (SI-044 is REST-only).');
}

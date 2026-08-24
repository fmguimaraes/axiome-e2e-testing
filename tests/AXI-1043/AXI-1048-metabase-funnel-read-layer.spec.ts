import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { apiUrl, METABASE_BASE_URL } from '../../config/env';

/**
 * Behavior Tracking — capture → read layer (epic AXI-1043).
 *
 * Two halves of the same first-party pipeline, exercised over real HTTP:
 *
 *  - Capture (AXI-1046, FR4/AC7): the same-origin, `@Public()` ingest at
 *    `POST /api/v1/events` accepts a batch and stamps server-only metadata
 *    (`deployment_id`, `schema_version`) — the client never supplies those.
 *  - Read layer (AXI-1048, FR10/AC4): Metabase reads the events back out of
 *    `organization_svc.analytics_events`. A journey ingested here is then read
 *    through Metabase's own query API, closing the capture→read loop.
 *
 * The events feed is renamed `analytics_events` (AXI-1155) — the read layer, and
 * therefore this spec, target that name, not the original `events`.
 *
 * Metabase is the optional `make analytics-up` overlay, not part of the base
 * `make local-up` stack the suite targets by default, so the read-layer tests
 * PROBE it and `skip` (never fail) when it is unreachable. The `/api/dataset`
 * round-trip additionally needs a Metabase admin — set METABASE_USER /
 * METABASE_PASSWORD to enable it; it skips with a notice otherwise.
 *
 * Funnel-SQL *correctness* (the six funnels, the least-privilege `metabase_ro`
 * role) is owned by axiome-infra's `make analytics-test`; this spec proves the
 * platform's capture and read paths line up end to end through the browser-
 * reachable HTTP surface.
 */

const EVENTS_ENDPOINT = apiUrl('api/v1/events');

// Headline funnel (funnel 1) step order — the read layer aggregates distinct
// actors through these in ts_server order.
const HEADLINE_JOURNEY = [
  'analysis_table_explored',
  'evidence_saved',
  'interpretation_created',
  'interpretation_viewed',
  'interpretation_approved',
  'interpretation_published',
] as const;

const MB_USER = process.env.METABASE_USER;
const MB_PASSWORD = process.env.METABASE_PASSWORD;

/** Wire-format (snake_case) envelopes for one analyst actor, ts_client ascending. */
function analystJourney(actor: string, runId: string) {
  const base = Date.parse('2020-01-01T00:00:00Z');
  return HEADLINE_JOURNEY.map((event, i) => ({
    event,
    actor_role: 'analyst',
    anonymous_id: actor,
    props: { e2e: runId },
    ts_client: new Date(base + i * 1000).toISOString(),
  }));
}

function ingest(request: APIRequestContext, events: unknown[]) {
  return request.post(EVENTS_ENDPOINT, { data: { events } });
}

/** True when the Metabase overlay answers its health probe; never throws. */
async function metabaseReachable(request: APIRequestContext): Promise<boolean> {
  try {
    const res = await request.get(`${METABASE_BASE_URL}/api/health`, { timeout: 4000 });
    return res.ok();
  } catch {
    return false;
  }
}

async function metabaseSession(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${METABASE_BASE_URL}/api/session`, {
    data: { username: MB_USER, password: MB_PASSWORD },
  });
  expect(res.ok(), 'Metabase login failed — check METABASE_USER/METABASE_PASSWORD').toBeTruthy();
  return (await res.json()).id as string;
}

/** The Metabase database id of the Postgres deployment DB (override: METABASE_DATABASE_ID). */
async function metabasePostgresDbId(request: APIRequestContext, token: string): Promise<number> {
  if (process.env.METABASE_DATABASE_ID) return Number(process.env.METABASE_DATABASE_ID);
  const res = await request.get(`${METABASE_BASE_URL}/api/database`, {
    headers: { 'X-Metabase-Session': token },
  });
  const body = await res.json();
  const list = (Array.isArray(body) ? body : body.data) as Array<{ id: number; engine: string }>;
  const pg = list.find((d) => d.engine === 'postgres');
  expect(pg, 'no PostgreSQL database configured in Metabase').toBeTruthy();
  return pg!.id;
}

/** Run a native SQL query through Metabase's own query engine; returns result rows. */
async function metabaseNativeQuery(
  request: APIRequestContext,
  token: string,
  database: number,
  query: string,
): Promise<unknown[][]> {
  const res = await request.post(`${METABASE_BASE_URL}/api/dataset`, {
    headers: { 'X-Metabase-Session': token },
    data: { database, type: 'native', native: { query } },
  });
  expect(res.ok(), 'Metabase /api/dataset query failed').toBeTruthy();
  return (await res.json()).data.rows as unknown[][];
}

test.describe('AXI-1046 — first-party ingest (capture half)', () => {
  test('FR4 AC7 — POST /api/v1/events accepts a public batch and stamps server metadata', async ({
    request,
  }) => {
    const runId = randomUUID();
    const res = await ingest(request, analystJourney(`e2e-analyst-${runId}`, runId));

    expect(res.status()).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(HEADLINE_JOURNEY.length);
    // deployment_id and schema_version are server-only — the client never sends
    // them, yet the response carries them, proving the server stamps the envelope.
    expect(body.deploymentId).toBeTruthy();
    expect(body.schemaVersion).toBeGreaterThanOrEqual(1);
  });

  test('FR4 — the envelope is closed: server-only and invalid fields are rejected (400)', async ({
    request,
  }) => {
    // deployment_id is server-only; forbidNonWhitelisted rejects the spoof attempt.
    const spoofed = await ingest(request, [
      { event: 'analysis_table_explored', actor_role: 'analyst', deployment_id: 'spoofed' },
    ]);
    expect(spoofed.status()).toBe(400);

    // actor_role is a closed enum (analyst | client).
    const badRole = await ingest(request, [{ event: 'analysis_table_explored', actor_role: 'hacker' }]);
    expect(badRole.status()).toBe(400);

    // A batch must carry at least one event (ArrayMinSize).
    const empty = await ingest(request, []);
    expect(empty.status()).toBe(400);
  });
});

test.describe('AXI-1048 — Metabase read layer (FR10/AC4)', () => {
  test('FR10 AC4 — the Metabase read layer is up and healthy', async ({ request }) => {
    test.skip(
      !(await metabaseReachable(request)),
      `Metabase not reachable at ${METABASE_BASE_URL} — start it with 'make analytics-up'`,
    );
    const res = await request.get(`${METABASE_BASE_URL}/api/health`);
    expect((await res.json()).status).toBe('ok');
  });

  test('FR10 AC4 — an ingested journey is readable through Metabase (capture → read round-trip)', async ({
    request,
  }) => {
    test.skip(
      !(await metabaseReachable(request)),
      `Metabase not reachable at ${METABASE_BASE_URL} — start it with 'make analytics-up'`,
    );
    test.skip(
      !MB_USER || !MB_PASSWORD,
      'set METABASE_USER / METABASE_PASSWORD (a Metabase admin) to run the read round-trip',
    );

    // Capture: push a unique complete journey through the real ingest path.
    const runId = randomUUID();
    const actor = `e2e-read-${runId}`;
    expect((await ingest(request, analystJourney(actor, runId))).status()).toBe(202);

    // Read: the same events come back out of analytics_events via the read layer.
    const token = await metabaseSession(request);
    const dbId = await metabasePostgresDbId(request, token);
    const rows = await metabaseNativeQuery(
      request,
      token,
      dbId,
      `SELECT count(DISTINCT event) AS steps
         FROM organization_svc.analytics_events
        WHERE anonymous_id = '${actor}' AND actor_role = 'analyst'`,
    );
    // All six headline steps landed and are readable through Metabase.
    expect(Number(rows[0][0])).toBe(HEADLINE_JOURNEY.length);
  });
});

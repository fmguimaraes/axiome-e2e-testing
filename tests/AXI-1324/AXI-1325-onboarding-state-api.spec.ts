import { test, expect, type APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1325 — Onboarding state: user-scoped API (epic AXI-1324). Manual-E2E
 * §AXI-1324-Onboarding §4-5.
 *
 * API-level (no browser): the onboarding-state endpoints back every tour's
 * persistence. Verifies the security-critical property — a user reads/writes
 * ONLY their own state — plus idempotent upsert and user (not tenant) scoping.
 * Runs against the live backend; identity is derived server-side from the JWT,
 * so the contract holds regardless of any workspace header.
 *
 * @SI-011 (user-service state + migration), @SI-010 (gateway route),
 * @SI-002 (contract). ACs: AC14 (user-scoped), AC15 (idempotent/recover),
 * AC16 (no cross-user access).
 */

const ONBOARDING_STATE = '/api/v1/onboarding-state';
// A tour id private to this spec so it never collides with the shipped registry.
const TOUR_ID = 'e2e.onboarding-state-1325';

type Tokens = { accessToken: string; refreshToken: string };

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function getState(api: APIRequestContext, token: string) {
  const res = await api.get(apiUrl(ONBOARDING_STATE), { headers: authed(token) });
  expect(res.ok(), `GET ${ONBOARDING_STATE} → ${res.status()}`).toBeTruthy();
  return (await res.json()) as Array<{ tourId: string; status: string; stepIndex: number; tourVersion: number }>;
}

async function upsert(api: APIRequestContext, token: string, body: Record<string, unknown>) {
  return api.put(apiUrl(ONBOARDING_STATE), { headers: authed(token), data: body });
}

test.describe('AXI-1325 — onboarding-state user-scoped API (AC14/AC15/AC16)', () => {
  let userToken = '';
  let adminToken = '';

  test.beforeAll(async ({ playwright }) => {
    const api = await playwright.request.newContext();
    const user = ROLES.find((r) => r.name === 'user')!;
    const admin = ROLES.find((r) => r.name === 'admin')!;
    userToken = ((await ensureAuthTokens(api, user)) as Tokens).accessToken;
    adminToken = ((await ensureAuthTokens(api, admin)) as Tokens).accessToken;
    await api.dispose();
  });

  test('AC15 — upsert is idempotent on (userId,tourId) and echoes the row', { tag: ['@SI-011', '@SI-010', '@SI-002'] }, async ({ request }) => {
    const first = await upsert(request, userToken, { tourId: TOUR_ID, tourVersion: 1, status: 'in_progress', stepIndex: 2 });
    expect(first.ok(), `first PUT → ${first.status()}`).toBeTruthy();
    expect(await first.json()).toMatchObject({ tourId: TOUR_ID, status: 'in_progress', stepIndex: 2 });

    // Second write to the SAME tour updates the same row (no duplicate) and advances it.
    const second = await upsert(request, userToken, { tourId: TOUR_ID, tourVersion: 1, status: 'completed', stepIndex: 5 });
    expect(second.ok()).toBeTruthy();
    expect(await second.json()).toMatchObject({ tourId: TOUR_ID, status: 'completed', stepIndex: 5 });

    const rows = await getState(request, userToken);
    const mine = rows.filter((r) => r.tourId === TOUR_ID);
    expect(mine, 'exactly one row for the tour (idempotent upsert)').toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'completed', stepIndex: 5 });
  });

  test('AC16 — a client cannot spoof identity; a body userId is rejected', { tag: ['@SI-011', '@SI-010'] }, async ({ request }) => {
    // The gateway DTO omits userId and the global forbidNonWhitelisted pipe rejects it.
    const res = await upsert(request, userToken, {
      tourId: TOUR_ID, tourVersion: 1, status: 'in_progress', stepIndex: 0, userId: 'some-other-user',
    });
    expect(res.status(), 'spoofed userId must be 400-rejected').toBe(400);
  });

  test('AC16 — each user sees only their own state (no cross-user disclosure)', { tag: ['@SI-011'] }, async ({ request }) => {
    // Seed a distinct row per identity, then confirm neither leaks into the other.
    await upsert(request, userToken, { tourId: 'e2e.only-user', tourVersion: 1, status: 'completed', stepIndex: 1 });
    await upsert(request, adminToken, { tourId: 'e2e.only-admin', tourVersion: 1, status: 'completed', stepIndex: 1 });

    const userRows = await getState(request, userToken);
    const adminRows = await getState(request, adminToken);
    expect(userRows.some((r) => r.tourId === 'e2e.only-user')).toBeTruthy();
    expect(userRows.some((r) => r.tourId === 'e2e.only-admin'), 'user must not see admin state').toBeFalsy();
    expect(adminRows.some((r) => r.tourId === 'e2e.only-user'), 'admin must not see user state').toBeFalsy();
  });

  test('AC16 — an unauthenticated request is rejected', { tag: ['@SI-010'] }, async ({ request }) => {
    const res = await request.get(apiUrl(ONBOARDING_STATE));
    expect([401, 403]).toContain(res.status());
  });

  test('AC14 — state is user-scoped, not tenant-scoped (workspace header does not partition it)', { tag: ['@SI-011'] }, async ({ request }) => {
    await upsert(request, userToken, { tourId: 'e2e.tenant-neutral', tourVersion: 1, status: 'completed', stepIndex: 3 });
    // The same identity under a different active-workspace header sees the same row —
    // onboarding state is keyed on the user alone (FR25/AC14).
    const res = await request.get(apiUrl(ONBOARDING_STATE), {
      headers: { ...authed(userToken), 'X-Workspace-Id': 'some-other-workspace' },
    });
    expect(res.ok()).toBeTruthy();
    const rows = (await res.json()) as Array<{ tourId: string; status: string }>;
    expect(rows.find((r) => r.tourId === 'e2e.tenant-neutral')).toMatchObject({ status: 'completed' });
  });
});

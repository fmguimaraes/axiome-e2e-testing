import { test, expect, request as apiRequest, APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, Api } from '../AXI-1435/harness/api';

/**
 * AXI-1051 — Poster Feature Full Removal, Workflow 5 integrated epic spec.
 *
 * Scenario file: axiome-docs/manual-e2e/AXI-1051-Poster-Feature-Full-Removal.md
 * (§4.1, §4.2, §4.6, §5.1, §5.2). API-only: no `page`, no storageState. Signs in
 * over the API through the shared admin harness.
 *
 * Every former poster route (Poster Core, AXI-578, and the public engagement
 * layer, AXI-579) must answer 404 now that the gateway no longer registers
 * either proxy controller (AXI-2729). A 401 would mean a guard still fronts a
 * route that exists. A 5xx would mean a dangling handler. Both are failures.
 */

const FAKE_ID = '00000000-0000-4000-8000-000000000000';

/** Every route the two deleted gateway controllers served, under the gateway's `/api/v1` prefix. */
const FORMER_POSTER_ROUTES: ReadonlyArray<[method: 'get' | 'post' | 'patch' | 'delete', path: string]> = [
  // posters.controller.ts (Poster Core)
  ['post', '/api/v1/posters'],
  ['get', '/api/v1/posters'],
  ['get', '/api/v1/posters/by-slug/some-slug'],
  ['get', `/api/v1/posters/${FAKE_ID}`],
  ['patch', `/api/v1/posters/${FAKE_ID}`],
  ['post', `/api/v1/posters/${FAKE_ID}/publish`],
  ['post', `/api/v1/posters/${FAKE_ID}/unpublish`],
  ['delete', `/api/v1/posters/${FAKE_ID}`],
  ['get', `/api/v1/posters/${FAKE_ID}/audit-logs`],
  // poster-engagement.controller.ts (public engagement; the first three were @Public())
  ['post', `/api/v1/posters/${FAKE_ID}/events`],
  ['post', `/api/v1/posters/${FAKE_ID}/viewers`],
  ['post', `/api/v1/posters/${FAKE_ID}/comments`],
  ['get', `/api/v1/posters/${FAKE_ID}/comments`],
  ['patch', `/api/v1/posters/comments/${FAKE_ID}/moderate`],
  ['delete', `/api/v1/posters/comments/${FAKE_ID}`],
  ['get', `/api/v1/posters/${FAKE_ID}/analytics`],
];

async function call(ctx: APIRequestContext, method: string, path: string, headers: Record<string, string> = {}) {
  const opts = { headers, failOnStatusCode: false, ...(method === 'get' || method === 'delete' ? {} : { data: {} }) };
  const res = await (ctx as any)[method](apiUrl(path), opts);
  return res.status() as number;
}

test.describe('AXI-1051 epic — poster surface is gone', { tag: ['@SI-010', '@SI-018'] }, () => {
  let anon: APIRequestContext;
  let admin: Api;

  test.beforeAll(async () => {
    anon = await apiRequest.newContext();
    admin = await adminApi();
  });

  test.afterAll(async () => {
    await anon?.dispose();
    await admin?.ctx.dispose();
  });

  test('AC4 AC5 — every former /v1/posters* route returns 404 to an anonymous caller', async () => {
    const statuses: Record<string, number> = {};
    for (const [method, path] of FORMER_POSTER_ROUTES) {
      statuses[`${method.toUpperCase()} ${path}`] = await call(anon, method, path);
    }
    for (const [route, status] of Object.entries(statuses)) {
      expect(status, route).toBe(404);
    }
  });

  test('AC5 NFR8 — an authenticated admin also gets 404, never 5xx (§5.1)', async () => {
    for (const [method, path] of FORMER_POSTER_ROUTES) {
      const status =
        method === 'get'
          ? (await admin.get(path)).status
          : method === 'post'
            ? (await admin.post(path, {})).status
            : method === 'patch'
              ? (await admin.patch(path, {})).status
              : await call(admin.ctx, method, path);
      expect(status, `${method.toUpperCase()} ${path}`).toBe(404);
    }
  });

  test('AC5 — a forged bearer token against a removed route is 404, not 401 (§5.2)', async () => {
    const forged = { Authorization: 'Bearer forged.not-a.jwt' };
    expect(await call(anon, 'get', '/api/v1/posters', forged)).toBe(404);
    expect(await call(anon, 'post', `/api/v1/posters/${FAKE_ID}/comments`, forged)).toBe(404);
  });

  test('control — a surviving guarded route still answers 401 anonymously (the 404s above are real)', async () => {
    expect(await call(anon, 'get', '/api/v1/roles')).toBe(401);
  });
});

test.describe('AXI-1051 epic — no persisted role grants poster:*', { tag: ['@SI-011', '@SI-043'] }, () => {
  test('AC10 — no role returned by the gateway lists a poster:* permission (§4.6)', async () => {
    const admin = await adminApi();
    try {
      const res = await admin.get('/api/v1/roles?includeUnused=true');
      expect(res.status).toBe(200);
      const roles: Array<{ name: string; permissions?: unknown }> = Array.isArray(res.body)
        ? res.body
        : (res.body?.data ?? res.body?.roles ?? []);
      expect(roles.length, 'roles list must not be empty, or the check proves nothing').toBeGreaterThan(0);
      const offenders = roles
        .map((r) => ({ name: r.name, poster: (Array.isArray(r.permissions) ? r.permissions : []).filter((p) => String(p).startsWith('poster:')) }))
        .filter((r) => r.poster.length > 0);
      expect(offenders).toEqual([]);
    } finally {
      await admin.ctx.dispose();
    }
  });
});

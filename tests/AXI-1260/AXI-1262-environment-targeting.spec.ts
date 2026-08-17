import { test, expect, request } from '@playwright/test';
import { BASE_URL, API_BASE_URL, OBJECT_PUBLIC_URL, apiUrl, objectUrl } from '../../config/env';

/**
 * Environment targeting (AXI-1262 — FR6/FR7/FR8, AC3).
 *
 * Proves the suite's origins come only from environment variables, so the same
 * specs retarget from local to a deployed environment by changing `BASE_URL` /
 * `API_BASE_URL` alone — no spec, selector, or config edit. Also pins FR8: the
 * browser reaches object storage through the public endpoint, never the
 * service-internal one. Assertions are web-first / reachability-based against
 * the running local stack (NFR4).
 */
test.describe('AXI-1262 — environment targeting', () => {
  test('AC3 — front-end origin is env-driven and the app is reachable there', async ({ page }) => {
    // baseURL resolves from BASE_URL (falling back to the local default) — the
    // only knob that retargets the browser (FR6/FR7).
    expect(BASE_URL).toBe(process.env.BASE_URL?.replace(/\/+$/, '') ?? 'http://localhost:5173');
    await page.goto('/');
    await expect(page).toHaveTitle(/Axiome/i);
  });

  test('AC3 — API origin is env-driven and reachable', async () => {
    expect(API_BASE_URL).toBe(process.env.API_BASE_URL?.replace(/\/+$/, '') ?? 'http://localhost:3000');
    const api = await request.newContext();
    const res = await api.get(apiUrl('/api/v1/health/live'));
    expect(res.ok()).toBeTruthy();
    await api.dispose();
  });

  test('FR8 — object storage is reached through the public browser endpoint', async () => {
    // The public endpoint (localhost:9000 by default) — never the
    // service-internal `minio:9000` a browser cannot resolve.
    expect(OBJECT_PUBLIC_URL).not.toMatch(/\/\/minio:/);
    expect(objectUrl('/bucket/key.csv')).toBe(`${OBJECT_PUBLIC_URL}/bucket/key.csv`);
    const store = await request.newContext();
    const res = await store.get(objectUrl('/minio/health/live'));
    expect(res.ok()).toBeTruthy();
    await store.dispose();
  });
});

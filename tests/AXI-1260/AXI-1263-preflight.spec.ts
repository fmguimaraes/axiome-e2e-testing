import { test, expect } from '@playwright/test';
import { runPreflight, INFRA_FAULT_EXIT_CODE } from '../../preflight/preflight';
import { BASE_URL, API_BASE_URL } from '../../config/env';

/**
 * Preflight verification (AXI-1263 — FR9/FR10/FR11, AC4/AC5/AC6).
 *
 * These specs only run because the real preflight (`globalSetup`) already
 * passed, so the happy path is proven by the suite executing at all. They
 * additionally exercise the preflight *logic* directly: it detects a healthy
 * environment, and it detects a down front-end / down API / missing seed as an
 * infrastructure fault with the reserved exit code — without a parallel seeding
 * mechanism (it verifies, never seeds — AC6).
 */
test.describe('AXI-1263 — fail-closed preflight', () => {
  test('AC4 — preflight passes against the running, seeded local stack', async () => {
    const result = await runPreflight(BASE_URL, API_BASE_URL);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test('AC5 — an unreachable front-end is reported as an infrastructure fault', async () => {
    const result = await runPreflight('http://localhost:59999', API_BASE_URL);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => /front-end unreachable/.test(f))).toBe(true);
  });

  test('AC5 — an unreachable API is reported (reachability + seed both fail)', async () => {
    const result = await runPreflight(BASE_URL, 'http://localhost:59998');
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => /API unreachable/.test(f))).toBe(true);
    // Seed check also fails and points the operator at the platform seed command (FR11/AC6).
    expect(result.failures.some((f) => /make seed/.test(f))).toBe(true);
  });

  test('AC5 — the reserved infra-fault code is distinct from the test-failure code', () => {
    expect(INFRA_FAULT_EXIT_CODE).toBe(78);
    expect(INFRA_FAULT_EXIT_CODE).not.toBe(1);
  });
});

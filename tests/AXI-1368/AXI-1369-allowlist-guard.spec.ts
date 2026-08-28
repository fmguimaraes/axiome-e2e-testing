import { test, expect } from '@playwright/test';
import { assertAllowListed, readAllowList } from '../../staging/config/allowlist';
import { RestClient } from '../../staging/client/RestClient';

/**
 * AXI-1369 — base-URL allow-list guard (NFR2, EC10). Manual-E2E §AXI-1368
 * §5.1. API-level, no browser: pure-function + constructor guard, no live
 * request needed to prove the refusal.
 *
 * @SI-044.
 */

test.describe('NFR2 EC10 — staging toolkit refuses a non-allow-listed base URL', () => {
  test('NFR2 EC10 — assertAllowListed throws for an arbitrary origin', () => {
    expect(() => assertAllowListed('https://example.com', ['http://localhost:3000'])).toThrow(/not allow-listed/);
  });

  test('NFR2 EC10 — assertAllowListed passes for an exact allow-listed origin', () => {
    expect(() => assertAllowListed('http://localhost:3000', ['http://localhost:3000'])).not.toThrow();
  });

  test('NFR2 EC10 — a trailing slash does not defeat the exact-match guard', () => {
    expect(() => assertAllowListed('http://localhost:3000/', ['http://localhost:3000'])).not.toThrow();
  });

  test('NFR2 EC10 — RestClient construction refuses a non-allow-listed base URL before any call is made', () => {
    expect(() => new RestClient({ baseUrl: 'https://platform.axiomebio.com', allowList: ['http://localhost:3000'] })).toThrow();
  });

  test('NFR2 EC10 — the default allow-list never accepts an axiomebio.com origin, even if added explicitly', () => {
    expect(() => assertAllowListed('https://staging.axiomebio.com', [...readAllowList(), 'https://staging.axiomebio.com'])).toThrow(
      /production-looking/,
    );
  });

  test('NFR2 — readAllowList always includes the local make local-up default with no env override', () => {
    const list = readAllowList({} as NodeJS.ProcessEnv);
    expect(list).toContain('http://localhost:3000');
  });

  test('NFR2 — readAllowList merges STAGING_ALLOWED_BASE_URLS without duplicating the defaults', () => {
    const list = readAllowList({ STAGING_ALLOWED_BASE_URLS: 'http://localhost:3000, http://localhost:4000' } as NodeJS.ProcessEnv);
    expect(list.filter((u) => u === 'http://localhost:3000')).toHaveLength(1);
    expect(list).toContain('http://localhost:4000');
  });
});

import { test, expect } from '@playwright/test';
import { API_BASE_URL } from '../../config/env';
import { ROLES } from '../../config/roles';
import {
  createApiClient,
  createTokenProvider,
  fetchTransport,
  isExpiredTokenRefusal,
  loginForToken,
} from '../AXI-2309/harness/prod-suite/api-client';
import { prodSuiteEnabled } from '../AXI-2309/harness/prod-suite/config';

/**
 * AXI-2357 (epic AXI-2358 Platform Opening: Headless — Fast-Follow Defects) —
 * the prod-suite API client survives the 15-min access-token lifetime
 * (user-service `JWT_EXPIRES_IN || '15m'`) over the daily suite's 60-min budget.
 *
 * A live stack cannot be made to expire a token on demand (the lifetime is
 * server config), so these scenarios drive the client's REACTIVE path with a
 * token the real gateway refuses exactly as it refuses an expired one
 * (`401 {message: 'Invalid token'}` — a JWT-shaped token signed with the wrong
 * secret), and pin that refusal shape against the real gateway. The proactive
 * renewal and single-flight behaviour are clock-driven and covered by
 * harness-unit `AXI-2357/token-refresh.spec.ts` (UT-PRODE2E-6100..6113).
 *
 * Local/demo stack only (logs in as the seeded admin); skips whenever the
 * daily-suite switch is on, so it can never run on prod.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2358-Platform-Opening-Headless-Fast-Follow-Defects.md
 * § "AXI-2357 — Prod-suite token refresh" (AXI-2357.1 .. .3).
 */

test.use({ storageState: { cookies: [], origins: [] }, trace: 'off', video: 'off', screenshot: 'off' });

const TAGS = { tag: ['@SI-042', '@SI-041'] };
/** Never issued by any stack — keeps the EC9 tripwire armed (it refuses an empty list). */
const NEVER_ISSUED_ORG_ID = '00000000-0000-4000-8000-000000000000';

/** A JWT-shaped token with a far-future `exp` and a signature no stack will accept. */
function rejectedToken(): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: 'axi-2357', iat, exp: iat + 3600 })}.${enc('not-a-signature')}`;
}

function admin() {
  const role = ROLES.find((r) => r.name === 'admin');
  if (!role) throw new Error('admin role missing from ROLES registry');
  return role;
}

test.describe('AXI-2357 — prod-suite API client token refresh', TAGS, () => {
  test.skip(prodSuiteEnabled(process.env), 'logs in as the platform admin — never run it on prod');

  test('FR28 FR33 — AXI-2357.1 the gateway refuses a rejected token with the exact shape the client renews on; other 401s are not', async () => {
    const url = `${API_BASE_URL}/api/v1/auth/me`;
    const refused = await fetchTransport('GET', url, { Authorization: `Bearer ${rejectedToken()}` });
    expect(refused.status).toBe(401);
    expect(isExpiredTokenRefusal(refused), 'gateway refusal body for an invalid token').toBe(true);
    const malformed = await fetchTransport('GET', url, { Authorization: 'Basic not-a-bearer' });
    expect(malformed.status).toBe(401);
    expect(isExpiredTokenRefusal(malformed), 'a malformed header is not a token-lifetime refusal').toBe(false);
  });

  test('FR28 FR30 — AXI-2357.2 a client whose token the gateway refuses re-logs in once and the request succeeds', async () => {
    const { email, password } = admin();
    let logins = 0;
    const auth = createTokenProvider({
      login: async () => { logins++; return loginForToken(API_BASE_URL, email, password); },
      initialToken: rejectedToken(),
    });
    const client = createApiClient({ apiBaseUrl: API_BASE_URL, token: '', auth, forbiddenIds: [NEVER_ISSUED_ORG_ID] }, fetchTransport);
    const me = await client.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body?.email).toBe(email);
    expect(logins).toBe(1);
    // The renewed token is reused: a second call needs no further login.
    expect((await client.get('/api/v1/auth/me')).status).toBe(200);
    expect(logins).toBe(1);
  });

  test('FR33 — AXI-2357.3 a re-login that fails surfaces as a failure naming the status only — never a pass, never a loop', async () => {
    // An identity that does not exist — never a wrong password on a real account (lockout).
    const email = `axi2357-no-such-identity-${Date.now()}@axiome.local`;
    const password = 'AXI2357-not-a-real-password!';
    let logins = 0;
    const auth = createTokenProvider({
      login: async () => { logins++; return loginForToken(API_BASE_URL, email, password); },
      initialToken: rejectedToken(),
    });
    const client = createApiClient({ apiBaseUrl: API_BASE_URL, token: '', auth, forbiddenIds: [NEVER_ISSUED_ORG_ID] }, fetchTransport);
    const err = await client.get('/api/v1/auth/me').then(() => null, (e: Error) => e);
    expect(err, 'the request must reject').not.toBeNull();
    expect(err!.message).toMatch(/^prod suite login failed -> HTTP 4\d\d$/);
    expect(err!.message.includes(email)).toBe(false);
    expect(err!.message.includes(password)).toBe(false);
    expect(logins).toBe(1);
  });
});

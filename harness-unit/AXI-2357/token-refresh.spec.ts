import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  connectApiClient,
  createApiClient,
  createTokenProvider,
  DEFAULT_REFRESH_MARGIN_MS,
  ForbiddenReferenceError,
  isExpiredTokenRefusal,
  tokenLifetimeMs,
  type ApiResponse,
  type Transport,
} from '../../tests/AXI-2309/harness/prod-suite/api-client';

/**
 * UT-PRODE2E-6100 .. UT-PRODE2E-6113 (epic AXI-2358 — AXI-2357, SI-042).
 * The prod-suite API client keeps the confined identity's 15-min access token
 * (user-service `JWT_EXPIRES_IN || '15m'`) valid for the daily suite's 60-min
 * budget: proactive re-login before the lifetime runs out, exactly one reactive
 * retry after a 401 "Invalid token", single-flight renewal across parallel
 * requests, and a second 401 surfaced as-is. A fake clock and a fake gateway
 * that enforces `exp` — no network. Run via `npm run harness:unit`. See `UT.md`.
 */

// ── fakes ────────────────────────────────────────────────────────────────

const PAUL = '66666666-6666-4666-8666-666666666666';
const WS = '22222222-2222-4222-8222-222222222222';
const LIFETIME_S = 900;
const EMAIL = 'confined-identity@axiome.test';
const PASSWORD = 'S3cret-not-to-leak!';

/** An unsigned JWT-shaped token with the given claims (the client never verifies signatures). */
function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}.c2ln`;
}

function claimsOf(token: string): { exp: number; n: number } {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

class Clock {
  t = 1_800_000_000_000;
  now = () => this.t;
  advance(ms: number) { this.t += ms; }
}

/**
 * A fake gateway: `/auth/login` issues a 15-min token stamped from the fake
 * clock; every other path answers 401 "Invalid token" once the bearer's `exp`
 * has passed (exactly what apps/gateway/src/guards/auth.guard.ts does).
 */
function fakeGateway(clock: Clock, opts: { loginStatus?: () => number; gate?: () => Promise<void> } = {}) {
  let issued = 0;
  const calls: Array<{ method: string; url: string; auth?: string }> = [];
  const logins: number[] = [];
  const transport: Transport = async (method, url, headers, data) => {
    if (url.endsWith('/api/v1/auth/login')) {
      if (opts.gate) await opts.gate();
      logins.push(clock.now());
      const status = opts.loginStatus?.() ?? 200;
      if (status !== 200) return { status, body: { message: 'Invalid credentials', echo: data } };
      const iat = Math.floor(clock.now() / 1000);
      return { status: 200, body: { accessToken: jwt({ sub: 'u', n: ++issued, iat, exp: iat + LIFETIME_S }) } };
    }
    calls.push({ method, url, auth: headers.Authorization });
    const bearer = headers.Authorization?.replace(/^Bearer /, '');
    if (!bearer || clock.now() / 1000 >= claimsOf(bearer).exp) {
      return { status: 401, body: { statusCode: 401, message: 'Invalid token', error: 'Unauthorized' } };
    }
    return { status: 200, body: { ok: true } };
  };
  return { transport, calls, logins };
}

const connect = (clock: Clock, transport: Transport, extra: { refreshMarginMs?: number } = {}) =>
  connectApiClient(
    { apiBaseUrl: 'http://api.test', email: EMAIL, password: PASSWORD, workspaceId: WS, forbiddenIds: [PAUL], now: clock.now, ...extra },
    transport,
  );

const INVALID_TOKEN: ApiResponse = { status: 401, body: { statusCode: 401, message: 'Invalid token', error: 'Unauthorized' } };

/** A scripted transport: answers in order, records the bearer each call carried. */
function scripted(...answers: ApiResponse[]) {
  const seen: Array<string | undefined> = [];
  const transport: Transport = async (_m, _u, headers) => {
    seen.push(headers.Authorization);
    return answers.shift() ?? { status: 200, body: {} };
  };
  return { transport, seen };
}

/** A login counter yielding opaque (non-JWT) tokens `tok-1`, `tok-2`, … */
function counter(prefix = 'tok') {
  let n = 0;
  const fn = async () => `${prefix}-${++n}`;
  return { login: fn, count: () => n };
}

const authed = (transport: Transport, auth: ReturnType<typeof createTokenProvider>) =>
  createApiClient({ apiBaseUrl: 'http://api.test', token: '', auth, workspaceId: WS, forbiddenIds: [PAUL] }, transport);

// ── lifetime ─────────────────────────────────────────────────────────────

test('UT-PRODE2E-6100: the token lifetime is read as exp − iat; a non-JWT or claim-less token has none', () => {
  assert.equal(tokenLifetimeMs(jwt({ iat: 100, exp: 1000 })), 900_000);
  assert.equal(tokenLifetimeMs('opaque-token'), null);
  assert.equal(tokenLifetimeMs(jwt({ exp: 1000 })), null);
  assert.equal(tokenLifetimeMs(jwt({ iat: 1000, exp: 1000 })), null);
  assert.equal(tokenLifetimeMs('a.!!!not-base64-json!!!.c'), null);
});

// ── proactive ────────────────────────────────────────────────────────────

test('UT-PRODE2E-6101: the token is renewed proactively at lifetime − margin, never earlier, with one login', async () => {
  const clock = new Clock();
  const t1 = jwt({ iat: 1, exp: 1 + LIFETIME_S });
  const { login, count } = counter();
  const auth = createTokenProvider({ login, initialToken: t1, now: clock.now });
  clock.advance(LIFETIME_S * 1000 - DEFAULT_REFRESH_MARGIN_MS - 1);
  assert.equal(await auth.current(), t1);
  assert.equal(count(), 0);
  clock.advance(1);
  assert.equal(await auth.current(), 'tok-1');
  assert.equal(await auth.current(), 'tok-1');
  assert.equal(count(), 1);
});

test('UT-PRODE2E-6102: the margin is capped at half a short lifetime, so a short token never means a login per request', async () => {
  const clock = new Clock();
  const { login, count } = counter();
  const auth = createTokenProvider({ login, initialToken: jwt({ iat: 0, exp: 60 }), refreshMarginMs: 10 * 60_000, now: clock.now });
  clock.advance(29_999);
  await auth.current();
  await auth.current();
  assert.equal(count(), 0);
  clock.advance(1);
  await auth.current();
  assert.equal(count(), 1);
});

test('UT-PRODE2E-6103: a token whose lifetime cannot be read is renewed only reactively', async () => {
  const clock = new Clock();
  const { login, count } = counter();
  const auth = createTokenProvider({ login, initialToken: 'opaque', now: clock.now });
  clock.advance(24 * 3600_000);
  assert.equal(await auth.current(), 'opaque');
  assert.equal(count(), 0);
  assert.equal(await auth.renew('opaque'), 'tok-1');
  assert.equal(count(), 1);
});

// ── reactive ─────────────────────────────────────────────────────────────

test('UT-PRODE2E-6104: a 401 "Invalid token" is retried exactly once with a freshly logged-in token', async () => {
  const { transport, seen } = scripted(INVALID_TOKEN, { status: 200, body: { id: 'x' } });
  const { login, count } = counter();
  const res = await authed(transport, createTokenProvider({ login, initialToken: 'stale' })).post('/api/v1/x', { a: 1 });
  assert.deepEqual(res, { status: 200, body: { id: 'x' } });
  assert.deepEqual(seen, ['Bearer stale', 'Bearer tok-1']);
  assert.equal(count(), 1);
});

test('UT-PRODE2E-6105: a second 401 after the re-login is returned as-is — one login, two sends, never a loop', async () => {
  const { transport, seen } = scripted(INVALID_TOKEN, INVALID_TOKEN, INVALID_TOKEN);
  const { login, count } = counter();
  const res = await authed(transport, createTokenProvider({ login, initialToken: 'stale' })).get('/api/v1/x');
  assert.equal(res.status, 401);
  assert.equal(seen.length, 2);
  assert.equal(count(), 1);
});

test('UT-PRODE2E-6106: only the expired-token refusal is retried — another 401, a 403 or a 404 surface untouched', async () => {
  assert.equal(isExpiredTokenRefusal(INVALID_TOKEN), true);
  assert.equal(isExpiredTokenRefusal({ status: 403, body: { message: 'Invalid token' } }), false);
  const others: ApiResponse[] = [
    { status: 401, body: { message: 'Invalid authorization header format' } },
    { status: 401, body: {} },
    { status: 403, body: { message: 'Forbidden' } },
    { status: 404, body: {} },
  ];
  for (const answer of others) {
    const { transport, seen } = scripted(answer);
    const { login, count } = counter();
    const res = await authed(transport, createTokenProvider({ login, initialToken: 'tok-0' })).get('/api/v1/x');
    assert.equal(res, answer);
    assert.equal(seen.length, 1);
    assert.equal(count(), 0, `no re-login on ${answer.status} ${JSON.stringify(answer.body)}`);
  }
});

// ── concurrency ──────────────────────────────────────────────────────────

test('UT-PRODE2E-6107: parallel requests refused on the same expired token share ONE re-login, each retried once', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { transport: base, seen } = scripted();
  const transport: Transport = async (m, u, h, d) => (h.Authorization === 'Bearer stale' ? (seen.push(h.Authorization), INVALID_TOKEN) : base(m, u, h, d));
  let logins = 0;
  const auth = createTokenProvider({ login: async () => { logins++; await gate; return 'fresh'; }, initialToken: 'stale' });
  const client = authed(transport, auth);
  const pending = Promise.all([1, 2, 3, 4, 5].map((i) => client.get(`/api/v1/x/${i}`)));
  await new Promise((r) => setImmediate(r));
  release();
  const results = await pending;
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(logins, 1);
  assert.equal(seen.filter((a) => a === 'Bearer stale').length, 5);
  assert.equal(seen.filter((a) => a === 'Bearer fresh').length, 5);
});

test('UT-PRODE2E-6108: parallel requests past the proactive deadline share ONE re-login', async () => {
  const clock = new Clock();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let logins = 0;
  const auth = createTokenProvider({
    login: async () => { logins++; await gate; return jwt({ n: logins, iat: 0, exp: LIFETIME_S }); },
    initialToken: jwt({ n: 0, iat: 0, exp: LIFETIME_S }),
    now: clock.now,
  });
  clock.advance(LIFETIME_S * 1000);
  const pending = Promise.all([auth.current(), auth.current(), auth.current(), auth.renew('whatever')]);
  release();
  const tokens = await pending;
  assert.equal(logins, 1);
  assert.equal(new Set(tokens).size, 1);
});

test('UT-PRODE2E-6109: a late 401 on a token another request already renewed reuses the new token — no second login', async () => {
  const { login, count } = counter();
  const auth = createTokenProvider({ login, initialToken: 'stale' });
  assert.equal(await auth.renew('stale'), 'tok-1');
  assert.equal(await auth.renew('stale'), 'tok-1');
  assert.equal(count(), 1);
  assert.equal(await auth.renew('tok-1'), 'tok-2');
});

// ── failure + secrecy ────────────────────────────────────────────────────

test('UT-PRODE2E-6110: a failed re-login rejects naming the status only (no token, no credential) and is not cached', async () => {
  const clock = new Clock();
  let status = 200;
  const gw = fakeGateway(clock, { loginStatus: () => status });
  const client = await connect(clock, gw.transport);
  const first = gw.calls.length;
  clock.advance(LIFETIME_S * 1000);
  status = 503;
  const err = await client.get('/api/v1/x').then(() => null, (e: Error) => e);
  assert.ok(err, 'the request must fail, never resolve as a pass');
  assert.match(err.message, /login failed -> HTTP 503/);
  for (const secret of [EMAIL, PASSWORD, 'Bearer', 'eyJ']) assert.equal(err.message.includes(secret), false, `error names ${secret}`);
  assert.equal(gw.calls.length, first, 'no request was sent with the expired token');
  status = 200;
  assert.equal((await client.get('/api/v1/x')).status, 200);
  assert.equal(gw.logins.length, 3);
});

test('UT-PRODE2E-6111: connecting with a bad credential fails at once (the suite aborts LOGIN_FAILED), before any request', async () => {
  const clock = new Clock();
  const gw = fakeGateway(clock, { loginStatus: () => 401 });
  await assert.rejects(connect(clock, gw.transport), (e: Error) => /login failed -> HTTP 401/.test(e.message) && !e.message.includes(PASSWORD));
  assert.equal(gw.calls.length, 0);
});

test('UT-PRODE2E-6112: the EC9 tripwire still refuses a forbidden reference before any login or send', async () => {
  const clock = new Clock();
  const gw = fakeGateway(clock);
  const client = await connect(clock, gw.transport);
  clock.advance(LIFETIME_S * 1000);
  await assert.rejects(client.get(`/api/v1/organizations/${PAUL}`), ForbiddenReferenceError);
  assert.equal(gw.logins.length, 1, 'the refused request did not trigger a renewal');
  assert.equal(gw.calls.length, 0);
});

test('UT-PRODE2E-6113: a 60-min run against a gateway enforcing the 15-min exp never sees a 401 (bug reproduction)', async () => {
  for (const marginMs of [DEFAULT_REFRESH_MARGIN_MS, 0]) {
    const clock = new Clock();
    const gw = fakeGateway(clock);
    const client = await connect(clock, gw.transport, { refreshMarginMs: marginMs });
    const statuses: number[] = [];
    for (let minute = 0; minute <= 60; minute++) {
      statuses.push((await client.get(`/api/v1/workspaces/${WS}/datasets`)).status);
      statuses.push((await client.post('/api/v1/x', { minute })).status);
      clock.advance(60_000);
    }
    assert.deepEqual(statuses.filter((s) => s !== 200), [], `margin ${marginMs}`);
    assert.ok(gw.logins.length >= 5 && gw.logins.length <= 6, `margin ${marginMs}: ${gw.logins.length} logins`);
  }
  // Control: the pre-AXI-2357 static-token client goes 401 after 15 min.
  const clock = new Clock();
  const gw = fakeGateway(clock);
  const token = (await gw.transport('POST', 'http://api.test/api/v1/auth/login', {}, {})).body.accessToken;
  const legacy = createApiClient({ apiBaseUrl: 'http://api.test', token, workspaceId: WS, forbiddenIds: [PAUL] }, gw.transport);
  clock.advance(LIFETIME_S * 1000);
  assert.equal((await legacy.get('/api/v1/x')).status, 401);
});

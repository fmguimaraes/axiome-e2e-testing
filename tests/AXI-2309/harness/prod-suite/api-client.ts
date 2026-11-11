/**
 * AXI-2318 (epic AXI-2309, FR28–FR33) — the one HTTP seam the prod E2E suite
 * talks through. Every harness module depends on {@link ApiClient}, never on
 * Playwright or `fetch` directly (DIP), so the same isolation guard, fixture
 * resolver and run-plan builder drive the Playwright daily spec, the
 * one-time provisioning CLI and the unit tests (with a fake).
 *
 * EC9 tripwire: every client carries a NON-EMPTY `forbiddenIds` list and
 * refuses — before the request leaves the process — any path, header or body
 * carrying one of those ids, so the suite can never even ASK for Paul's
 * CeRAINOM-IgG4 org. The list is required and an empty one is refused at
 * construction: a tripwire that can be built disarmed fails open.
 *
 * AXI-2357 (epic AXI-2358): the confined identity's access token lives 15 min
 * (user-service `jwt.expiresIn` = `JWT_EXPIRES_IN || '15m'`), the daily suite
 * up to 60 min. A client built with a {@link TokenProvider} (see
 * {@link connectApiClient}) re-logs in PROACTIVELY shortly before the token's
 * lifetime runs out, and REACTIVELY retries a request exactly once after a
 * 401 "Invalid token". A second 401 is returned as-is (a real failure, never
 * masked, never looped). Renewal is single-flight across parallel requests.
 * Tokens and credentials are never logged or put in an error message.
 */

export interface ApiResponse {
  status: number;
  body: any;
}

export interface ApiClient {
  get(path: string): Promise<ApiResponse>;
  post(path: string, data?: unknown): Promise<ApiResponse>;
  patch(path: string, data?: unknown): Promise<ApiResponse>;
  delete(path: string): Promise<ApiResponse>;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** The low-level transport an {@link ApiClient} is built on (fetch in prod, a fake in tests). */
export type Transport = (
  method: HttpMethod,
  url: string,
  headers: Record<string, string>,
  data?: unknown,
) => Promise<ApiResponse>;

export class ForbiddenReferenceError extends Error {
  readonly code = 'FORBIDDEN_ORG_REFERENCE';
}

export interface ClientOptions {
  apiBaseUrl: string;
  /** A fixed bearer token ('' = anonymous). Ignored when `auth` is given. */
  token: string;
  /** AXI-2357: a renewing token source — proactive refresh + one reactive retry on an expired token. */
  auth?: TokenProvider;
  workspaceId?: string;
  /** Required, non-empty: the org ids no request may name (EC9). */
  forbiddenIds: readonly string[];
}

/** Throw if `text` mentions any forbidden id (case-insensitive). */
export function assertNoForbiddenReference(text: string, forbiddenIds: readonly string[]): void {
  const haystack = text.toLowerCase();
  const hit = forbiddenIds.find((id) => id && haystack.includes(id.toLowerCase()));
  if (hit) {
    throw new ForbiddenReferenceError(
      'EC9: the prod suite attempted to reference a forbidden organization id — aborting the run',
    );
  }
}

function headersFor(token: string, workspaceId: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId;
  return headers;
}

/** Build an {@link ApiClient} over `transport`, with the EC9 tripwire on every call. */
export function createApiClient(opts: ClientOptions, transport: Transport): ApiClient {
  const forbiddenIds = (opts.forbiddenIds ?? []).map((id) => id.trim()).filter(Boolean);
  if (forbiddenIds.length === 0) {
    throw new Error('EC9: createApiClient needs a non-empty forbiddenIds list — refusing to build a disarmed client');
  }
  const base = opts.apiBaseUrl.replace(/\/+$/, '');
  const auth = opts.auth;
  const send = async (method: HttpMethod, path: string, data?: unknown): Promise<ApiResponse> => {
    const url = `${base}/${path.replace(/^\/+/, '')}`;
    assertNoForbiddenReference(`${url} ${JSON.stringify(opts.workspaceId ?? '')}`, forbiddenIds);
    if (data !== undefined) assertNoForbiddenReference(JSON.stringify(data), forbiddenIds);
    if (!auth) return transport(method, url, headersFor(opts.token, opts.workspaceId), data);
    const token = await auth.current();
    const res = await transport(method, url, headersFor(token, opts.workspaceId), data);
    if (!isExpiredTokenRefusal(res)) return res;
    // Exactly one retry with a renewed token; whatever it answers (a second 401
    // included) is what the caller sees — an authorization failure stays a failure.
    // Safe for POST/PATCH too: the gateway refuses an invalid token before proxying.
    const renewed = await auth.renew(token);
    return transport(method, url, headersFor(renewed, opts.workspaceId), data);
  };
  return {
    get: (path) => send('GET', path),
    post: (path, data) => send('POST', path, data),
    patch: (path, data) => send('PATCH', path, data),
    delete: (path) => send('DELETE', path),
  };
}

/**
 * True for the gateway's expired/invalid-token refusal (`401 {message: 'Invalid token'}`,
 * apps/gateway/src/guards/auth.guard.ts). Any other 401 — e.g. a malformed header —
 * is not a token-lifetime problem and is never retried.
 */
export function isExpiredTokenRefusal(res: ApiResponse): boolean {
  if (res.status !== 401) return false;
  const message = res.body?.message;
  return typeof message === 'string' && /^invalid token$/i.test(message.trim());
}

// ── AXI-2357: token renewal ─────────────────────────────────────────────────

/** A source of bearer tokens that renews them before (and once after) they expire. */
export interface TokenProvider {
  /** The token to send now — renewed first when it is within the refresh margin of its lifetime. */
  current(): Promise<string>;
  /**
   * Renew after `staleToken` was refused. If another request already renewed it,
   * the newer token is returned without a second login. Concurrent callers share
   * one in-flight login (single-flight).
   */
  renew(staleToken: string): Promise<string>;
}

export interface TokenProviderOptions {
  /** Performs a fresh login and returns the access token (e.g. {@link loginForToken}). */
  login: () => Promise<string>;
  /** A token already obtained by the caller (skips the first login). */
  initialToken?: string;
  /** Renew this long before the token's lifetime runs out (default 2 min). */
  refreshMarginMs?: number;
  /** Clock seam for tests (default `Date.now`). */
  now?: () => number;
}

/** Default proactive margin: 2 min ahead of a 15-min token — wide enough for a slow request. */
export const DEFAULT_REFRESH_MARGIN_MS = 2 * 60_000;

/**
 * The token's lifetime in ms (`exp − iat`, both server-issued, so runner/server
 * clock skew cancels out), or null when the token is not a JWT carrying both.
 * Reads the payload only — no signature check, nothing logged.
 */
export function tokenLifetimeMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const { exp, iat } = payload ?? {};
    if (typeof exp !== 'number' || typeof iat !== 'number' || !(exp > iat)) return null;
    return (exp - iat) * 1000;
  } catch {
    return null;
  }
}

/**
 * Build a {@link TokenProvider}. The refresh deadline is measured on the LOCAL
 * clock from when the token was received: `receivedAt + lifetime − margin`, the
 * margin capped at half the lifetime so a short-lived token can never cause a
 * login per request. A token whose lifetime cannot be read is only renewed
 * reactively. A failed login rejects (status only) and is not cached — the next
 * call tries again.
 */
export function createTokenProvider(opts: TokenProviderOptions): TokenProvider {
  const now = opts.now ?? Date.now;
  const margin = Math.max(0, opts.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS);
  let token: string | null = null;
  let refreshAt = Infinity;
  let inFlight: Promise<string> | null = null;

  const adopt = (fresh: string): string => {
    token = fresh;
    const lifetime = tokenLifetimeMs(fresh);
    refreshAt = lifetime === null ? Infinity : now() + lifetime - Math.min(margin, lifetime / 2);
    return fresh;
  };
  if (opts.initialToken) adopt(opts.initialToken);

  const relogin = (): Promise<string> => {
    if (!inFlight) {
      inFlight = opts.login().then(adopt).finally(() => { inFlight = null; });
    }
    return inFlight;
  };

  return {
    async current() {
      if (inFlight) return inFlight;
      if (token === null || now() >= refreshAt) return relogin();
      return token;
    },
    async renew(staleToken) {
      if (inFlight) return inFlight;
      if (token !== null && token !== staleToken) return token;
      return relogin();
    },
  };
}

export interface ConnectOptions {
  apiBaseUrl: string;
  email: string;
  password: string;
  workspaceId?: string;
  forbiddenIds: readonly string[];
  refreshMarginMs?: number;
  /** Clock seam for tests (default `Date.now`). */
  now?: () => number;
}

/**
 * Log in (failing fast, so a bad credential still aborts the run as LOGIN_FAILED)
 * and return a client that keeps its token fresh for a run of any length.
 */
export async function connectApiClient(opts: ConnectOptions, transport: Transport = fetchTransport): Promise<ApiClient> {
  const login = () => loginForToken(opts.apiBaseUrl, opts.email, opts.password, transport);
  const auth = createTokenProvider({ login, initialToken: await login(), refreshMarginMs: opts.refreshMarginMs, now: opts.now });
  return createApiClient(
    { apiBaseUrl: opts.apiBaseUrl, token: '', auth, workspaceId: opts.workspaceId, forbiddenIds: opts.forbiddenIds },
    transport,
  );
}

async function parseBody(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

/** The production transport: Node's global `fetch` (no new dependency). */
export const fetchTransport: Transport = async (method, url, headers, data) => {
  const init: RequestInit = { method, headers: { ...headers } };
  if (data !== undefined) {
    init.body = JSON.stringify(data);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  const res = await fetch(url, init);
  return { status: res.status, body: await parseBody(res) };
};

/** Log in over the API and return the access token; a failed login throws with the status only. */
export async function loginForToken(
  apiBaseUrl: string,
  email: string,
  password: string,
  transport: Transport = fetchTransport,
): Promise<string> {
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/api/v1/auth/login`;
  const res = await transport('POST', url, {}, { email, password });
  const token = res.body?.accessToken;
  if (res.status >= 300 || typeof token !== 'string') {
    throw new Error(`prod suite login failed -> HTTP ${res.status}`);
  }
  return token;
}

/** Return `res.body`, or throw naming `what` and the status (never the body — it may echo data). */
export function okBody(res: ApiResponse, what: string): any {
  if (res.status < 200 || res.status >= 300) throw new Error(`${what} -> HTTP ${res.status}`);
  return res.body;
}

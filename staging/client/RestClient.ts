import { assertAllowListed, readAllowList } from '../config/allowlist';
import { TokenPool } from './TokenPool';
import type { HttpMethod, IdentityKey, RestCallLog, RestClientOptions } from './types';

export interface RestResult<T = unknown> {
  status: number;
  ok: boolean;
  body: T | undefined;
  raw: string;
}

/**
 * REST-only client (NFR3): the single seam every staging step and the audit
 * probe use to reach the gateway. No Prisma client, no amqplib, no pg, no
 * seed script import anywhere in this class or anything it depends on — see
 * `staging/checks/noBackdoor.ts`, which greps for exactly that.
 *
 * Refuses to construct against a non-allow-listed base URL (NFR2/EC10) — the
 * guard runs once, at construction, so a client that exists at all is already
 * proven safe to call.
 */
export class RestClient {
  private readonly baseUrl: string;
  private readonly onCall: (log: RestCallLog) => void;
  readonly tokens = new TokenPool();

  constructor(opts: RestClientOptions) {
    const allowList = opts.allowList ?? readAllowList();
    assertAllowListed(opts.baseUrl, allowList);
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.onCall = opts.onCall ?? defaultLogSink;
  }

  /** Authenticate `identity` via the real login route and store its token in the pool (FR2/FR3). */
  async login(identity: IdentityKey, email: string, password: string): Promise<void> {
    const res = await this.call('POST', '/api/v1/auth/login', { identity: 'anonymous', body: { email, password } });
    if (!res.ok || !res.body) {
      throw new Error(`login failed for identity "${identity}" (status ${res.status})`);
    }
    const { accessToken, refreshToken } = res.body as { accessToken: string; refreshToken?: string };
    this.tokens.set(identity, { accessToken, refreshToken });
  }

  /** Authenticated call as `identity` — throws if that identity has no token yet. */
  async as<T = unknown>(identity: IdentityKey, method: HttpMethod, path: string, body?: unknown): Promise<RestResult<T>> {
    if (!this.tokens.has(identity)) {
      throw new Error(`no token for identity "${identity}" — call login() first`);
    }
    return this.call<T>(method, path, { identity, body });
  }

  /**
   * Unauthenticated (or deliberately-authenticated) call for route-existence
   * probing — a MISSING route 404s; an EXISTING one answers 401/403/400 for a
   * bad/absent token. Never throws on a non-2xx status; that status IS the signal.
   */
  async probe(method: HttpMethod, path: string, identity: IdentityKey = 'anonymous'): Promise<RestResult> {
    return this.call(method, path, { identity, body: undefined });
  }

  private async call<T>(method: HttpMethod, path: string, opts: { identity: IdentityKey; body?: unknown }): Promise<RestResult<T>> {
    const headers = this.headersFor(opts.identity);
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    this.logCall(method, path, res.status, opts.identity);
    return toResult<T>(res);
  }

  private headersFor(identity: IdentityKey): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const tokens = identity === 'anonymous' ? undefined : this.tokens.get(identity);
    if (tokens) {
      headers.authorization = `Bearer ${tokens.accessToken}`;
    }
    return headers;
  }

  private logCall(method: HttpMethod, path: string, status: number, identity: IdentityKey): void {
    this.onCall({ method, path, status, identity, at: new Date().toISOString() });
  }
}

async function toResult<T>(res: Response): Promise<RestResult<T>> {
  const raw = await res.text();
  const body = parseJsonSafely<T>(raw);
  return { status: res.status, ok: res.ok, body, raw };
}

function parseJsonSafely<T>(raw: string): T | undefined {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Default log sink (NFR7): route + identity only — never a token, header, or body. */
function defaultLogSink(log: RestCallLog): void {
  console.log(`[staging] ${log.at} ${log.method} ${log.path} -> ${log.status} (as ${log.identity})`);
}

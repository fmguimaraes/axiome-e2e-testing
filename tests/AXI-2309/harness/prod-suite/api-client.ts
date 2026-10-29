/**
 * AXI-2318 (epic AXI-2309, FR28–FR33) — the one HTTP seam the prod E2E suite
 * talks through. Every harness module depends on {@link ApiClient}, never on
 * Playwright or `fetch` directly (DIP), so the same isolation guard, fixture
 * resolver and run-plan builder drive the Playwright daily spec, the
 * one-time provisioning CLI and the unit tests (with a fake).
 *
 * EC9 tripwire: a client built with `forbiddenIds` refuses — before the request
 * leaves the process — any path or header carrying one of those ids, so the
 * suite can never even ASK for Paul's CeRAINOM-IgG4 org.
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
  token: string;
  workspaceId?: string;
  forbiddenIds?: readonly string[];
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

function headersFor(opts: ClientOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.workspaceId) headers['X-Workspace-Id'] = opts.workspaceId;
  return headers;
}

/** Build an {@link ApiClient} over `transport`, with the EC9 tripwire on every call. */
export function createApiClient(opts: ClientOptions, transport: Transport): ApiClient {
  const base = opts.apiBaseUrl.replace(/\/+$/, '');
  const headers = headersFor(opts);
  const send = async (method: HttpMethod, path: string, data?: unknown): Promise<ApiResponse> => {
    const url = `${base}/${path.replace(/^\/+/, '')}`;
    assertNoForbiddenReference(`${url} ${JSON.stringify(headers['X-Workspace-Id'] ?? '')}`, opts.forbiddenIds ?? []);
    if (data !== undefined) assertNoForbiddenReference(JSON.stringify(data), opts.forbiddenIds ?? []);
    return transport(method, url, headers, data);
  };
  return {
    get: (path) => send('GET', path),
    post: (path, data) => send('POST', path, data),
    patch: (path, data) => send('PATCH', path, data),
    delete: (path) => send('DELETE', path),
  };
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

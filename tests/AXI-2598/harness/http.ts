/**
 * AXI-2601 (epic AXI-2598 — FR2, FR4, FR32, NFR4) — the one HTTP seam of the handover suite.
 *
 * Reuses the prod-suite's token renewal (`createTokenProvider`, `loginForToken`) and its EC9
 * tripwire primitive (`assertNoForbiddenReference`) rather than forking them; it differs from the
 * prod-suite `ApiClient` in two ways the handover path needs:
 *  - downloads are read as BYTES (reports, figures, PDFs), never truncated to a 500-char excerpt;
 *  - the tripwire list may be empty: on a fresh confined workspace no pre-existing project exists.
 *    The handover suite puts every PRE-EXISTING project id of the workspace in it (FR32): a request
 *    that names one of them is refused before it leaves the process.
 *
 * Tokens are never logged and never put in an error message or a report (NFR4).
 */
import {
  assertNoForbiddenReference,
  createTokenProvider,
  loginForToken,
  type ApiClient,
  type ApiResponse,
  type TokenProvider,
} from '../../AXI-2309/harness/prod-suite/api-client';

export interface Download {
  status: number;
  contentType: string;
  filename: string | null;
  bytes: Buffer;
  headers: Record<string, string>;
}

export interface HandoverClient extends ApiClient {
  readonly label: string;
  put(path: string, data?: unknown): Promise<ApiResponse>;
  download(path: string): Promise<Download>;
  /** Add ids no later request may name (pre-existing projects, forbidden orgs). */
  forbid(ids: readonly string[]): void;
}

export class UnreachableEnvironmentError extends Error {
  readonly code = 'ENVIRONMENT_UNREACHABLE';
}

export interface ConnectHandoverOptions {
  label: string;
  apiBaseUrl: string;
  email: string;
  password: string;
  workspaceId: string;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function filenameOf(disposition: string | null): string | null {
  const m = disposition?.match(/filename="?([^";]+)"?/i);
  return m ? m[1] : null;
}

async function fetchOrUnreachable(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    // EC13 — a stopped environment fails at the first call with a plain cause, not an assertion.
    throw new UnreachableEnvironmentError(`environment unreachable: ${new URL(url).origin} (${(err as Error).message})`);
  }
}

function parseJson(text: string): any {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2_000) };
  }
}

/** Log in (fail fast) and return a renewing client scoped to `workspaceId`. */
export async function connectHandoverClient(opts: ConnectHandoverOptions): Promise<HandoverClient> {
  const base = opts.apiBaseUrl.replace(/\/+$/, '');
  const login = async () => {
    try {
      return await loginForToken(base, opts.email, opts.password);
    } catch (err) {
      if (err instanceof TypeError) throw new UnreachableEnvironmentError(`environment unreachable: ${base}`);
      throw new Error(`${opts.label} login failed (${(err as Error).message.replace(/^prod suite /, '')})`);
    }
  };
  const auth: TokenProvider = createTokenProvider({ login, initialToken: await login() });
  const forbidden: string[] = [];

  const raw = async (method: Method, path: string, data?: unknown): Promise<Response> => {
    const url = `${base}/${path.replace(/^\/+/, '')}`;
    if (forbidden.length > 0) {
      assertNoForbiddenReference(url, forbidden);
      if (data !== undefined) assertNoForbiddenReference(JSON.stringify(data), forbidden);
    }
    const send = async (token: string) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'X-Workspace-Id': opts.workspaceId };
      const init: RequestInit = { method, headers };
      if (data !== undefined) {
        init.body = JSON.stringify(data);
        headers['content-type'] = 'application/json';
      }
      return fetchOrUnreachable(url, init);
    };
    const token = await auth.current();
    const res = await send(token);
    if (res.status !== 401) return res;
    const body = parseJson(await res.clone().text());
    if (!(typeof body?.message === 'string' && /^invalid token$/i.test(body.message.trim()))) return res;
    return send(await auth.renew(token));
  };

  const json = async (method: Method, path: string, data?: unknown): Promise<ApiResponse> => {
    const res = await raw(method, path, data);
    return { status: res.status, body: parseJson(await res.text()) };
  };

  return {
    label: opts.label,
    get: (p) => json('GET', p),
    post: (p, d) => json('POST', p, d),
    put: (p, d) => json('PUT', p, d),
    patch: (p, d) => json('PATCH', p, d),
    delete: (p) => json('DELETE', p),
    async download(p) {
      const res = await raw('GET', p);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        filename: filenameOf(res.headers.get('content-disposition')),
        bytes: Buffer.from(await res.arrayBuffer()),
        headers,
      };
    },
    forbid(ids) {
      for (const id of ids) if (id && !forbidden.includes(id)) forbidden.push(id);
    },
  };
}

/** A short, token-free excerpt of a response body for a defect record. */
export function excerpt(body: unknown, max = 600): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return (text ?? '').length > max ? `${text.slice(0, max)}…` : text ?? '';
}

/**
 * Shared types for the REST client + identity-keyed token pool (AXI-1369
 * design note: "identity-keyed token pool from the start").
 *
 * Full cast/service-account provisioning arrives in AXI-1370; this story only
 * needs the *shape* to hold multiple identities so later stories never
 * retrofit it (dev-epic-context: "retrofitting it after the comment story is
 * written is the expensive path").
 */

/** An identity is any string key the caller chooses — a role name, a cast
 *  member's slug, "admin", "service-account", etc. The pool does not care. */
export type IdentityKey = string;

export interface IdentityTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms the access token expires, when known — informational only in this story. */
  expiresAt?: number;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** One structured log line per REST call (NFR7): route + identity, never a secret. */
export interface RestCallLog {
  method: HttpMethod;
  path: string;
  status: number;
  identity: IdentityKey | 'anonymous';
  at: string;
}

export interface RestClientOptions {
  baseUrl: string;
  allowList?: string[];
  /** Injected sink for {@link RestCallLog} lines (DIP) — defaults to console. */
  onCall?: (log: RestCallLog) => void;
}

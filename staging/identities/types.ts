import type { IdentityKey } from '../client/types';

/**
 * The auth-harness identity types (AXI-1370, FR1-FR4).
 *
 * `IdentityHandle` is the same string-keyed shape `TokenPool` already uses
 * (`IdentityKey`, AXI-1369) — the registry below just gives a fixed, named
 * set of those keys instead of leaving them ad hoc per caller.
 */
export type IdentityHandle = IdentityKey;

/** What role an identity plays in the staged tenant (Capture Spec §3/§12). */
export type IdentityRole = 'service-account' | 'cast' | 'external-stakeholder';

/**
 * A registry entry — WHO an identity is (email/name/role), never HOW to
 * authenticate as it. Deliberately has no `password` field: FR4/NFR5 require
 * credentials to live only in env or a gitignored local store, never in a
 * fixture or registry that could be committed by accident.
 */
export interface IdentityDefinition {
  handle: IdentityHandle;
  email: string;
  firstName: string;
  lastName: string;
  role: IdentityRole;
}

export interface EnsureIdentitiesResult {
  identities: IdentityHandle[];
  created: IdentityHandle[];
  reused: IdentityHandle[];
  serviceRoleId: string;
}

export interface IdentitySmokeResult {
  handle: IdentityHandle;
  ok: boolean;
  status: number;
  observedEmail?: string;
}

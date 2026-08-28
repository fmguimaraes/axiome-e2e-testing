import type { IdentityKey, IdentityTokens } from './types';

/**
 * Identity-keyed token pool (AXI-1369 design note).
 *
 * Holds one bearer token per identity so content created later (cast
 * accounts, the external stakeholder — AXI-1370+) is authored while
 * authenticated as the real actor, never via a display-name override (FR3).
 * Deliberately has no concept of "the current identity" — every caller is
 * required to name the identity it acts as, so authorship is never implicit.
 */
export class TokenPool {
  private readonly tokens = new Map<IdentityKey, IdentityTokens>();

  set(identity: IdentityKey, tokens: IdentityTokens): void {
    this.tokens.set(identity, tokens);
  }

  get(identity: IdentityKey): IdentityTokens | undefined {
    return this.tokens.get(identity);
  }

  has(identity: IdentityKey): boolean {
    return this.tokens.has(identity);
  }

  /** Identities currently holding a token — for diagnostics/logging only, never their tokens. */
  identities(): IdentityKey[] {
    return [...this.tokens.keys()];
  }

  clear(): void {
    this.tokens.clear();
  }
}

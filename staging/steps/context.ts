import type { RestClient } from '../client/RestClient';
import type { TenantFixture } from '../fixtures/types';

/** One entity the provisioning run created, reused or renamed — the record
 *  AC4's `findForbiddenNames` checks, and what the story report cites. */
export interface TouchedEntity {
  kind:
    | 'organization'
    | 'workspace'
    | 'project'
    | 'dataset'
    | 'membership'
    | 'analysis'
    | 'assumption'
    | 'chart'
    | 'dashboard'
    | 'comment'
    | 'client-exploration'
    | 'threshold'
    | 'annotation'
    | 'snapshot'
    | 'evidence'
    | 'interpretation'
    | 'published-version'
    | 'external-scoping-verification'
    | 'passport'
    | 'attestation'
    | 'logo'
    | 'sponsor-export'
    | 'governance-events-verification';
  name: string;
  id: string;
  action: 'created' | 'reused' | 'renamed' | 'retired' | 'linked' | 'granted' | 'withheld' | 'resolved' | 'superseded';
}

/**
 * Shared state threaded through the step graph. `ADMIN_HANDLE`/`SERVICE_HANDLE`
 * are the same identity strings AXI-1370's `ensureIdentities()` logs in under
 * — this module doesn't re-authenticate, it reuses `client`'s existing token
 * pool (the caller runs `ensureIdentities()` before building this context).
 */
export const ADMIN_HANDLE = 'admin';
export const SERVICE_HANDLE = 'service';

export interface ProvisioningContext {
  client: RestClient;
  fixture: TenantFixture;
  serviceUserId: string;
  orgId?: string;
  workspaceIdByFixtureName: Map<string, string>;
  touched: TouchedEntity[];
}

export function recordTouched(ctx: ProvisioningContext, entry: TouchedEntity): void {
  ctx.touched.push(entry);
}

/**
 * AXI-2601 (epic AXI-2598 — FR4, FR8, FR32, NFR8) — who acts where.
 *
 * Two identities, both named in the report:
 *  - the INVESTIGATOR identity (role `…0105`) — every client-path step: protocol, plan,
 *    finalise, upload, mapping, run, results, downloads, review, sign-off, cleanup (NFR8);
 *  - the PROVISIONING identity (`HANDOVER_PROVISIONER_*`) — only creating the project. An
 *    Investigator cannot (`InvestigatorDenyGuard` on `POST /projects`, AXI-2322), so this is the
 *    one step outside his rights. Optional at configuration: without it the step is BLOCKED.
 *
 * The prod isolation guard (`verifyIsolation`, AXI-2318) runs before any write whenever a
 * forbidden-org list is configured (FR8); a NON-local target without that list is refused before
 * sign-in (fail closed, `isLocalTarget`). Every project visible in the workspace before the run is
 * put on both clients' request tripwire (FR32): no request of this run can name one.
 */
import { verifyIsolation } from '../../AXI-2309/harness/prod-suite/isolation-guard';
import { isLocalTarget, type HandoverConfig } from './config';
import { connectHandoverClient, excerpt, type HandoverClient } from './http';

export const INVESTIGATOR_WORKSPACE_ROLE_ID = '00000000-0000-0000-0000-000000000105';

export interface World {
  workspaceId: string;
  organizationId: string;
  investigator: HandoverClient;
  investigatorUserId: string;
  investigatorEmail: string;
  /** Null when no provisioning identity is configured (the provisioning step is then blocked). */
  provisioner: HandoverClient | null;
  /** Projects visible before the run — never named by any request of this run (FR32). */
  preExistingProjectIds: string[];
  /** Human-readable facts for the report (no secrets). */
  notes: string[];
}

export function ok(res: { status: number; body: any }, what: string, expected: number[] = [200, 201]): any {
  if (!expected.includes(res.status)) throw new Error(`${what} -> HTTP ${res.status}: ${excerpt(res.body, 400)}`);
  return res.body;
}

export async function listAllProjects(c: HandoverClient): Promise<Array<{ id: string; name: string }>> {
  const rows: Array<{ id: string; name: string }> = [];
  for (let page = 1; page <= 50; page++) {
    const body = ok(await c.get(`/api/v1/projects?page=${page}&limit=100`), 'list projects');
    const data: any[] = Array.isArray(body?.data) ? body.data : [];
    rows.push(...data.map((r) => ({ id: String(r.id), name: String(r.name ?? '') })));
    if (!body?.meta?.hasNextPage || data.length === 0) break;
  }
  return rows;
}

export async function setUpWorld(cfg: HandoverConfig): Promise<World> {
  const notes: string[] = [];
  // FR8: fail closed — a non-local target without a forbidden-org list never signs in, let alone writes.
  if (cfg.forbiddenOrgIds.length === 0 && !isLocalTarget(cfg.apiBaseUrl)) {
    throw new Error(`FR8: target ${cfg.apiBaseUrl} is not local and no forbidden-org list is configured — refusing to run without the isolation guard`);
  }
  const investigator = await connectHandoverClient({ label: 'investigator', apiBaseUrl: cfg.apiBaseUrl, ...cfg.investigator, workspaceId: cfg.workspaceId });
  const ws = ok(await investigator.get(`/api/v1/workspaces/${cfg.workspaceId}`), 'read workspace');
  const organizationId = String(ws.ownerOrganizationId);
  if (cfg.forbiddenOrgIds.length > 0) {
    await verifyIsolation(investigator, { organizationId, workspaceId: cfg.workspaceId, forbiddenOrgIds: cfg.forbiddenOrgIds });
    notes.push('isolation guard (verifyIsolation, AXI-2318) passed before any write');
  } else {
    notes.push('isolation guard not run: no forbidden-org list configured (local target — FR8 applies to prod)');
  }
  const preExistingProjectIds = (await listAllProjects(investigator)).map((p) => p.id);
  investigator.forbid(preExistingProjectIds);
  const me = ok(await investigator.get('/api/v1/auth/me'), 'investigator me');
  let provisioner: HandoverClient | null = null;
  if (cfg.provisioner) {
    provisioner = await connectHandoverClient({ label: 'provisioner', apiBaseUrl: cfg.apiBaseUrl, ...cfg.provisioner, workspaceId: cfg.workspaceId });
    provisioner.forbid(preExistingProjectIds);
    notes.push(`provisioning identity: ${cfg.provisioner.email} (project creation only)`);
  } else {
    notes.push('provisioning identity: NOT CONFIGURED (HANDOVER_PROVISIONER_EMAIL / _PASSWORD) — project creation is blocked');
  }
  notes.push(`investigator identity: ${cfg.investigator.email}; ${preExistingProjectIds.length} pre-existing project(s) on the request tripwire`);
  return {
    workspaceId: cfg.workspaceId,
    organizationId,
    investigator,
    investigatorUserId: String(me.id),
    investigatorEmail: cfg.investigator.email,
    provisioner,
    preExistingProjectIds,
    notes,
  };
}

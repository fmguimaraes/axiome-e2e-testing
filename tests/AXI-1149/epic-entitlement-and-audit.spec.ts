import { test, expect } from './harness/rbac';
import { expectIndistinguishableFromMiss, expectStatus } from './harness/assertions';
import { API, randomUuid, wsHeader, type Principal } from './harness/tenancy';
import type { Rbac } from './harness/rbac';

/**
 * AXI-1149 — Workflow 5 API-level probes: entitlement dual-source (AXI-1143,
 * §5.20 AC27), the non-spoofable audit actor (AXI-1289, §5.21 AC29 AC30 AC31)
 * and the revoked-system-rule read hiding (AXI-1317, §5.22 AC33 + AC34).
 *
 * Not automated here:
 *  - AC28 (citation of a revoked run): `createCitationEdge` is a message-only
 *    RPC (`rule_run.create_citation_edge`); NO gateway HTTP route reaches it, so
 *    it cannot be driven through the public API.
 *  - AC27's *execute* half: a department-only user has, by definition, no
 *    WorkspaceMember row, and `POST /rule-runs` refuses with 403 "Not a member of
 *    this workspace" before rule entitlement is ever consulted — there is no
 *    referent such a user may run over. The LIST half (the entitlement org set
 *    is dual-source) is asserted below.
 *  - AC29's actor names `requestedBy` / comment `authorId`, and AC32
 *    (`exportedBy` authorization): they need a client-exploration recompute /
 *    comment / export over a real published artifact plus client-member
 *    permissions for two principals — a multi-actor artifact fixture this
 *    suite does not build. `invitedBy`, `revokedBy`, `publishedBy`,
 *    `assignedBy` and `performedBy` (three writes) ARE covered.
 */
test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const sysList = async (rbac: Rbac, who: Principal, qs: string) => {
  const body = await expectStatus(await who.ctx.get(`${API}/rules?scope=system&${qs}`, { headers: rbac.h }), 200);
  return { ids: (body.data as { id: string }[]).map((r) => r.id), total: body.meta.total as number };
};

test.describe('AXI-1149 entitlement dual-source and revoked-run hiding (AXI-1143, AXI-1317)', () => {
  test('AC27 §5.20 — a department-only user (no WorkspaceMember row) is governed by the org grant: listed when ALL, omitted when NONE', async ({ rbac }) => {
    const { uDan, uShared, RULE_SYS } = rbac;
    const ws = await expectStatus(await uDan.ctx.get(`${API}/workspaces`), 200);
    expect(ws.data, 'precondition: Dan has no workspace membership at all').toEqual([]);
    try {
      await rbac.setMode('ALL');
      const on = await sysList(rbac, uDan, 'search=IMM-QC-01&limit=100');
      expect(on.ids, 'entitled: the system rule appears for a department-only user').toContain(RULE_SYS);
      await rbac.setMode('NONE');
      const off = await sysList(rbac, uDan, 'limit=100');
      expect(off.ids).not.toContain(RULE_SYS);
      expect(off.total, 'NONE: the org grant is not inert for a department-only user — nothing is listed').toBe(0);
      // the workspace-member counterpart is governed identically (dual-source is a union)
      expect((await sysList(rbac, uShared, 'limit=100')).total).toBe(0);
    } finally {
      await rbac.setMode('ALL');
    }
  });

  test('AC33 §5.22 — the by-id stratify summary is hidden after revocation, byte-identical to a miss, row retained, writes unaffected', async ({ rbac }) => {
    const { uShared, radm } = rbac;
    await rbac.setMode('ALL');
    const STRAT_RUN = await rbac.stratRun();
    const summary = await expectStatus(await uShared.ctx.get(`${API}/rule-runs/${STRAT_RUN}/summary`, { headers: rbac.h }), 200);
    expect(summary.groups.length, 'entitled: the summary index carries the group names + counts').toBeGreaterThanOrEqual(2);
    const nodeId = summary.groups[0].nodeId as string;
    try {
      await rbac.setMode('NONE');
      await expectIndistinguishableFromMiss(STRAT_RUN, (id) => uShared.ctx.get(`${API}/rule-runs/${id}/summary`, { headers: rbac.h }));
      // append-only: the row is retained, and a platform ADMIN is never subject to the hiding filter
      await expectStatus(await radm.ctx.get(`${API}/rule-runs/${STRAT_RUN}`), 200);
      const adminSummary = await expectStatus(await radm.ctx.get(`${API}/rule-runs/${STRAT_RUN}/summary`), 200);
      expect(adminSummary.ruleRunId).toBe(STRAT_RUN);
      // a legitimate WRITE by the same caller is not turned into a NotFound by the read-hiding change
      const stale = await uShared.ctx.post(`${API}/rule-runs/${STRAT_RUN}/outputs/stale`, {
        data: { nodeId, reason: 'AXI-1149 AC33 write-path control' }, headers: rbac.h,
      });
      expect(stale.status(), `markOutputStale must not be hidden: ${await stale.text()}`).toBe(200);
    } finally {
      await rbac.setMode('ALL');
    }
    await expectStatus(await uShared.ctx.get(`${API}/rule-runs/${STRAT_RUN}/summary`, { headers: rbac.h }), 200);
  });

  test('AC34 §5.22 — the selectable-group-nodes picker drops group nodes of a revoked system rule', async ({ rbac }) => {
    // AXI-1149 validation debt fix = axiome-back commit 62fb9017 ("Hide revoked system-rule group
    // nodes from the stratify referent picker"). It exists only on the back worktree; the demo stack
    // serves a primary checkout without commit 62fb9017, which lacks it, so the picker still leaks the group
    // nodes there. Expected-fail (assertions unchanged) until the stack serves 62fb9017 — Playwright
    // then reports "expected to fail but passed", which is the signal to drop this line.
    test.fail(true, 'stack serves an axiome-back checkout without commit 62fb9017 (selectable-group-nodes read-hiding)');
    const { uShared, RULE_STRAT } = rbac;
    await rbac.setMode('ALL');
    const STRAT_RUN = await rbac.stratRun();
    const pick = async () => {
      const rows = await expectStatus(await uShared.ctx.get(`${API}/rule-runs/selectable-group-nodes?workspaceId=${rbac.WS_R}`, { headers: rbac.h }), 200);
      return (rows as { ruleRunId: string; ruleId: string }[]).filter((n) => n.ruleRunId === STRAT_RUN);
    };
    expect((await pick()).length, 'entitled: both group nodes are selectable').toBeGreaterThanOrEqual(2);
    try {
      await rbac.setMode('NONE');
      const hidden = await pick();
      expect(hidden.map((n) => n.ruleId), 'revoked: no group node of the revoked STRATIFY-01 remains selectable').not.toContain(RULE_STRAT);
      expect(hidden).toEqual([]);
    } finally {
      await rbac.setMode('ALL');
    }
  });
});

test.describe('AXI-1149 the audit actor is non-spoofable (AXI-1289)', () => {
  test('AC29 §5.21 — a client-supplied performedBy / invitedBy / revokedBy / publishedBy / assignedBy never becomes the actor', async ({ rbac, topo }) => {
    const { alice, bob, WS_A, ORG_A } = topo;
    const h = wsHeader(WS_A);
    const mkProject = async (n: string) =>
      (await expectStatus(await alice.ctx.post(`${API}/projects`, { data: { name: `AXI1149 spoof ${n} ${Date.now()}`, workspaceId: WS_A }, headers: h }), 201)).id as string;

    // performedBy on a query string: archive, then delete
    const archived = await mkProject('arch');
    await expectStatus(await alice.ctx.patch(`${API}/projects/${archived}/archive?performedBy=${bob.id}`, { data: {}, headers: h }), 200);
    const deleted = await mkProject('del');
    const del = await alice.ctx.delete(`${API}/projects/${deleted}?performedBy=${bob.id}`, { headers: h });
    expect([200, 204], 'the forged write still succeeds (attribution hardening, not a refusal)').toContain(del.status());
    const projAudit = await expectStatus(await alice.ctx.get(`${API}/projects/${archived}/audit-logs`, { headers: h }), 200);
    const archiveRow = (projAudit as { action: string; performedBy: string }[]).find((r) => /archiv/i.test(r.action));
    expect(archiveRow, `an archive audit row exists: ${JSON.stringify(projAudit).slice(0, 300)}`).toBeTruthy();
    expect(archiveRow!.performedBy).toBe(alice.id);
    expect((projAudit as { performedBy: string }[]).some((r) => r.performedBy === bob.id)).toBe(false);

    // performedBy in a body: workspace member role change
    const target = await topo.spare('spoofed', { ws: WS_A, org: ORG_A, role: 'editor' });
    await expectStatus(
      await alice.ctx.patch(`${API}/workspaces/${WS_A}/members/${target.id}/role`, { data: { role: 'viewer', performedBy: bob.id }, headers: h }), 200);
    const wsAudit = (await expectStatus(await alice.ctx.get(`${API}/workspaces/${WS_A}/audit-logs`, { headers: h }), 200)) as { action: string; performedBy: string; changes: unknown }[];
    const roleRows = wsAudit.filter((r) => r.action === 'role_changed' && JSON.stringify(r.changes).includes(target.id));
    expect(roleRows.length, 'a role_changed row for the target exists').toBeGreaterThan(0);
    expect(roleRows.every((r) => r.performedBy === alice.id)).toBe(true);
    expect(wsAudit.some((r) => r.performedBy === bob.id), 'no workspace audit row is attributed to the forged actor').toBe(false);

    // assignedBy: department user assignment
    // minted by the throwaway admin: a user created by the seed admin is auto-placed in ORG_A already (creator org),
    // which would turn this POST into a no-op that returns the pre-existing row.
    const dept = await rbac.mkUser('deptuser');
    const assigned = await expectStatus(
      await alice.ctx.post(`${API}/organizations/${ORG_A}/department-users`, { data: { userId: dept.id, assignedBy: bob.id }, headers: h }), 201);
    expect(assigned.assignedBy).toBe(alice.id);

    // client-exploration: invitedBy, revokedBy, publishedBy
    const ce = `${API}/projects/${archived}/client-exploration`;
    await expectStatus(await alice.ctx.post(`${ce}/enable`, { data: {}, headers: h }), 201);
    const client = await topo.spare('ceclient');
    const perms = { canView: true, canComment: true, canCompare: true, canSaveDerived: false, canRequestRecompute: true, canExport: true };
    const invited = await expectStatus(await alice.ctx.post(`${ce}/members`, { data: { clientUserId: client.id, permissions: perms, invitedBy: bob.id }, headers: h }), 201);
    expect(invited.invitedBy).toBe(alice.id);
    const revoked = await expectStatus(await alice.ctx.delete(`${ce}/members/${client.id}?revokedBy=${bob.id}`, { headers: h }), 200);
    expect(revoked.revokedBy).toBe(alice.id);
    const published = await expectStatus(
      await alice.ctx.post(`${ce}/published-artifacts`, {
        data: { artifacts: [{ artifactId: randomUuid(), artifactType: 'view_analysis' }], publishedBy: bob.id }, headers: h,
      }), 201);
    expect((published as { publishedBy: string }[]).every((p) => p.publishedBy === alice.id)).toBe(true);
    const ceAudit = await expectStatus(await alice.ctx.get(`${ce}/audit-logs`, { headers: h }), 200);
    expect((ceAudit.logs as { performedBy: string }[]).length).toBeGreaterThan(0);
    expect((ceAudit.logs as { performedBy: string }[]).every((l) => l.performedBy === alice.id), 'every client-exploration audit row is Alice').toBe(true);
  });

  test('AC30 §5.21 — an admin cannot forge the actor either: mismatched userId is 403, a valid write is attributed to the admin and may target any tenant scope', async ({ rbac, topo }) => {
    const { radm } = rbac;
    const { alice, WS_B } = topo;
    const action = `axi1149.ac30.${Date.now()}`;
    const forged = await radm.ctx.post(`${API}/audit-logs`, { data: { action, resource: 'r', resourceId: '1', userId: alice.id, workspaceId: WS_B } });
    expect(forged.status(), await forged.text()).toBe(403);
    expect(await forged.text()).toContain('Cannot attribute an audit log to another user');

    const own = await expectStatus(await radm.ctx.post(`${API}/audit-logs`, { data: { action, resource: 'r', resourceId: '1', workspaceId: WS_B } }), 201);
    expect(own.userId, 'the stored actor is the admin itself').toBe(radm.id);
    expect(own.workspaceId, 'the admin may still choose the tenant SCOPE').toBe(WS_B);
    const explicit = await expectStatus(await radm.ctx.post(`${API}/audit-logs`, { data: { action, resource: 'r', resourceId: '2', userId: radm.id, workspaceId: WS_B } }), 201);
    expect(explicit.userId).toBe(radm.id);

    const back = await expectStatus(await radm.ctx.get(`${API}/audit-logs?workspaceId=${WS_B}&action=${action}&limit=50`), 200);
    const rows = back.logs as { userId: string }[];
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.userId === radm.id), 'no row carries the forged actor').toBe(true);
    // a non-admin cannot forge it either
    const spoof = await alice.ctx.post(`${API}/audit-logs`, { data: { action, resource: 'r', resourceId: '3', userId: topo.bob.id } });
    expect(spoof.status()).toBe(403);
  });

  test('AC31 §5.21 — an unscoped write carries the non-null __platform__ sentinel and the ?userId= actor read filter still returns it', async ({ rbac }) => {
    const { radm } = rbac;
    const action = `axi1149.ac31.${Date.now()}`;
    const row = await expectStatus(await radm.ctx.post(`${API}/audit-logs`, { data: { action, resource: 'r', resourceId: '1' } }), 201);
    expect(row.workspaceId, 'never null/empty').toBe('__platform__');

    const bySentinel = await expectStatus(await radm.ctx.get(`${API}/audit-logs?workspaceId=__platform__&action=${action}`), 200);
    expect((bySentinel.logs as { id: string }[]).some((l) => l.id === row.id)).toBe(true);
    const byActor = await expectStatus(await radm.ctx.get(`${API}/audit-logs?userId=${radm.id}&action=${action}`), 200);
    expect((byActor.logs as { id: string; userId: string }[]).some((l) => l.id === row.id && l.userId === radm.id), 'the actor read filter selects the row').toBe(true);
  });

  test('AC31 §5.21 (negative counterpart) — the audit hash chain still verifies', async ({ rbac }) => {
    // The demo DB's __platform__ chain is already broken at index 0 by an entry written 2026-09-04
    // (ObjectId 6a9a7fe4…), long before any AXI-1289 write: `verify` reports valid:false, so the
    // documented "chain still verifies" expectation cannot hold on this database. Assertion unchanged;
    // expected-fail keeps the gap visible without a red suite. Drop the line once the chain is repaired.
    test.fail(true, 'demo DB __platform__ audit chain invalid at index 0 (pre-existing 2026-09-04 entry)');
    const verify = await expectStatus(await rbac.radm.ctx.get(`${API}/audit-logs/verify?workspaceId=__platform__`), 200);
    expect(verify.valid, JSON.stringify(verify)).toBe(true);
  });
});

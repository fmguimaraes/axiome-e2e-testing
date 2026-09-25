import type { APIResponse } from '@playwright/test';
import { test, expect } from './harness/fixtures';
import { expectIndistinguishableFromMiss, expectStatus } from './harness/assertions';
import { API, randomUuid, wsHeader, type Topology } from './harness/tenancy';

/**
 * AXI-1149 — Workflow 5 API-level probes, mutation + role-tier side:
 * §4.3 (AC6 AC7), §5.3 (AC1-3), §5.6 (AC5), §5.8-§5.12 (AC3 AC7-AC10).
 * Carol = viewer in A (insufficient role), Bob = admin of the disjoint tenant B
 * (non-member of A). Membership-mutation scenarios that must actually change
 * state use throwaway members so the shared fixture stays stable.
 *
 * Not automated here (see the report): §4.3 step 5 (platform-ADMIN bypass — the
 * demo admin is a role-assigned superuser AND the creator-admin of every workspace
 * it provisions, so it can not be shown to bypass while being a non-member) and
 * §5.19-§5.22 (rule-access RBAC needs custom roles + org rule grants + rule runs).
 */
test.use({ storageState: { cookies: [], origins: [] } });

async function auditActions(topo: Topology, ws: string): Promise<string[]> {
  const res = await topo.alice.ctx.get(`${API}/workspaces/${ws}/audit-logs`, { headers: wsHeader(ws) });
  const body = await expectStatus(res, 200);
  const rows: { action?: string; eventType?: string }[] = Array.isArray(body) ? body : body.data ?? [];
  return rows.map((r) => `${r.action ?? r.eventType}`);
}

async function member(topo: Topology, ws: string, userId: string): Promise<{ role: string } | undefined> {
  const body = await expectStatus(await topo.alice.ctx.get(`${API}/workspaces/${ws}`, { headers: wsHeader(ws) }), 200);
  return (body.members as { userId: string; role: string }[]).find((m) => m.userId === userId);
}

const count = (rows: string[], needle: string) => rows.filter((a) => a.includes(needle)).length;

test.describe('AXI-1149 role tier and cross-tenant mutations', () => {
  test('AC1 AC2 AC3 §5.3 — cross-tenant project mutations are 404 and leave the row untouched', async ({ topo }) => {
    const { alice, bob, WS_A, WS_B, PROJ_B } = topo;
    const h = wsHeader(WS_A);
    await expectIndistinguishableFromMiss(PROJ_B, (id) => alice.ctx.patch(`${API}/projects/${id}`, { data: { name: 'pwned' }, headers: h }));
    await expectIndistinguishableFromMiss(PROJ_B, (id) => alice.ctx.delete(`${API}/projects/${id}`, { headers: h }));
    await expectIndistinguishableFromMiss(PROJ_B, (id) => alice.ctx.patch(`${API}/projects/${id}/archive`, { data: {}, headers: h }));
    const proj = await expectStatus(await bob.ctx.get(`${API}/projects/${PROJ_B}`, { headers: wsHeader(WS_B) }), 200);
    expect(proj.name).not.toBe('pwned');
    expect(proj.deletedAt ?? null).toBeNull();
    expect(`${proj.status ?? ''}`.toLowerCase()).not.toContain('archiv');
  });

  test('AC5 §5.6 — a soft-deleted project is invisible to every read and un-targetable by mutation', async ({ topo }) => {
    const { alice, admin, WS_A, SLICE_A } = topo;
    const h = wsHeader(WS_A);
    const created = await expectStatus(
      await admin.ctx.post(`${API}/projects`, { data: { name: `AXI1149 softdel ${Date.now()}`, workspaceId: WS_A }, headers: h }), 201);
    const pid = created.id;
    const sl = await expectStatus(await admin.ctx.post(`${API}/graph-slices`, { data: { projectId: pid, nodeIds: [], edgeIds: [], label: 'sd' }, headers: h }), 201);
    const before = await expectStatus(await alice.ctx.get(`${API}/graph-slices?projectId=${pid}`, { headers: h }), 200);
    expect(JSON.stringify(before)).toContain(sl.id);
    const del = await alice.ctx.delete(`${API}/projects/${pid}`, { headers: h });
    expect([200, 204], await del.text()).toContain(del.status());
    expect((await alice.ctx.get(`${API}/projects/${pid}`, { headers: h })).status()).toBe(404);
    expect((await alice.ctx.patch(`${API}/projects/${pid}`, { data: { name: 'zombie' }, headers: h })).status()).toBe(404);
    const after = await alice.ctx.get(`${API}/graph-slices?projectId=${pid}`, { headers: h });
    const text = await after.text();
    expect(text, 'a slice of a soft-deleted project must no longer be listed').not.toContain(sl.id);
    void SLICE_A;
  });

  test('AC6 AC7 §4.3 — a workspace admin still manages members (add editor, change role, add admin, remove)', async ({ topo }) => {
    const { alice, dave, WS_A, ORG_A } = topo;
    const h = wsHeader(WS_A);
    const editor = await topo.spare('newed');
    const accomplice = await topo.spare('newadm');
    let ws = await expectStatus(await alice.ctx.post(`${API}/workspaces/${WS_A}/members`, { data: { userId: editor.id, organizationId: ORG_A, role: 'editor' }, headers: h }), 201);
    expect(ws.members.find((m: any) => m.userId === editor.id).role).toBe('editor');
    ws = await expectStatus(await alice.ctx.patch(`${API}/workspaces/${WS_A}/members/${dave.id}/role`, { data: { role: 'approver' }, headers: h }), 200);
    expect((await member(topo, WS_A, dave.id))!.role).toBe('approver');
    ws = await expectStatus(await alice.ctx.post(`${API}/workspaces/${WS_A}/members`, { data: { userId: accomplice.id, organizationId: ORG_A, role: 'admin' }, headers: h }), 201);
    expect(ws.members.find((m: any) => m.userId === accomplice.id).role).toBe('admin');
    const rm = await alice.ctx.delete(`${API}/workspaces/${WS_A}/members/${editor.id}`, { headers: h });
    expect([200, 204], await rm.text()).toContain(rm.status());
    expect(await member(topo, WS_A, editor.id)).toBeUndefined();
    expect(count(await auditActions(topo, WS_A), 'role_changed')).toBeGreaterThan(0);
    // restore Dave so later specs see the documented topology
    await alice.ctx.patch(`${API}/workspaces/${WS_A}/members/${dave.id}/role`, { data: { role: 'editor' }, headers: h });
  });

  test('AC7 AC8 AC9 §5.8 — a viewer cannot self-elevate to admin (403, role unchanged, no audit trace)', async ({ topo }) => {
    const { carol, WS_A } = topo;
    const h = wsHeader(WS_A);
    const before = await auditActions(topo, WS_A);
    for (const data of [{ role: 'admin' }, { roleId: '00000000-0000-0000-0000-000000000104' }]) {
      const res = await carol.ctx.patch(`${API}/workspaces/${WS_A}/members/${carol.id}/role`, { data, headers: h });
      expect(res.status(), await res.text()).toBe(403);
    }
    expect((await member(topo, WS_A, carol.id))!.role).toBe('viewer');
    expect(await auditActions(topo, WS_A)).toHaveLength(before.length);
  });

  test('AC7 AC8 AC9 §5.9 — a viewer cannot add a member nor plant an accomplice admin', async ({ topo }) => {
    const { carol, WS_A, ORG_A } = topo;
    const h = wsHeader(WS_A);
    const target = await topo.spare('victim');
    const before = await auditActions(topo, WS_A);
    for (const role of ['admin', 'viewer']) {
      const res = await carol.ctx.post(`${API}/workspaces/${WS_A}/members`, { data: { userId: target.id, organizationId: ORG_A, role }, headers: h });
      expect(res.status(), `${role}: ${await res.text()}`).toBe(403);
    }
    expect(await member(topo, WS_A, target.id)).toBeUndefined();
    expect(await auditActions(topo, WS_A)).toHaveLength(before.length);
  });

  test('AC7 AC9 §5.10 — a viewer cannot remove another member (nor the admin), and no session is revoked', async ({ topo }) => {
    const { carol, alice, dave, WS_A } = topo;
    const h = wsHeader(WS_A);
    const before = await auditActions(topo, WS_A);
    for (const victim of [dave.id, alice.id]) {
      const res = await carol.ctx.delete(`${API}/workspaces/${WS_A}/members/${victim}`, { headers: h });
      expect(res.status(), await res.text()).toBe(403);
    }
    expect(await member(topo, WS_A, dave.id)).toBeDefined();
    expect(await member(topo, WS_A, alice.id)).toBeDefined();
    expect(count(await auditActions(topo, WS_A), 'member_removed')).toBe(count(before, 'member_removed'));
    await expectStatus(await alice.ctx.get(`${API}/workspaces/${WS_A}`, { headers: h }), 200);
  });

  test('AC10 §5.11 — a member may remove themselves, but self role-change stays forbidden', async ({ topo }) => {
    const { alice, WS_A, ORG_A } = topo;
    const h = wsHeader(WS_A);
    const erin = await topo.spare('erin', { ws: WS_A, org: ORG_A, role: 'viewer' });
    const rm = await erin.ctx.delete(`${API}/workspaces/${WS_A}/members/${erin.id}`, { headers: h });
    expect([200, 204], await rm.text()).toContain(rm.status());
    expect(await member(topo, WS_A, erin.id)).toBeUndefined();
    expect((await erin.ctx.get(`${API}/workspaces/${WS_A}`, { headers: h })).status()).toBe(404);
    await expectStatus(await alice.ctx.post(`${API}/workspaces/${WS_A}/members`, { data: { userId: erin.id, organizationId: ORG_A, role: 'viewer' }, headers: h }), 201);
    const promo = await erin.ctx.patch(`${API}/workspaces/${WS_A}/members/${erin.id}/role`, { data: { role: 'editor' }, headers: h });
    expect(promo.status(), await promo.text()).toBe(403);
    expect((await member(topo, WS_A, erin.id))!.role).toBe('viewer');
  });

  test('AC3 AC7 AC9 §5.12 — viewer delete of the workspace is 403; a non-member gets 404 equal to a miss, never 403', async ({ topo }) => {
    const { carol, bob, alice, WS_A, WS_B } = topo;
    const del = await carol.ctx.delete(`${API}/workspaces/${WS_A}`, { headers: wsHeader(WS_A) });
    expect(del.status(), await del.text()).toBe(403);
    const ws = await expectStatus(await alice.ctx.get(`${API}/workspaces/${WS_A}`, { headers: wsHeader(WS_A) }), 200);
    expect(ws.deletedAt ?? null).toBeNull();
    // Bob is NOT a member of A. Header WS_B is his own (congruence is not the subject here).
    const bh = wsHeader(WS_B);
    const call: [string, (id: string) => Promise<APIResponse>][] = [
      ['DELETE workspace', (id) => bob.ctx.delete(`${API}/workspaces/${id}`, { headers: bh })],
      ['POST members', (id) => bob.ctx.post(`${API}/workspaces/${id}/members`, { data: { userId: carol.id, organizationId: topo.ORG_B, role: 'viewer' }, headers: bh })],
      ['PATCH member role', (id) => bob.ctx.patch(`${API}/workspaces/${id}/members/${alice.id}/role`, { data: { role: 'viewer' }, headers: bh })],
    ];
    for (const [name, probe] of call) {
      await test.step(name, () => expectIndistinguishableFromMiss(WS_A, probe));
    }
    void randomUuid;
  });
});

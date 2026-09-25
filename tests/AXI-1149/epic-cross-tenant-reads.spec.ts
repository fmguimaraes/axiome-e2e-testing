import { request as apiRequest } from '@playwright/test';
import { test, expect } from './harness/fixtures';
import { expectIndistinguishableFromMiss, expectStatus } from './harness/assertions';
import { API, randomUuid, wsHeader, canon } from './harness/tenancy';

/**
 * AXI-1149 (Multi-Tenancy Hardening) — Workflow 5 API-level cross-tenant probes,
 * read side. Source of truth: axiome-docs/manual-e2e/AXI-1149-Multi-Tenancy-Hardening.md
 * (§4.1, §4.2, §5.1–§5.5, §5.7, §5.18). Alice = workspace admin of A; Bob = admin of
 * the disjoint tenant B. Every Alice call carries `X-Workspace-Id: WS_A` (what the
 * front end always emits) unless the scenario is about the header.
 */
// API-only: no browser session, so opt out of the default admin storageState.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('AXI-1149 cross-tenant reads', () => {
  test('AC6 §4.1 — a member still reads and mutates their own tenant', async ({ topo }) => {
    const { alice, WS_A, ORG_A, PROJ_A, SLICE_A } = topo;
    const h = wsHeader(WS_A);
    const ws = await expectStatus(await alice.ctx.get(`${API}/workspaces/${WS_A}`, { headers: h }), 200);
    expect(ws.id).toBe(WS_A);
    await expectStatus(await alice.ctx.get(`${API}/organizations/${ORG_A}`, { headers: h }), 200);
    await expectStatus(await alice.ctx.patch(`${API}/projects/${PROJ_A}`, { data: { description: 'updated-1149' }, headers: h }), 200);
    const reread = await expectStatus(await alice.ctx.get(`${API}/projects/${PROJ_A}`, { headers: h }), 200);
    expect(reread.description).toBe('updated-1149');
    const slices = await expectStatus(await alice.ctx.get(`${API}/graph-slices?projectId=${PROJ_A}`, { headers: h }), 200);
    const rows: { id: string }[] = slices.data ?? slices;
    expect(rows.map((r) => r.id)).toContain(SLICE_A);
    expect(rows.map((r) => r.id)).not.toContain(topo.SLICE_B);
  });

  test('AC1 AC6 §4.2 — listings are member-scoped and a client userId is ignored', async ({ topo }) => {
    const { alice, bob, WS_A, WS_B, ORG_A, ORG_B } = topo;
    const h = wsHeader(WS_A);
    const ids = (b: any): string[] => (b.data ?? b).map((r: { id: string }) => r.id);
    const wsList = ids(await expectStatus(await alice.ctx.get(`${API}/workspaces?limit=100`, { headers: h }), 200));
    expect(wsList).toContain(WS_A);
    expect(wsList).not.toContain(WS_B);
    const orgList = ids(await expectStatus(await alice.ctx.get(`${API}/organizations?limit=100`, { headers: h }), 200));
    expect(orgList).toContain(ORG_A);
    expect(orgList).not.toContain(ORG_B);
    const spoofed = ids(await expectStatus(await alice.ctx.get(`${API}/workspaces?limit=100&userId=${bob.id}`, { headers: h }), 200));
    expect(spoofed.sort()).toEqual(wsList.sort());
    expect(spoofed).not.toContain(WS_B);
  });

  test('AC1 AC2 AC3 §5.1 — cross-tenant workspace read is a 404 indistinguishable from a miss', async ({ topo }) => {
    const { alice, WS_A, WS_B } = topo;
    await expectIndistinguishableFromMiss(WS_B, (id) => alice.ctx.get(`${API}/workspaces/${id}`, { headers: wsHeader(WS_A) }));
  });

  test('AC1 AC2 AC3 §5.2 — cross-tenant organization reads are 404 indistinguishable from a miss', async ({ topo }) => {
    const { alice, WS_A, ORG_B } = topo;
    const h = wsHeader(WS_A);
    await expectIndistinguishableFromMiss(ORG_B, (id) => alice.ctx.get(`${API}/organizations/${id}`, { headers: h }));
    await expectIndistinguishableFromMiss(ORG_B, (id) => alice.ctx.get(`${API}/organizations/${id}/workspaces`, { headers: h }));
  });

  test('AC1 AC2 AC3 §5.4 — cross-tenant graph slice, derived evidence and decision draft by id', async ({ topo }) => {
    const { alice, WS_A, SLICE_B, DE_B, DD_B } = topo;
    const h = wsHeader(WS_A);
    await expectIndistinguishableFromMiss(SLICE_B, (id) => alice.ctx.get(`${API}/graph-slices/${id}`, { headers: h }));
    test.skip(!DE_B || !DD_B, `demo stack holds no pre-existing derived-evidence / decision-draft row to act as the victim (DE_B=${!!DE_B}, DD_B=${!!DD_B}); cannot be minted through the API without a snapshot lineage`);
    // Positive controls: the victim rows genuinely exist and their OWNER can read them, so the 404s below are denials, not misses.
    const owner = topo.admin.ctx;
    await expectStatus(await owner.get(`${API}/derived-evidence/${DE_B!.id}`, { headers: wsHeader(DE_B!.workspaceId) }), 200);
    await expectStatus(await owner.get(`${API}/workspaces/${DD_B!.workspaceId}/decisions/${DD_B!.id}`, { headers: wsHeader(DD_B!.workspaceId) }), 200);
    await expectIndistinguishableFromMiss(DE_B!.id, (id) => alice.ctx.get(`${API}/derived-evidence/${id}`, { headers: h }));
    await expectIndistinguishableFromMiss(DE_B!.id, (id) => alice.ctx.get(`${API}/derived-evidence/${id}/provenance`, { headers: h }));
    await expectIndistinguishableFromMiss(DD_B!.id, (id) => alice.ctx.get(`${API}/workspaces/${WS_A}/decisions/${id}`, { headers: h }));
  });

  test('AC4 §5.5 — an unidentified caller fails closed with 401 and no existence oracle', async ({ topo }) => {
    const anon = await apiRequest.newContext();
    const bad = await apiRequest.newContext({ extraHTTPHeaders: { authorization: 'Bearer not.a.jwt' } });
    for (const ctx of [anon, bad]) {
      const existing = await ctx.get(`${API}/workspaces/${topo.WS_A}`);
      const missing = await ctx.get(`${API}/workspaces/${randomUuid()}`);
      expect(existing.status()).toBe(401);
      expect(missing.status()).toBe(401);
      const a = (await canon(existing)).canon.split(topo.WS_A).join('<ID>');
      const b = await canon(missing);
      expect(a).toBe(b.canon);
    }
    await anon.dispose();
    await bad.dispose();
  });

  test('AC1 §5.7 — a stale client-supplied scope cannot widen a listing', async ({ topo }) => {
    const { alice, WS_A, WS_B, PROJ_B, SLICE_B, PROJ_A } = topo;
    const h = wsHeader(WS_A);
    const projects = await alice.ctx.get(`${API}/projects?workspaceId=${WS_B}`, { headers: h });
    const slices = await alice.ctx.get(`${API}/graph-slices?projectId=${PROJ_B}`, { headers: h });
    for (const res of [projects, slices]) {
      expect([200, 404], await res.text()).toContain(res.status());
      const text = await res.text();
      expect(text).not.toContain(PROJ_B);
      expect(text).not.toContain(SLICE_B);
      expect(text).not.toContain(WS_B);
      if (res.status() === 200) {
        const b = JSON.parse(text);
        expect((b.data ?? b).length, 'a non-member scope must yield an EMPTY listing, not the unfiltered set').toBe(0);
      }
    }
    // Control: the unfiltered set is non-empty for Alice (so "empty" above is not vacuous).
    const own = await expectStatus(await alice.ctx.get(`${API}/graph-slices?projectId=${PROJ_A}`, { headers: h }), 200);
    expect((own.data ?? own).length).toBeGreaterThan(0);
  });

  test('AC16 AC17 AC18 AC19 AC20 AC3 §5.18 — DEF-10 by-id matrix, each path a 404 equal to its miss control', async ({ topo }) => {
    const { alice, bob, WS_A, WS_B, ORG_B, SLICE_B, DE_B, DD_B } = topo;
    const h = wsHeader(WS_A);
    await expectIndistinguishableFromMiss(ORG_B, (id) => alice.ctx.get(`${API}/organizations/${id}`, { headers: h }));
    await expectIndistinguishableFromMiss(WS_B, (id) => alice.ctx.get(`${API}/workspaces/${id}`, { headers: h }));
    await expectIndistinguishableFromMiss(WS_B, (id) => alice.ctx.delete(`${API}/workspaces/${id}`, { headers: h }));
    await expectIndistinguishableFromMiss(SLICE_B, (id) => alice.ctx.patch(`${API}/graph-slices/${id}`, { data: { label: 'pwned' }, headers: h }));
    await expectIndistinguishableFromMiss(SLICE_B, (id) => alice.ctx.delete(`${API}/graph-slices/${id}`, { headers: h }));
    // The refused mutations must not have landed: Bob still sees WS_B and SLICE_B unchanged.
    const bh = wsHeader(WS_B);
    const wsB = await expectStatus(await bob.ctx.get(`${API}/workspaces/${WS_B}`, { headers: bh }), 200);
    expect(wsB.deletedAt ?? null).toBeNull();
    const sliceB = await expectStatus(await bob.ctx.get(`${API}/graph-slices/${SLICE_B}`, { headers: bh }), 200);
    expect(sliceB.label).not.toBe('pwned');
    if (DE_B && DD_B) {
      await expectIndistinguishableFromMiss(DE_B.id, (id) => alice.ctx.get(`${API}/derived-evidence/${id}`, { headers: h }));
      await expectIndistinguishableFromMiss(DD_B.id, (id) => alice.ctx.get(`${API}/workspaces/${WS_A}/decisions/${id}`, { headers: h }));
    }
  });

  test('AC6 §5.18 positive counterpart — Alice still reads her own org/workspace/slice', async ({ topo }) => {
    const { alice, WS_A, ORG_A, SLICE_A } = topo;
    const h = wsHeader(WS_A);
    await expectStatus(await alice.ctx.get(`${API}/organizations/${ORG_A}`, { headers: h }), 200);
    await expectStatus(await alice.ctx.get(`${API}/workspaces/${WS_A}`, { headers: h }), 200);
    await expectStatus(await alice.ctx.get(`${API}/graph-slices/${SLICE_A}`, { headers: h }), 200);
  });
  test('AC3 canary — the oracle helper can fail: a member reading their OWN workspace is not indistinguishable from a miss', async ({ topo }) => {
    const { bob, WS_B } = topo;
    await expect(
      expectIndistinguishableFromMiss(WS_B, (id) => bob.ctx.get(`${API}/workspaces/${id}`, { headers: wsHeader(WS_B) })),
    ).rejects.toThrow();
  });
});

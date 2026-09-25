import { test, expect } from './harness/fixtures';
import { expectIndistinguishableFromMiss, expectStatus } from './harness/assertions';
import { API, randomUuid, wsHeader } from './harness/tenancy';

/**
 * AXI-1149 — Workflow 5 API-level probes, confused-deputy side (AXI-1286):
 * §4.4 (AC15), §5.13 + §5.14 (AC11), §5.15 (AC12), §5.17 (AC14).
 * Alice = admin of A, not a member of B. Carol = viewer in A, editor in C.
 * Not automated here (see the report): §5.16 (needs an Excel import batch whose
 * sheet rows only exist after a real workbook upload + parse).
 */
test.use({ storageState: { cookies: [], origins: [] } });

const CONGRUENCE = /Route workspace does not match the authenticated workspace context/;

test.describe('AXI-1149 confused deputy', () => {
  test('AC11 §5.13 — header A + route B is a 403 on datasets, ingestions and import-batches', async ({ topo }) => {
    const { alice, WS_A, WS_B, DS_B } = topo;
    const h = wsHeader(WS_A);
    const base = `${API}/workspaces/${WS_B}`;
    const calls: [string, () => Promise<import('@playwright/test').APIResponse>][] = [
      ['GET datasets', () => alice.ctx.get(`${base}/datasets`, { headers: h })],
      ['GET dataset', () => alice.ctx.get(`${base}/datasets/${DS_B}`, { headers: h })],
      ['POST query', () => alice.ctx.post(`${base}/datasets/${DS_B}/query`, { data: {}, headers: h })],
      ['GET download', () => alice.ctx.get(`${base}/datasets/${DS_B}/download`, { headers: h })],
      ['DELETE dataset', () => alice.ctx.delete(`${base}/datasets/${DS_B}`, { headers: h })],
      ['GET import-batches', () => alice.ctx.get(`${base}/import-batches`, { headers: h })],
      ['GET import-batch', () => alice.ctx.get(`${base}/import-batches/${randomUuid()}`, { headers: h })],
      ['GET ingestions', () => alice.ctx.get(`${base}/datasets/${DS_B}/ingestions`, { headers: h })],
      ['GET ingestion', () => alice.ctx.get(`${base}/datasets/${DS_B}/ingestions/${randomUuid()}`, { headers: h })],
    ];
    for (const [name, call] of calls) {
      const res = await call();
      const body = await res.text();
      expect(res.status(), `${name}: ${body.slice(0, 300)}`).toBe(403);
      expect(body, name).toMatch(CONGRUENCE);
    }
  });

  test('AC9/AC11 §5.13 — congruent (B,B) by a non-member is 404 (never 403), not the congruence refusal, indistinguishable from a workspace miss', async ({ topo }) => {
    const { alice, WS_B, DS_B } = topo;
    const res = await alice.ctx.get(`${API}/workspaces/${WS_B}/datasets/${DS_B}`, { headers: wsHeader(WS_B) });
    const body = await res.text();
    expect(res.status(), body).toBe(404);
    expect(body).not.toMatch(CONGRUENCE);
    expect(body).toMatch(/Workspace not found/);
    // No existence oracle: a header naming a workspace that does not exist is refused identically.
    const miss = randomUuid();
    const ctl = await alice.ctx.get(`${API}/workspaces/${miss}/datasets/${DS_B}`, { headers: wsHeader(miss) });
    expect(ctl.status()).toBe(res.status());
    const strip = (t: string, id: string) => JSON.stringify((({ path, timestamp, ...r }) => r)(JSON.parse(t))).split(id).join('<ID>');
    expect(strip(body, WS_B)).toBe(strip(await ctl.text(), miss));
  });

  test('AC11 §5.14 — the divergence is refused on every :workspaceId controller, not only the adopted families', async ({ topo }) => {
    const { alice, WS_A, WS_B, DS_B } = topo;
    const h = wsHeader(WS_A);
    const w = `${API}/workspaces/${WS_B}`;
    const cohortId = randomUuid();
    const gets = [
      `${w}/subjects`, `${w}/glossary/categories`, `${w}/decisions`, `${w}/dataviews/results/${randomUuid()}`, `${w}/subject-panels`,
      `${w}/cohorts/${cohortId}/visualizations`,
      `${w}/datasets/${DS_B}/profiles`, `${w}/datasets/${DS_B}/quality-checks`, `${w}/datasets/${DS_B}/candidates`,
      `${API}/engagement/digest/config/${WS_B}`, `${API}/semantic-profiles/workspace/${WS_B}/policy`,
    ];
    for (const url of gets) {
      const res = await alice.ctx.get(url, { headers: h });
      const body = await res.text();
      expect(res.status(), `GET ${url}: ${body.slice(0, 300)}`).toBe(403);
    }
    const put = await alice.ctx.put(`${API}/engagement/digest/config/${WS_B}`, { data: {}, headers: h });
    expect(put.status(), await put.text()).toBe(403);
  });

  test('AC11 §5.14 missing-header fail-closed — a :workspaceId route without X-Workspace-Id is 400', async ({ topo }) => {
    const { alice, WS_B } = topo;
    const res = await alice.ctx.get(`${API}/engagement/digest/config/${WS_B}`);
    const body = await res.text();
    expect(res.status(), body).toBe(400);
    expect(body).toMatch(/X-Workspace-Id header is required/);
  });

  test('AC12 §5.15 — a foreign resource under a congruent (A,A) pair is a 404 equal to a miss', async ({ topo }) => {
    const { alice, WS_A, DS_B } = topo;
    const h = wsHeader(WS_A);
    const base = `${API}/workspaces/${WS_A}`;
    await expectIndistinguishableFromMiss(DS_B, (id) => alice.ctx.get(`${base}/datasets/${id}`, { headers: h }));
    await expectIndistinguishableFromMiss(DS_B, (id) => alice.ctx.post(`${base}/datasets/${id}/query`, { data: {}, headers: h }));
    await expectIndistinguishableFromMiss(DS_B, (id) => alice.ctx.patch(`${base}/datasets/${id}/metadata`, { data: { notes: 'pwned' }, headers: h }));
    await expectIndistinguishableFromMiss(DS_B, (id) => alice.ctx.get(`${base}/datasets/${id}/ingestions`, { headers: h }));
    await expectIndistinguishableFromMiss(DS_B, (id) => alice.ctx.get(`${base}/datasets/${id}/ingestions/${randomUuid()}`, { headers: h }));
    // The refused PATCH must not have landed on B's row.
    const own = await expectStatus(await topo.bob.ctx.get(`${API}/workspaces/${topo.WS_B}/datasets/${DS_B}`, { headers: wsHeader(topo.WS_B) }), 200);
    expect(JSON.stringify(own)).not.toContain('pwned');
  });

  test('AC12 §5.15 body-displacement — a payload workspaceId naming B never lands the dataset in B', async ({ topo }) => {
    const { alice, WS_A, WS_B, ORG_A, ORG_B, bob } = topo;
    const filename = `axi1149-displace-${Date.now()}.csv`;
    const res = await alice.ctx.post(`${API}/workspaces/${WS_A}/datasets`, {
      headers: wsHeader(WS_A),
      data: { workspaceId: WS_B, organizationId: ORG_A, originalFilename: filename, contentType: 'text/csv' },
    });
    const body = await expectStatus(res, 201);
    expect(body.dataset.workspaceId).toBe(WS_A);
    const bList = await expectStatus(await bob.ctx.get(`${API}/workspaces/${WS_B}/datasets?limit=100`, { headers: wsHeader(WS_B) }), 200);
    expect(JSON.stringify(bList)).not.toContain(filename);
    void ORG_B;
  });

  test('AC5 §5.15 soft-delete half — a soft-deleted dataset and its ingestions are unreachable', async ({ topo }) => {
    const { alice, WS_A, ORG_A } = topo;
    const h = wsHeader(WS_A);
    const created = await expectStatus(
      await alice.ctx.post(`${API}/workspaces/${WS_A}/datasets`, {
        headers: h, data: { organizationId: ORG_A, originalFilename: `axi1149-softdel-${Date.now()}.csv`, contentType: 'text/csv' },
      }),
      201,
    );
    const id = created.dataset.id;
    await expectStatus(await alice.ctx.get(`${API}/workspaces/${WS_A}/datasets/${id}`, { headers: h }), 200);
    const del = await alice.ctx.delete(`${API}/workspaces/${WS_A}/datasets/${id}`, { headers: h });
    expect([200, 204], await del.text()).toContain(del.status());
    expect((await alice.ctx.get(`${API}/workspaces/${WS_A}/datasets/${id}`, { headers: h })).status()).toBe(404);
    expect((await alice.ctx.get(`${API}/workspaces/${WS_A}/datasets/${id}/ingestions`, { headers: h })).status()).toBe(404);
  });

  test('AC14 §5.17 — role decorators judge the route workspace, not a foreign header workspace', async ({ topo }) => {
    const { carol, WS_A, WS_C, ORG_A } = topo;
    const data = { organizationId: ORG_A, originalFilename: 'axi1149-role.csv', contentType: 'text/csv' };
    const viaHeaderC = await carol.ctx.post(`${API}/workspaces/${WS_A}/datasets`, { headers: wsHeader(WS_C), data });
    const viaHeaderCBody = await viaHeaderC.text();
    expect(viaHeaderC.status(), viaHeaderCBody).toBe(403);
    expect(viaHeaderCBody).toMatch(CONGRUENCE);
    const viaHeaderA = await carol.ctx.post(`${API}/workspaces/${WS_A}/datasets`, { headers: wsHeader(WS_A), data });
    const viaHeaderABody = await viaHeaderA.text();
    expect(viaHeaderA.status(), viaHeaderABody).toBe(403);
    expect(viaHeaderABody).toMatch(/Insufficient workspace role/);
    expect(viaHeaderABody).not.toMatch(CONGRUENCE);
  });

  test('AC15 §4.4 — the congruent same-tenant lifecycle is unchanged (initiate, list, read; header omitted = 400)', async ({ topo }) => {
    const { alice, WS_A, DS_A } = topo;
    const h = wsHeader(WS_A);
    const list = await expectStatus(await alice.ctx.get(`${API}/workspaces/${WS_A}/datasets?limit=100`, { headers: h }), 200);
    expect(JSON.stringify(list)).toContain(DS_A);
    await expectStatus(await alice.ctx.get(`${API}/workspaces/${WS_A}/datasets/${DS_A}`, { headers: h }), 200);
    await expectStatus(await alice.ctx.get(`${API}/workspaces/${WS_A}/datasets/${DS_A}/audit-logs`, { headers: h }), 200);
    const noHeader = await alice.ctx.get(`${API}/workspaces/${WS_A}/datasets/${DS_A}`);
    expect(noHeader.status(), await noHeader.text()).toBe(400);
  });
});

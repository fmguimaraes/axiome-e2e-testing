import { request as apiRequest, type APIRequestContext } from '@playwright/test';
import { test, expect } from './harness/rbac';
import { API, type Principal } from './harness/tenancy';
import { expectIndistinguishableFromMiss, expectStatus } from './harness/assertions';

/**
 * AXI-1149-validation (Workflow 5) — §5.23 / AC35 and AC36 (AC1/AC3 semantics).
 *
 * AC35: a plain user can neither self-elevate (`PATCH /users/:id {role:'ADMIN'}`)
 *       nor update another user; a platform ADMIN still can. Non-admin + another
 *       user's id is a 404 byte-identical to a genuine miss (no oracle); a
 *       non-admin changing its OWN privilege field is a 403.
 * AC36: a cross-tenant `datasetId` / `projectId` on `POST /rule-runs` is a 404
 *       identical to a genuine miss (it was a 403 "... not found in this workspace").
 *
 * EXPECTED-FAIL ON THE LIVE DEMO STACK: it serves the PRIMARY checkout, which does
 * NOT yet contain the fix (axiome-back worktree branch AXI-1149-validation,
 * commit fa57db4b). Tests carrying `test.fail` are annotated with that SHA; their
 * assertions are the correct post-fix ones and are unchanged. Remove each
 * `test.fail` once fa57db4b is merged and the stack redeployed.
 */

const FIX = 'axiome-back AXI-1149-validation @ fa57db4b (not merged; the demo stack serves the primary checkout without it)';

function jwtRole(accessToken: string): string | undefined {
  const p = accessToken.split('.')[1];
  return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')).role;
}

test.describe('AC35 — users cannot self-elevate or update others (§5.23)', () => {
  test.describe.configure({ mode: 'serial' });
  let tag: string;
  let plain: Principal;
  let victim: Principal;
  const password = `Pe!${Date.now().toString(36)}Zz9`;
  const created: string[] = [];

  test.beforeAll(async ({ topo }) => {
    tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    const mk = async (name: string): Promise<Principal> => {
      const email = `${name}-${tag}@privesc.test`;
      const u = await expectStatus(
        await topo.admin.ctx.post(`${API}/users`, { data: { email, password, firstName: name, lastName: 'AXI1149' } }),
        201,
      );
      created.push(u.id);
      const anon = await apiRequest.newContext();
      const { accessToken } = await expectStatus(await anon.post(`${API}/auth/login`, { data: { email, password } }), 200);
      await anon.dispose();
      expect(jwtRole(accessToken)).toBe('USER');
      const ctx: APIRequestContext = await apiRequest.newContext({
        extraHTTPHeaders: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      });
      return { id: u.id, email, ctx };
    };
    plain = await mk('plain');
    victim = await mk('victim');
  });

  test.afterAll(async ({ topo }) => {
    await plain?.ctx.dispose().catch(() => undefined);
    await victim?.ctx.dispose().catch(() => undefined);
    for (const id of created) await topo.admin.ctx.delete(`${API}/users/${id}`).catch(() => undefined);
  });

  test('AC35 §5.23 — a plain USER cannot promote itself to ADMIN (403) and its JWT role stays USER', async ({ topo }) => {
    test.fail(true, `Fails until ${FIX}: live, PATCH /users/:id {role:'ADMIN'} succeeds for any authenticated user.`);
    const res = await plain.ctx.patch(`${API}/users/${plain.id}`, { data: { role: 'ADMIN' } });
    expect(res.status(), await res.text()).toBe(403);

    const anon = await apiRequest.newContext();
    const { accessToken } = await expectStatus(await anon.post(`${API}/auth/login`, { data: { email: plain.email, password } }), 200);
    await anon.dispose();
    expect(jwtRole(accessToken)).toBe('USER');
    const row = await expectStatus(await topo.admin.ctx.get(`${API}/users/${plain.id}`), 200);
    expect(row.role).toBe('USER');
  });

  test('AC35 §5.23 — a plain USER cannot change its own status either (403)', async () => {
    test.fail(true, `Fails until ${FIX}.`);
    const res = await plain.ctx.patch(`${API}/users/${plain.id}`, { data: { status: 'ACTIVE' } });
    expect(res.status(), await res.text()).toBe(403);
  });

  test('AC35 AC1 AC3 §5.23 — a plain USER cannot update another user: 404, byte-identical to a genuine miss', async ({ topo }) => {
    test.fail(true, `Fails until ${FIX}: live, the update of another user's record succeeds (200).`);
    const probe = (id: string) => plain.ctx.patch(`${API}/users/${id}`, { data: { firstName: 'hijacked' } });
    await expectIndistinguishableFromMiss(victim.id, probe);
    const after = await expectStatus(await topo.admin.ctx.get(`${API}/users/${victim.id}`), 200);
    expect(after.firstName).not.toBe('hijacked');
  });

  test('AC35 AC3 §5.23 — a plain USER cannot set another user password or role (404, victim unchanged)', async ({ topo }) => {
    test.fail(true, `Fails until ${FIX}.`);
    for (const data of [{ password: 'Owned!12345' }, { role: 'ADMIN' }]) {
      const res = await plain.ctx.patch(`${API}/users/${victim.id}`, { data });
      expect(res.status(), await res.text()).toBe(404);
    }
    const row = await expectStatus(await topo.admin.ctx.get(`${API}/users/${victim.id}`), 200);
    expect(row.role).toBe('USER');
    const anon = await apiRequest.newContext();
    const login = await anon.post(`${API}/auth/login`, { data: { email: victim.email, password } });
    await anon.dispose();
    expect(login.status(), 'victim must still authenticate with its ORIGINAL password').toBe(200);
  });

  test('AC35 §5.23 — a plain USER cannot mint an ADMIN via POST /users (403)', async () => {
    test.fail(true, `Fails until ${FIX}.`);
    const email = `minted-${tag}@privesc.test`;
    const res = await plain.ctx.post(`${API}/users`, { data: { email, password, role: 'ADMIN' } });
    if (res.status() < 300) created.push((await res.json()).id); // clean up if the (unfixed) stack let it through
    expect(res.status()).toBe(403);
  });

  test('AC35 §5.23 — a plain USER may still update non-privilege fields of itself', async () => {
    const res = await plain.ctx.patch(`${API}/users/${plain.id}`, { data: { firstName: 'renamed' } });
    expect(res.status(), await res.text()).toBe(200);
  });

  test('AC35 §5.23 — a platform ADMIN can still update another user, including role', async ({ topo }) => {
    const me = await (await topo.admin.ctx.get(`${API}/auth/me`)).json();
    if (me.role !== 'ADMIN') throw new Error(`precondition: suite admin role is ${me.role}, need ADMIN — run with E2E_ADMIN_EMAIL=admin@axiome.local`);
    const up = await expectStatus(await topo.admin.ctx.patch(`${API}/users/${victim.id}`, { data: { role: 'MODERATOR' } }), 200);
    expect(up.role).toBe('MODERATOR');
    await expectStatus(await topo.admin.ctx.patch(`${API}/users/${victim.id}`, { data: { role: 'USER' } }), 200);
  });
});

test.describe('AC36 — cross-tenant dataset/project on rule-run execute is 404 identical to a miss (§5.23)', () => {
  test('AC36 AC3 §5.23 — cross-tenant datasetId is a 404 equal to a miss', async ({ topo, rbac }) => {
    test.fail(true, `Fails until ${FIX}: live it is a 403 "Dataset not found in this workspace".`);
    await expectIndistinguishableFromMiss(topo.DS_B, (id) => rbac.execQc(rbac.uRules, rbac.RULE_WS, { datasetId: id }));
  });

  test('AC36 AC3 §5.23 — cross-tenant projectId is a 404 equal to a miss', async ({ topo, rbac }) => {
    test.fail(true, `Fails until ${FIX}: live it is a 403 "Project not found in this workspace".`);
    await expectIndistinguishableFromMiss(topo.PROJ_B, (id) => rbac.execQc(rbac.uRules, rbac.RULE_WS, { projectId: id }));
  });

  test('AC36 §5.23 — control: the caller own dataset in its own workspace is still accepted by the scope check', async ({ rbac }) => {
    const res = await rbac.execQc(rbac.uRules, rbac.RULE_WS);
    expect([200, 201, 202], await res.text()).toContain(res.status());
  });
});


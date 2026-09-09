import { test, expect, APIRequestContext } from '@playwright/test';
import {
  roleContext,
  send,
  attempt,
  whoAmI,
  createOrganization,
} from './collaboration-fixtures';

/**
 * AXI-1427 — collaboration lifecycle + protected permission (manual-e2e §4.1,
 * §4.2, §4.4, §5.1, §5.3). Each test provisions its own organization pair, so
 * order does not matter. Negative domain rules (duplicate, self, non-addressee)
 * are asserted by OUTCOME — the pair's state is unchanged — because a
 * microservice-thrown domain error surfaces platform-wide as 500 at the gateway,
 * so its HTTP status is not a stable contract. The permission gate is checked by
 * status because it is enforced in the gateway (403). The platform-admin account
 * drives both sides (bypasses org scope + the permission); the `user` account
 * exercises the 403.
 */

let admin: APIRequestContext;
let user: APIRequestContext;
let adminId: string;

test.beforeAll(async () => {
  admin = await roleContext('admin');
  user = await roleContext('user');
  adminId = await whoAmI(admin);
});

test.afterAll(async () => {
  await admin?.dispose();
  await user?.dispose();
});

async function freshPair(): Promise<{ a: string; b: string }> {
  return { a: await createOrganization(admin, adminId), b: await createOrganization(admin, adminId) };
}

const pendingIncomingFor = (list: any, counterpart: string) =>
  list.incomingPending.filter((c: any) => c.counterpartOrgId === counterpart);

test('FR1 FR6 — a request creates a pending link listed as outgoing (requester) and incoming (addressee)', async () => {
  const { a, b } = await freshPair();
  const link = await send(admin, 'post', `/api/v1/organizations/${a}/collaborations`, { targetOrganizationId: b });
  expect(link.status).toBe('pending');

  const aList = await send(admin, 'get', `/api/v1/organizations/${a}/collaborations`);
  expect(aList.outgoingPending.map((c: any) => c.counterpartOrgId)).toContain(b);
  const bList = await send(admin, 'get', `/api/v1/organizations/${b}/collaborations`);
  expect(bList.incomingPending.map((c: any) => c.counterpartOrgId)).toContain(a);
});

test('FR3 FR4 FR5 — addressee accepts (link active for both), then either party revokes', async () => {
  const { a, b } = await freshPair();
  const link = await send(admin, 'post', `/api/v1/organizations/${a}/collaborations`, { targetOrganizationId: b });

  const accepted = await send(admin, 'post', `/api/v1/organizations/${b}/collaborations/${link.id}/respond`, { accept: true });
  expect(accepted.status).toBe('active');
  const aActive = await send(admin, 'get', `/api/v1/organizations/${a}/collaborations`);
  expect(aActive.active.map((c: any) => c.counterpartOrgId)).toContain(b);

  await send(admin, 'delete', `/api/v1/organizations/${a}/collaborations/${link.id}`);
  const aAfter = await send(admin, 'get', `/api/v1/organizations/${a}/collaborations`);
  expect(aAfter.active.map((c: any) => c.counterpartOrgId)).not.toContain(b);
});

test('FR2 — a duplicate request never creates a second link for the same pair', async () => {
  const { a, b } = await freshPair();
  await send(admin, 'post', `/api/v1/organizations/${a}/collaborations`, { targetOrganizationId: b });
  await attempt(admin, 'post', `/api/v1/organizations/${a}/collaborations`, { targetOrganizationId: b });

  const bList = await send(admin, 'get', `/api/v1/organizations/${b}/collaborations`);
  expect(pendingIncomingFor(bList, a)).toHaveLength(1);
});

test('FR2 — an organization cannot collaborate with itself (no self-link is created)', async () => {
  const { a } = await freshPair();
  await attempt(admin, 'post', `/api/v1/organizations/${a}/collaborations`, { targetOrganizationId: a });

  const list = await send(admin, 'get', `/api/v1/organizations/${a}/collaborations`);
  const all = [...list.active, ...list.incomingPending, ...list.outgoingPending];
  expect(all.filter((c: any) => c.counterpartOrgId === a)).toHaveLength(0);
});

test('FR3 — only the addressee may accept; a request by the requester leaves it pending', async () => {
  const { a, b } = await freshPair();
  const link = await send(admin, 'post', `/api/v1/organizations/${a}/collaborations`, { targetOrganizationId: b });

  await attempt(admin, 'post', `/api/v1/organizations/${a}/collaborations/${link.id}/respond`, { accept: true });

  const bList = await send(admin, 'get', `/api/v1/organizations/${b}/collaborations`);
  expect(pendingIncomingFor(bList, a)).toHaveLength(1); // still pending, not active
  const aList = await send(admin, 'get', `/api/v1/organizations/${a}/collaborations`);
  expect(aList.active).toHaveLength(0);
});

test('FR8 NFR1 — a caller without organization:manage_collaborations is refused (403)', async () => {
  const { a, b } = await freshPair();
  await send(
    user,
    'post',
    `/api/v1/organizations/${a}/collaborations`,
    { targetOrganizationId: b },
    { expectStatus: 403 },
  );
});

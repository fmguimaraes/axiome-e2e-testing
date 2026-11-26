import { test, expect, request as apiRequest, APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { roleContext, send, attempt, whoAmI, createOrganization } from '../AXI-1425/collaboration-fixtures';

/**
 * AXI-2734 (epic AXI-2733, area S1) — `POST /users` needs `user:create` from an ORGANIZATION
 * role, and the new user joins only organizations that grant covers (FR17, FR18 server side,
 * AC1, BUG-1, BUG-10); `POST|DELETE /organizations/:id/department-users` need `user:update`
 * over the organization AND the user (FR20, BUG-6). Manual-e2e:
 * `axiome-docs/manual-e2e/AXI-2733-Investigator-SAP-Follow-Ups.md` § AXI-2734.
 *
 * API level. The *holder* is a seeded client admin (the "Super Admin" organization role, which
 * carries `user:create` + `user:update`; default `admin@cro-one.com`, override with
 * `E2E_2734_HOLDER_EMAIL` / `E2E_2734_HOLDER_PASSWORD`). Organization A is the holder's
 * "Axiome E2E Org" (override `E2E_2734_ORG_ID`) — never a client demo organization. The
 * *stranger* is a freshly self-registered account (member of no organization). Every user this spec puts in A is detached again by the holder at the end
 * (which also exercises the authorised FR20 path), so A's member list is left as found.
 *
 * The platform-admin regression (3.7) needs the platform-admin credentials (`E2E_TEST_EMAIL`
 * / `E2E_TEST_PASSWORD`); without them it is skipped, never faked.
 */

const PASSWORD = 'E2eUser!23';
const HOLDER_EMAIL = process.env.E2E_2734_HOLDER_EMAIL?.trim() || 'admin@cro-one.com';
const HOLDER_PASSWORD = process.env.E2E_2734_HOLDER_PASSWORD?.trim() || 'admin';
const ORG_NAME = 'Axiome E2E Org';
const HAS_PLATFORM_ADMIN = Boolean(process.env.E2E_TEST_PASSWORD?.trim() || process.env.E2E_ADMIN_PASSWORD?.trim());
const newEmail = (label: string) => `e2e-2734-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;

let holder: APIRequestContext;
let holderId: string;
let asMember: APIRequestContext;
let stranger: APIRequestContext;
let strangerId: string;
let orgA: string;
let member: { id: string; email: string };
let victim: { id: string; email: string };
const toDetach: string[] = [];

async function loginAs(email: string, password: string): Promise<APIRequestContext> {
  const bootstrap = await apiRequest.newContext();
  const res = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  expect(res.ok(), `login ${email} → ${res.status()}`).toBeTruthy();
  const { accessToken } = await res.json();
  await bootstrap.dispose();
  return apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
}

async function departmentUserIds(orgId: string): Promise<string[]> {
  const rows = await send(holder, 'get', `/api/v1/organizations/${orgId}/department-users`);
  return (rows ?? []).map((r: any) => String(r.userId ?? r.user?.id ?? r.id));
}

/** A brand-new self-registered account: a member of no organization at all. */
async function registerFreshUser(): Promise<APIRequestContext> {
  const email = newEmail('stranger');
  const bootstrap = await apiRequest.newContext();
  const res = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'E2E', lastName: 'Stranger' },
  });
  expect(res.ok(), `register ${email} → ${res.status()}`).toBeTruthy();
  await bootstrap.dispose();
  return loginAs(email, PASSWORD);
}

/** The holder creates a user in A (the authorised FR17 path) and schedules its detach. */
async function holderCreatesInA(label: string): Promise<{ id: string; email: string }> {
  const email = newEmail(label);
  const user = await send(holder, 'post', '/api/v1/users', { email, password: PASSWORD, organizationId: orgA });
  toDetach.push(String(user.id));
  return { id: String(user.id), email };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  holder = await loginAs(HOLDER_EMAIL, HOLDER_PASSWORD);
  holderId = await whoAmI(holder);
  const roles: any[] = await send(holder, 'get', `/api/v1/users/${holderId}/roles`);
  expect(
    roles.some((r) => r.scope === 'ORGANIZATION' && ['user:create', 'user:update'].every((p) => (r.permissions ?? []).includes(p))),
    `${HOLDER_EMAIL} holds user:create + user:update through an ORGANIZATION role`,
  ).toBeTruthy();

  orgA = process.env.E2E_2734_ORG_ID?.trim() || '';
  if (!orgA) {
    const orgs = await send(holder, 'get', '/api/v1/organizations?limit=100');
    const list: any[] = Array.isArray(orgs) ? orgs : orgs?.data ?? orgs?.organizations ?? [];
    orgA = list.find((o) => o.name === ORG_NAME)?.id ?? '';
  }
  expect(orgA, `${HOLDER_EMAIL} is a member of "${ORG_NAME}" (or set E2E_2734_ORG_ID)`).toBeTruthy();

  stranger = await registerFreshUser();
  strangerId = await whoAmI(stranger);
  member = await holderCreatesInA('member');
  victim = await holderCreatesInA('victim');
  asMember = await loginAs(member.email, PASSWORD);
});

test.afterAll(async () => {
  for (const id of toDetach) {
    await attempt(holder, 'delete', `/api/v1/organizations/${orgA}/department-users/${id}`);
  }
  await Promise.all([holder?.dispose(), asMember?.dispose(), stranger?.dispose()]);
});

test('AXI-2734 AC1 BUG-1 — a member without user:create gets 403 on POST /users and nothing is written @SI-010 @SI-011 @SI-001', async () => {
  // Arrange
  const email = newEmail('denied');

  // Act
  const res = await attempt(asMember, 'post', '/api/v1/users', { email, password: PASSWORD });

  // Assert — refused, and the email is still free (the holder can create it: no 409).
  expect(res.status, JSON.stringify(res.body)).toBe(403);
  const retry = await attempt(holder, 'post', '/api/v1/users', { email, password: PASSWORD, organizationId: orgA });
  expect(retry.status, JSON.stringify(retry.body)).toBe(201);
  toDetach.push(String(retry.body.id));
});

test('AXI-2734 AC1 FR17 — a user:create holder creates a user, who joins the named covered organization @SI-010 @SI-011', async () => {
  // Assert — `member` and `victim` were created by the holder in beforeAll.
  const inA = await departmentUserIds(orgA);
  expect(inA).toEqual(expect.arrayContaining([member.id, victim.id]));
});

test('AXI-2734 AC1 FR18 — a holder naming an organization the grant does not cover gets 403 and nothing is written @SI-010', async () => {
  // Arrange — a real organization the holder is not a member of.
  const outside = await createOrganization(stranger, strangerId);
  const email = newEmail('outside');

  // Act
  const res = await attempt(holder, 'post', '/api/v1/users', { email, password: PASSWORD, organizationId: outside });

  // Assert
  expect(res.status, JSON.stringify(res.body)).toBe(403);
  const retry = await attempt(holder, 'post', '/api/v1/users', { email, password: PASSWORD, organizationId: orgA });
  expect(retry.status, JSON.stringify(retry.body)).toBe(201);
  toDetach.push(String(retry.body.id));
});

test('AXI-2734 FR20 BUG-6 — a member without user:update cannot attach a user to their organization @SI-010 @SI-013', async () => {
  // Act
  const res = await attempt(asMember, 'post', `/api/v1/organizations/${orgA}/department-users`, { userId: strangerId });

  // Assert
  expect(res.status, JSON.stringify(res.body)).toBe(403);
  expect(await departmentUserIds(orgA)).not.toContain(strangerId);
});

test('AXI-2734 FR20 — a user:update holder cannot attach an arbitrary user id they do not administer @SI-010 @SI-013', async () => {
  // Act — the stranger belongs to no organization the holder administers.
  const res = await attempt(holder, 'post', `/api/v1/organizations/${orgA}/department-users`, { userId: strangerId });

  // Assert
  expect(res.status, JSON.stringify(res.body)).toBe(403);
  expect(await departmentUserIds(orgA)).not.toContain(strangerId);
});

test('AXI-2734 FR20 — a member without user:update cannot detach another member @SI-010 @SI-013', async () => {
  // Act
  const res = await attempt(asMember, 'delete', `/api/v1/organizations/${orgA}/department-users/${victim.id}`);

  // Assert
  expect(res.status, JSON.stringify(res.body)).toBe(403);
  expect(await departmentUserIds(orgA)).toContain(victim.id);
});

test('AXI-2734 FR20 — a user:update holder over the organization and the user detaches them @SI-010 @SI-013', async () => {
  // Act
  const res = await attempt(holder, 'delete', `/api/v1/organizations/${orgA}/department-users/${victim.id}`);

  // Assert
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  expect(await departmentUserIds(orgA)).not.toContain(victim.id);
});

test('AXI-2734 FR17 — the platform admin keeps creating users in a named organization @SI-010', async () => {
  test.skip(!HAS_PLATFORM_ADMIN, 'needs E2E_TEST_EMAIL / E2E_TEST_PASSWORD (platform admin)');
  // Arrange
  const admin = await roleContext('admin');
  const org = await createOrganization(admin, await whoAmI(admin));

  // Act
  const created = await send(admin, 'post', '/api/v1/users', { email: newEmail('admin'), password: PASSWORD, organizationId: org });

  // Assert
  const rows = await send(admin, 'get', `/api/v1/organizations/${org}/department-users`);
  expect((rows ?? []).map((r: any) => String(r.userId ?? r.user?.id ?? r.id))).toContain(String(created.id));
  await admin.dispose();
});

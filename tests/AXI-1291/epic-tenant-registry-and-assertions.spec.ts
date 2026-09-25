import { test, expect, request as apiRequest } from '@playwright/test';
import { adminApi, workspaceHeader, asList, type Api } from '../AXI-1435/harness/api';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';
import {
  STABLE_TENANT_ID,
  ensureOrgAndWorkspace,
  suspendForeignConflicts,
  ensureAdminOrgTenant,
} from './harness/tenants';

/**
 * AXI-1291 — Tenant Segregation Phase 1: Control Plane & Tenant Registry
 * (epic acceptance, API-only). manual-e2e/AXI-1291-*.md — @SI-010 @SI-043.
 *
 * Drives the admin-only registry (`GET/POST/PATCH /tenants`, FR2/AC5), the
 * FR24 organization-mirror bridge, and the FR3/FR4/FR6 assertion issue/verify/
 * revoke lifecycle for a STABLE per-organization tenant reused across runs
 * (`STABLE_TENANT_ID`, see `harness/tenants.ts` for why a fresh tenant per run
 * would break the "exactly one active tenant" invariant the issue route
 * enforces). Serial: later steps (suspend/reactivate) depend on state earlier
 * steps establish.
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });

let api: Api;
let orgId: string;
let workspaceId: string;
let headers: Record<string, string>;
let foreignActiveReason: string | undefined;
let issuedToken: string | undefined;

test.beforeAll(async () => {
  api = await adminApi();
  const tenant = await ensureOrgAndWorkspace(api);
  orgId = tenant.orgId;
  workspaceId = tenant.workspaceId;
  headers = workspaceHeader(workspaceId);
  foreignActiveReason = await suspendForeignConflicts(api, orgId);
  await ensureAdminOrgTenant(api, orgId);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test('FR2 AC5 — register a tenant for a freshly created organization, list and fetch it', async () => {
  const org = await api.post('/api/v1/organizations', {
    name: `AXI-1291 fresh org ${Date.now()}`,
    type: 'biotech',
  });
  expect(org.status, `create fresh org: ${JSON.stringify(org.body)}`).toBeLessThan(300);

  const freshTenantId = `e2e-1291-fresh-${Date.now()}`;
  const create = await api.post('/api/v1/tenants', {
    tenantId: freshTenantId,
    organizationId: org.body.id,
    displayName: 'AXI-1291 fresh tenant',
    residency: 'eu-west-3',
  });
  expect(create.status, `create tenant: ${JSON.stringify(create.body)}`).toBe(201);
  expect(create.body.tenantId).toBe(freshTenantId);

  const list = await api.get('/api/v1/tenants?limit=100');
  expect(list.status).toBe(200);
  expect(asList(list.body).some((t: any) => t.tenantId === freshTenantId), 'appears in GET /tenants').toBe(true);

  const fetched = await api.get(`/api/v1/tenants/${freshTenantId}`);
  expect(fetched.status).toBe(200);
  expect(fetched.body.tenantId).toBe(freshTenantId);
  expect(fetched.body.organizationId).toBe(org.body.id);
});

test('FR2 — registering a duplicate tenantId is refused with 409', async () => {
  const dup = await api.post('/api/v1/tenants', {
    tenantId: STABLE_TENANT_ID,
    organizationId: orgId,
    displayName: 'duplicate attempt',
    residency: 'eu-west-3',
  });
  expect(dup.status, `duplicate registration: ${JSON.stringify(dup.body)}`).toBe(409);
});

test('FR24 — registering against an organizationId unknown to the platform is refused with 404', async () => {
  const res = await api.post('/api/v1/tenants', {
    tenantId: `e2e-1291-unknown-org-${Date.now()}`,
    organizationId: '00000000-0000-4000-8000-000000000000',
    displayName: 'unknown org tenant',
    residency: 'eu-west-3',
  });
  expect(res.status, `unknown-organization registration: ${JSON.stringify(res.body)}`).toBe(404);
});

test('FR3 AC4 — issue a tenant assertion for the admin-org tenant and verify it', async () => {
  test.skip(!!foreignActiveReason, foreignActiveReason ?? '');

  const issue = await api.post('/api/v1/tenant-assertions', {}, headers);
  expect(issue.status, `issue: ${JSON.stringify(issue.body)}`).toBeLessThan(300);
  const token: string = issue.body.token;
  expect(token, 'token present').toBeTruthy();
  issuedToken = token;

  // Decode (no verification needed client-side — this asserts the WIRE shape,
  // the server already verified it) rather than trusting the response's own
  // `claims` echo, so alg/TTL are checked at the same layer a real consumer
  // would see them.
  const [headerB64, payloadB64] = token.split('.');
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  expect(header.alg).toBe('HS256');
  expect(payload.exp - payload.iat).toBeLessThanOrEqual(300);
  expect(payload.tenant_id).toBe(STABLE_TENANT_ID);

  const verify = await api.post('/api/v1/tenant-assertions/verify', { token });
  expect(verify.status).toBeLessThan(300);
  expect(verify.body.valid, `verify: ${JSON.stringify(verify.body)}`).toBe(true);
});

test('FR6 AC6 — suspending the tenant blocks new issuance and invalidates outstanding verification; reactivating restores both', async () => {
  test.skip(!!foreignActiveReason, foreignActiveReason ?? '');
  test.skip(!issuedToken, 'no token issued by the previous step to re-verify');

  const suspend = await api.patch(`/api/v1/tenants/${STABLE_TENANT_ID}`, { status: 'suspended' });
  expect(suspend.status, `suspend: ${JSON.stringify(suspend.body)}`).toBeLessThan(300);

  const issueAfterSuspend = await api.post('/api/v1/tenant-assertions', {}, headers);
  expect(issueAfterSuspend.status, `issue after suspend: ${JSON.stringify(issueAfterSuspend.body)}`).toBe(403);

  const verifyAfterSuspend = await api.post('/api/v1/tenant-assertions/verify', { token: issuedToken });
  expect(verifyAfterSuspend.body.valid, `verify after suspend: ${JSON.stringify(verifyAfterSuspend.body)}`).toBe(false);

  const reactivate = await api.patch(`/api/v1/tenants/${STABLE_TENANT_ID}`, { status: 'active' });
  expect(reactivate.status, `reactivate: ${JSON.stringify(reactivate.body)}`).toBeLessThan(300);

  const issueAfterReactivate = await api.post('/api/v1/tenant-assertions', {}, headers);
  expect(issueAfterReactivate.status, `issue after reactivate: ${JSON.stringify(issueAfterReactivate.body)}`).toBeLessThan(300);

  // Left ACTIVE on purpose: this is the stable, reused admin-org tenant, and a
  // suite that left it suspended would 403 every other epic's issuance calls
  // against this org for the rest of the day, not just re-suspend cleanly on
  // its own next run (which `ensureAdminOrgTenant` reactivates anyway).
});

test('AC5 — a non-admin caller is denied the tenant registry (deny-by-default)', async () => {
  const userRole = ROLES.find((r) => r.name === 'user');
  test.skip(!userRole, 'harness has no non-admin role registered to use as a non-platform-admin caller');

  const bootstrap = await apiRequest.newContext();
  const tokens = await ensureAuthTokens(bootstrap, userRole!);
  await bootstrap.dispose();

  const ctx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` } });
  try {
    const res = await ctx.get(apiUrl('/api/v1/tenants'));
    expect(res.status(), 'non-platform-admin caller is denied the tenant registry').toBe(403);
  } finally {
    await ctx.dispose();
  }
});

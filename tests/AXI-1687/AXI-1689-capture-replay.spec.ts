import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, workspaceHeader, type Api } from '../AXI-1435/harness/api';
import { ensureTenant } from '../AXI-1435/harness/seed';

/**
 * AXI-1689 — F·W1 Capture, replay and zero-spend evaluation (epic AXI-1687).
 * Scenarios F.1 and F.2 of `axiome-docs/manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md`.
 *
 * API-only and ZERO-SPEND BY CONSTRUCTION (NFR1/AC121): every request here goes
 * to the debug-mode read-back route or to a stack whose planner provider is the
 * deterministic fallback; no planner conversation with a provider is ever
 * started, `E2E_LIVE_LLM` and `GUIDED_ANALYSIS_LIVE_SPEND_GO` are asserted
 * unset in this very process, and the capture table is asserted EMPTY at the
 * end — a served stack with the guard unset is unchanged (EC36) and a fallback
 * plan captures nothing.
 *
 * F.1 (FR48, AC48, AC130) — read-back `GET /guided-analysis/projects/:projectId/intent-attempts`
 *   is behind `@RequireDebugMode()`: 200 with `{ items, page, limit, total,
 *   retentionDays: 180 }` for a debugMode holder who is a member of the
 *   project's workspace; 403 for a caller with no debugMode role; 401
 *   anonymous; not found for a project outside the caller's workspaces (the
 *   tenancy wall sits in the organization service, keyed on the VERIFIED
 *   caller, never on the body); 400 for a malformed page/limit at the gateway.
 * F.2 (EC36, FR53) — a plan request on a stack with the guard unset goes
 *   through the configured provider unchanged and writes no capture row.
 *
 * Everything is self-provisioned per run (the AXI-1685 precedent): a throwaway
 * debugMode role, a throwaway self-registered holder assigned to it and added
 * to the tenant workspace, a second workspace+project the holder is NOT a
 * member of, and cleanup at the end. The platform admin is the NON-holder: it
 * never receives a debugMode role in this spec, so the gateway's 60 s
 * DebugModeResolver cache can only ever hold `false` for it.
 */

interface Tokens { accessToken: string; refreshToken: string }

async function send(
  api: APIRequestContext,
  method: 'post' | 'patch' | 'delete' | 'get',
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<any> {
  const res = await api[method](apiUrl(path), { data: body as any, headers });
  if (!res.ok()) {
    throw new Error(`AXI-1689 fixture ${method.toUpperCase()} ${path} -> ${res.status()}: ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function login(email: string, password: string): Promise<Tokens> {
  const bootstrap = await apiRequest.newContext();
  try {
    return await send(bootstrap, 'post', '/api/v1/auth/login', { email, password });
  } finally {
    await bootstrap.dispose();
  }
}

async function registerHolder(): Promise<{ userId: string; email: string; password: string }> {
  const email = `axi1689-${Date.now()}@axiome.local`;
  const password = 'AXI1689-e2e-pw!';
  const bootstrap = await apiRequest.newContext();
  try {
    const tokens: Tokens = await send(bootstrap, 'post', '/api/v1/auth/register', {
      email,
      password,
      firstName: 'AXI1689',
      lastName: 'Holder',
    });
    const registered = await apiRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    try {
      const me = await send(registered, 'get', '/api/v1/auth/me');
      return { userId: me.id, email, password };
    } finally {
      await registered.dispose();
    }
  } finally {
    await bootstrap.dispose();
  }
}

function attemptsPath(projectId: string, query = ''): string {
  return `/api/v1/guided-analysis/projects/${projectId}/intent-attempts${query}`;
}

const RETENTION_DAYS = 180;

test.describe.configure({ mode: 'serial' });

test.describe(
  'AXI-1689 — capture read-back behind debug mode + zero-spend served stack (F.1, F.2)',
  { tag: ['@SI-000', '@SI-010', '@SI-042', '@SI-045'] },
  () => {
    let admin: Api;
    let workspaceId: string;
    let projectId: string;
    let roleId: string;
    let holderUserId: string;
    let holderApi: APIRequestContext;
    let otherWorkspaceId: string;
    let otherProjectId: string;

    test.beforeAll(async () => {
      admin = await adminApi();
      const tenant = await ensureTenant(admin);
      workspaceId = tenant.workspaceId;
      projectId = tenant.projectId;

      // A throwaway role with debugMode ON, held by a throwaway user who is a
      // plain member of the tenant workspace.
      const role = await send(admin.ctx, 'post', '/api/v1/roles', {
        name: `E2E AXI-1689 Debug Role ${Date.now()}`,
        scope: 'SYSTEM',
        permissions: [],
        debugMode: true,
      });
      roleId = role.id;
      const holder = await registerHolder();
      holderUserId = holder.userId;
      await send(admin.ctx, 'post', `/api/v1/users/${holderUserId}/roles`, { roleId });
      await send(
        admin.ctx,
        'post',
        `/api/v1/workspaces/${workspaceId}/members`,
        { userId: holderUserId, organizationId: tenant.orgId, role: 'editor' },
        workspaceHeader(workspaceId),
      );
      const tokens = await login(holder.email, holder.password);
      holderApi = await apiRequest.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` },
      });

      // A second workspace + project the holder is NOT a member of.
      const other = await send(admin.ctx, 'post', '/api/v1/workspaces', {
        name: `AXI-1689 other tenant ${Date.now()}`,
        type: 'internal',
        ownerOrganizationId: tenant.orgId,
      });
      otherWorkspaceId = other.id;
      const otherProject = await send(
        admin.ctx,
        'post',
        '/api/v1/projects',
        { name: 'AXI-1689 other project', workspaceId: otherWorkspaceId },
        workspaceHeader(otherWorkspaceId),
      );
      otherProjectId = otherProject.id;
    });

    test.afterAll(async () => {
      await send(admin.ctx, 'delete', `/api/v1/users/${holderUserId}/roles/${roleId}`).catch(() => {});
      await send(admin.ctx, 'delete', `/api/v1/roles/${roleId}`).catch(() => {});
      await holderApi?.dispose();
      await admin?.ctx.dispose();
    });

    test('NFR1/AC121 — this run carries neither the live opt-in nor a live-spend go: nothing here can spend', async () => {
      expect(process.env.E2E_LIVE_LLM).toBeUndefined();
      expect(process.env.GUIDED_ANALYSIS_LIVE_SPEND_GO).toBeUndefined();
    });

    test('AC48/AC130 F.1 — a debugMode holder reads back the project’s attempt page with the 180-day retention stated', async () => {
      const res = await holderApi.get(apiUrl(attemptsPath(projectId)), { headers: workspaceHeader(workspaceId) });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ page: 1, limit: 20, retentionDays: RETENTION_DAYS });
      expect(Array.isArray(body.items)).toBe(true);
      expect(typeof body.total).toBe('number');
      // No compiled-planner conversation has ever run on this stack: the page
      // is EMPTY, which is the honest shape (never a fabricated row).
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });

    test('AC130 F.1 — a caller with no debugMode role is refused (403) even as platform admin', async () => {
      const res = await admin.get(attemptsPath(projectId), workspaceHeader(workspaceId));
      expect(res.status).toBe(403);
    });

    test('AC130 F.1 — an anonymous caller is 401', async () => {
      const anon = await apiRequest.newContext();
      try {
        const res = await anon.get(apiUrl(attemptsPath(projectId)), { headers: workspaceHeader(workspaceId) });
        expect(res.status()).toBe(401);
      } finally {
        await anon.dispose();
      }
    });

    test('AC48 F.1 — a project outside the holder’s workspaces is not found: tenancy is asserted on the VERIFIED caller in the organization service', async () => {
      const res = await holderApi.get(apiUrl(attemptsPath(otherProjectId)), {
        headers: workspaceHeader(workspaceId),
      });
      expect([403, 404]).toContain(res.status());
      const unknown = await holderApi.get(apiUrl(attemptsPath('00000000-0000-4000-8000-000000000000')), {
        headers: workspaceHeader(workspaceId),
      });
      expect([403, 404]).toContain(unknown.status());
    });

    test('F.1 — a malformed page or limit is a 400 at the gateway, never a NaN reaching the store', async () => {
      for (const query of ['?limit=0', '?limit=abc', '?page=0', '?page=-1']) {
        const res = await holderApi.get(apiUrl(attemptsPath(projectId, query)), {
          headers: workspaceHeader(workspaceId),
        });
        expect(res.status(), query).toBe(400);
      }
    });

    test('EC36 F.2 — a plan request on a stack with the guard unset is served unchanged by the configured provider and captures NOTHING', async () => {
      const envelope = {
        projectId,
        question: 'AXI-1689 EC36 — does the served stack plan unchanged with the guard unset?',
        sendData: false,
        context: { scientificContext: 'AXI-1689 zero-spend E2E' },
        datasets: [],
      };
      const planned = await admin.post(
        '/api/v1/guided-analysis/plan',
        { projectId, envelope },
        workspaceHeader(workspaceId),
      );
      expect(planned.status, JSON.stringify(planned.body)).toBeLessThan(300);
      expect(planned.body.plan).toBeTruthy();
      // The response is the planner's own statement, never a deadline (FR51)
      // and never an error dressed as a plan.
      expect(planned.body.unsupportedReason).not.toBe('deadline');

      const after = await holderApi.get(apiUrl(attemptsPath(projectId)), { headers: workspaceHeader(workspaceId) });
      expect(after.status()).toBe(200);
      const body = await after.json();
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });
  },
);

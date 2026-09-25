import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { request as apiRequest } from '@playwright/test';
import { ensureAuthTokens } from '../../config/auth';
import { workspaceHeader } from '../AXI-1400/harness/api';
import { arrange, apiWith, disposeArranged, type Arranged } from './harness/session';
import { seedFinalizedEvidence, uniq, type Tenant } from './harness/seed';
import type { Api } from '../AXI-1400/harness/api';

/**
 * AXI-1667: an evidence id that exists in ANOTHER tenant must answer exactly like
 * an id that does not exist (no existence oracle). Scenario E2E-1640-J1.
 * Tenant B = a freshly self-registered user with its own org/workspace/project.
 */
test.use({ storageState: { cookies: [], origins: [] } });

let ctx: Arranged;
let b: { api: Api; workspaceId: string; projectId: string };

test.beforeAll(async () => {
  ctx = await arrange();
  const role = { name: 'user' as const, email: `e2e-tenant-b-${uniq()}@axiome.local`, password: 'E2eTenantB!23', selfRegister: true };
  const boot = await apiRequest.newContext();
  const tokens = await ensureAuthTokens(boot, role as any);
  await boot.dispose();
  const api = await apiWith(tokens.accessToken);
  const org = await api.post('/api/v1/organizations', { name: `AXI-1667 B Org ${uniq()}`, type: 'biotech' });
  const ws = await api.post('/api/v1/workspaces', { name: `AXI-1667 B WS ${uniq()}`, type: 'internal', ownerOrganizationId: org.body.id });
  const project = await api.post('/api/v1/projects', { name: `AXI-1667 B Proj ${uniq()}`, workspaceId: ws.body.id }, workspaceHeader(ws.body.id));
  b = { api, workspaceId: ws.body.id, projectId: project.body.id };
});
test.afterAll(async () => { await b?.api.ctx.dispose(); await disposeArranged(ctx); });

/** Tenant B asks for `id`; returns status + body with the asked id normalised out. */
async function askAsB(id: string) {
  const res = await b.api.get(
    `/api/v1/de-evidence-references/${id}?workspace_id=${b.workspaceId}&project_id=${b.projectId}`,
    workspaceHeader(b.workspaceId),
  );
  const { timestamp, path, ...rest } = res.body ?? {};
  return { status: res.status, body: JSON.stringify(rest).split(id).join('<ID>'), path: String(path ?? '').split(id).join('<ID>') };
}

test('AC10 @SI-030 — E2E-1640-J1: a cross-tenant evidence id answers the same 404 as a nonexistent id', async () => {
  const foreign = await seedFinalizedEvidence(ctx.api, ctx.t as Tenant);
  const own = await ctx.api.get(
    `/api/v1/de-evidence-references/${foreign.evidence_id}?workspace_id=${ctx.t.workspaceId}&project_id=${ctx.t.projectId}`, ctx.t.headers);
  expect(own.status).toBe(200); // the id is real for its own tenant

  const cross = await askAsB(foreign.evidence_id);
  const missing = await askAsB(randomUUID());
  expect(missing.status).toBe(404);
  expect(cross.status).toBe(404);
  expect(cross.body).toBe(missing.body);
  expect(cross.path).toBe(missing.path);
});

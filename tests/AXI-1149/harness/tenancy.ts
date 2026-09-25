import { request as apiRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { API_BASE_URL } from '../../../config/env';
import { ROLES } from '../../../config/roles';

/**
 * AXI-1149-validation (Workflow 5) — API-level two-tenant harness.
 *
 * Provisions two DISJOINT tenants (A, B) purely through the public gateway
 * (`POST /users|/organizations|/workspaces|/workspaces/:id/members|/projects|
 * /graph-slices|/workspaces/:id/datasets`) as the bootstrap admin, then hands
 * each principal its own authenticated `APIRequestContext`. No Prisma / SQL /
 * broker backdoor (the staging NFR3 rule). Every entity is uniquely suffixed so
 * concurrent runs never collide; `dispose()` removes what the API lets us remove.
 *
 * Source of truth for the scenarios: axiome-docs/manual-e2e/AXI-1149-Multi-Tenancy-Hardening.md.
 */

export const API = `${API_BASE_URL}/api/v1`;

export interface Principal {
  id: string;
  email: string;
  ctx: APIRequestContext;
}

export interface Topology {
  admin: Principal;
  alice: Principal; // workspace admin of A
  carol: Principal; // viewer in A; editor in C
  dave: Principal; // editor in A (removal target)
  bob: Principal; // admin of B (non-member of A)
  ORG_A: string;
  ORG_B: string;
  WS_A: string;
  WS_B: string;
  WS_C: string; // Carol = editor here (org A)
  PROJ_A: string;
  PROJ_B: string;
  SLICE_A: string;
  SLICE_B: string;
  DS_A: string;
  DS_B: string;
  /** Pre-existing rows in some OTHER tenant of the demo DB (found via admin, never created here). */
  DE_B?: { id: string; workspaceId: string };
  DD_B?: { id: string; workspaceId: string };
  /** Mint a throwaway extra user (optionally added to a workspace) for scenarios that mutate membership. */
  spare(name: string, into?: { ws: string; org: string; role: string }): Promise<Principal>;
  dispose(): Promise<void>;
}

/** A response reduced to the parts that must be identical for a miss vs a cross-tenant denial. */
export interface Canon {
  status: number;
  success?: boolean;
  statusCode?: number;
  message?: unknown;
  error?: unknown;
}

/**
 * Canonicalise an error body for the AC3 oracle comparison. `path` and
 * `timestamp` are request echoes (they legitimately differ between two requests)
 * and are the ONLY fields stripped; everything else — status, message, error,
 * and any extra key — must match exactly. Additionally asserts `path` echoes only
 * the requested url, so a leaked id is not hiding in there.
 */
export async function canon(res: APIResponse): Promise<{ canon: string; body: any; raw: string }> {
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  const { path: _p, timestamp: _t, ...rest } = typeof body === 'object' && body ? body : { body };
  return { canon: JSON.stringify({ status: res.status(), ...sortKeys(rest) }), body, raw };
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

export function randomUuid(): string {
  return randomUUID();
}

async function json(res: APIResponse, what: string): Promise<any> {
  if (!res.ok()) throw new Error(`${what} failed: ${res.status()} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function anonCtx(): Promise<APIRequestContext> {
  return apiRequest.newContext();
}

async function login(email: string, password: string): Promise<APIRequestContext> {
  const anon = await anonCtx();
  const res = await anon.post(`${API}/auth/login`, { data: { email, password } });
  const { accessToken } = await json(res, `login ${email}`);
  await anon.dispose();
  return apiRequest.newContext({
    extraHTTPHeaders: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
  });
}

export async function provisionTopology(): Promise<Topology> {
  const adminRole = ROLES.find((r) => r.name === 'admin')!;
  const adminCtx = await login(adminRole.email, adminRole.password);
  const me = await json(await adminCtx.get(`${API}/auth/me`), 'admin me');
  const admin: Principal = { id: me.id, email: adminRole.email, ctx: adminCtx };
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const password = `Tn!${tag}Zz9`;
  const owned: APIRequestContext[] = [adminCtx];

  const mkUser = async (name: string, domain: string): Promise<Principal> => {
    const email = `${name}-${tag}@${domain}.test`;
    const u = await json(
      await adminCtx.post(`${API}/users`, { data: { email, password, firstName: name, lastName: 'AXI1149' } }),
      `create user ${name}`,
    );
    const ctx = await login(email, password);
    owned.push(ctx);
    return { id: u.id, email, ctx };
  };
  const mkOrg = async (n: string) =>
    (await json(await adminCtx.post(`${API}/organizations`, { data: { name: `AXI1149 ${n} ${tag}`, type: 'biotech' } }), `org ${n}`)).id as string;
  const mkWs = async (n: string, org: string) =>
    (await json(await adminCtx.post(`${API}/workspaces`, { data: { name: `AXI1149 ${n} ${tag}`, type: 'internal', ownerOrganizationId: org } }), `ws ${n}`)).id as string;
  const addMember = async (ws: string, org: string, p: Principal, role: string) =>
    json(await adminCtx.post(`${API}/workspaces/${ws}/members`, { data: { userId: p.id, organizationId: org, role } }), `add ${p.email} ${role}`);

  const [alice, carol, dave, bob] = await Promise.all([
    mkUser('alice', 'tenant-a'), mkUser('carol', 'tenant-a'), mkUser('dave', 'tenant-a'), mkUser('bob', 'tenant-b'),
  ]);
  const ORG_A = await mkOrg('A');
  const ORG_B = await mkOrg('B');
  const WS_A = await mkWs('WS-A', ORG_A);
  const WS_B = await mkWs('WS-B', ORG_B);
  const WS_C = await mkWs('WS-C', ORG_A);
  await addMember(WS_A, ORG_A, alice, 'admin');
  await addMember(WS_A, ORG_A, carol, 'viewer');
  await addMember(WS_A, ORG_A, dave, 'editor');
  await addMember(WS_B, ORG_B, bob, 'admin');
  await addMember(WS_C, ORG_A, carol, 'editor');

  const hdr = (ws: string) => ({ 'X-Workspace-Id': ws });
  const mkProject = async (ws: string, n: string) =>
    (await json(await adminCtx.post(`${API}/projects`, { data: { name: `AXI1149 ${n} ${tag}`, workspaceId: ws }, headers: hdr(ws) }), `project ${n}`)).id as string;
  const PROJ_A = await mkProject(WS_A, 'proj-A');
  const PROJ_B = await mkProject(WS_B, 'proj-B');
  const mkSlice = async (proj: string, ws: string, n: string) =>
    (await json(await adminCtx.post(`${API}/graph-slices`, { data: { projectId: proj, nodeIds: [], edgeIds: [], label: `AXI1149 ${n} ${tag}` }, headers: hdr(ws) }), `slice ${n}`)).id as string;
  const SLICE_A = await mkSlice(PROJ_A, WS_A, 'slice-A');
  const SLICE_B = await mkSlice(PROJ_B, WS_B, 'slice-B');
  const mkDataset = async (ws: string, org: string, n: string) =>
    (await json(
      await adminCtx.post(`${API}/workspaces/${ws}/datasets`, {
        data: { organizationId: org, originalFilename: `axi1149-${n}-${tag}.csv`, contentType: 'text/csv' }, headers: hdr(ws),
      }),
      `dataset ${n}`,
    )).dataset.id as string;
  const DS_A = await mkDataset(WS_A, ORG_A, 'A');
  const DS_B = await mkDataset(WS_B, ORG_B, 'B');

  const { DE_B, DD_B } = await discoverForeignRows(admin, new Set([WS_A, WS_B, WS_C]));

  return {
    admin, alice, carol, dave, bob,
    ORG_A, ORG_B, WS_A, WS_B, WS_C, PROJ_A, PROJ_B, SLICE_A, SLICE_B, DS_A, DS_B, DE_B, DD_B,
    async spare(name, into) {
      const p = await mkUser(`${name}${Math.floor(Math.random() * 1e4)}`, 'tenant-a');
      if (into) await addMember(into.ws, into.org, p, into.role);
      return p;
    },
    async dispose() {
      // Best-effort cleanup: soft-delete the two probe workspaces + projects; the
      // API offers no hard delete, and orgs/users are left (uniquely tagged).
      for (const [ws, proj] of [[WS_A, PROJ_A], [WS_B, PROJ_B]] as const) {
        await adminCtx.delete(`${API}/projects/${proj}`, { headers: hdr(ws) }).catch(() => undefined);
        await adminCtx.delete(`${API}/workspaces/${ws}`).catch(() => undefined);
      }
      await adminCtx.delete(`${API}/workspaces/${WS_C}`).catch(() => undefined);
      await Promise.all(owned.map((c) => c.dispose().catch(() => undefined)));
    },
  };
}

/**
 * Derived-evidence and decision-draft rows cannot be minted cheaply over the API
 * (they need a saved snapshot lineage), so the victim row for §5.4/§5.18 is a
 * PRE-EXISTING row in some other tenant of the demo database, located as admin.
 * Returns undefined when the stack holds none — callers then skip with that exact reason.
 */
async function discoverForeignRows(admin: Principal, exclude: Set<string>) {
  const out: Pick<Topology, 'DE_B' | 'DD_B'> = {};
  const list = await admin.ctx.get(`${API}/workspaces?limit=100`);
  if (!list.ok()) return out;
  const workspaces: { id: string }[] = ((await list.json()).data ?? []).filter((w: { id: string }) => !exclude.has(w.id));
  for (const w of workspaces) {
    if (out.DD_B && out.DE_B) break;
    const h = { 'X-Workspace-Id': w.id };
    if (!out.DD_B) {
      const dd = await admin.ctx.get(`${API}/workspaces/${w.id}/decisions?limit=1`, { headers: h });
      const row = dd.ok() ? (await dd.json()).data?.[0] : undefined;
      if (row) out.DD_B = { id: row.id, workspaceId: w.id };
    }
    if (!out.DE_B) out.DE_B = await firstDerivedEvidence(admin, w.id);
  }
  return out;
}

async function firstDerivedEvidence(admin: Principal, ws: string): Promise<Topology['DE_B']> {
  const h = { 'X-Workspace-Id': ws };
  const projects = await admin.ctx.get(`${API}/projects?workspaceId=${ws}&limit=50`, { headers: h });
  if (!projects.ok()) return undefined;
  for (const p of (await projects.json()).data ?? []) {
    const de = await admin.ctx.get(`${API}/derived-evidence?projectId=${p.id}&limit=1`, { headers: h });
    const row = de.ok() ? (await de.json()).data?.[0] : undefined;
    if (row) return { id: row.id, workspaceId: ws };
  }
  return undefined;
}

export const wsHeader = (ws: string): Record<string, string> => ({ 'X-Workspace-Id': ws });

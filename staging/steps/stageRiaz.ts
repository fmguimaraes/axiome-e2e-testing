import { RestClient } from '../client/RestClient';
import { TENANT_FIXTURE } from '../fixtures/tenantFixture';
import { ADMIN_HANDLE } from './context';
import { stageTenant } from './stage';
import type { TenantFixture } from '../fixtures/types';

/**
 * Headless staging of the Riaz 2017 demo project (the "Riaz RNA-Seq Volcano"
 * demo script, Confluence 166789121) onto the public-benchmark project the
 * frontend serves at
 * `/biotech-one/public-datasets-io-benchmarks/riaz-2017-nivolumab-melanoma/overview`.
 *
 * Same step graph as `stage.ts`; the only difference is WHERE the content
 * lands. `TENANT_FIXTURE` binds its datasets (and therefore the analysis,
 * charts, snapshots, evidence, publish, export) to the
 * `Translational Immuno-Oncology / Melanoma IO cohort` corpus. This entry
 * re-points every `content.datasets[]` entry at the workspace/project named
 * below and drops the sibling workspace so nothing else in the tenant is
 * touched. Idempotent like `stage`: a re-run reuses what already exists.
 *
 * Override the target with STAGING_RIAZ_WORKSPACE / STAGING_RIAZ_PROJECT
 * (both must be names the fixture declares).
 */
const WORKSPACE = process.env.STAGING_RIAZ_WORKSPACE?.trim() || 'Public Datasets — IO Benchmarks';
const PROJECT = process.env.STAGING_RIAZ_PROJECT?.trim() || 'Riaz 2017 — Nivolumab Melanoma';

export function riazFixture(base: TenantFixture = TENANT_FIXTURE): TenantFixture {
  return {
    ...base,
    workspaces: base.workspaces.filter((w) => w.name === WORKSPACE).map((w) => ({ ...w, retiredProjects: [] })),
    content: {
      ...base.content,
      datasets: base.content.datasets.map((d) => ({ ...d, workspaceName: WORKSPACE, projectName: PROJECT })),
    },
  };
}

/**
 * The UI gates every analysis page on a SYSTEM role permission
 * (`view-analysis:view` etc. — `ProjectViewAnalysisDetail.tsx`'s `canView`),
 * not on workspace membership. `stage` grants the cast only workspace roles,
 * which is enough for its REST calls but leaves a presenter logging in as
 * Marc Ottavi on "Access denied". Grant the seeded role named here to every
 * cast identity so the staged tenant is also DEMO-ABLE in the browser.
 * `STAGING_RIAZ_DEMO_ROLE=""` skips it.
 */
const DEMO_ROLE = process.env.STAGING_RIAZ_DEMO_ROLE === undefined ? 'Super Admin' : process.env.STAGING_RIAZ_DEMO_ROLE.trim();
const CAST_HANDLES = ['cast-biologist', 'cast-bioinformatician', 'cast-clinician'];

interface RoleRow { id: string; name: string }
interface UserRoleRow { id?: string; roleId?: string; role?: { id: string } }

async function ensureCastDemoRole(client: RestClient): Promise<void> {
  if (!DEMO_ROLE) return;
  const roles = await client.as<{ data?: RoleRow[] } | RoleRow[]>(ADMIN_HANDLE, 'GET', '/api/v1/roles');
  if (!roles.ok) throw new Error(`listing roles failed (status ${roles.status})`);
  const list = Array.isArray(roles.body) ? roles.body : (roles.body?.data ?? []);
  const role = list.find((r) => r.name === DEMO_ROLE);
  if (!role) throw new Error(`demo role "${DEMO_ROLE}" not found — set STAGING_RIAZ_DEMO_ROLE to a seeded role name or "" to skip`);
  for (const handle of CAST_HANDLES) await grantRole(client, handle, role);
}

async function grantRole(client: RestClient, handle: string, role: RoleRow): Promise<void> {
  const me = await client.as<{ id: string }>(handle, 'GET', '/api/v1/auth/me');
  if (!me.ok || !me.body) throw new Error(`could not resolve "${handle}" (status ${me.status})`);
  const held = await client.as<{ data?: UserRoleRow[] } | UserRoleRow[]>(ADMIN_HANDLE, 'GET', `/api/v1/users/${me.body.id}/roles`);
  const heldList = Array.isArray(held.body) ? held.body : (held.body?.data ?? []);
  if (held.ok && heldList.some((r) => (r.roleId ?? r.role?.id ?? r.id) === role.id)) return;
  const res = await client.as(ADMIN_HANDLE, 'POST', `/api/v1/users/${me.body.id}/roles`, { roleId: role.id });
  if (!res.ok) throw new Error(`granting "${role.name}" to "${handle}" failed (status ${res.status})`);
  console.log(`[stage:riaz] granted role "${role.name}" to ${handle}`);
}

async function main(): Promise<void> {
  const baseUrl = (process.env.STAGING_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  const adminEmail = process.env.STAGING_ADMIN_EMAIL?.trim() || 'admin@axiome.local';
  const adminPassword = process.env.STAGING_ADMIN_PASSWORD?.trim() || 'admin';
  const client = new RestClient({ baseUrl });
  const touched = await stageTenant(client, riazFixture(), adminEmail, adminPassword);
  await ensureCastDemoRole(client);
  touched.forEach((t) => console.log(`[stage:riaz] ${t.action} ${t.kind} "${t.name}" (${t.id})`));
  console.log(`PASSED — stage:riaz converged on "${WORKSPACE}" / "${PROJECT}", ${touched.length} entity action(s).`);
}

if (process.argv[1] && process.argv[1].endsWith('stageRiaz.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

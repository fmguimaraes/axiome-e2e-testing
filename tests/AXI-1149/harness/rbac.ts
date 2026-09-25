import { request as apiRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as base } from './fixtures';
import { API, wsHeader, type Principal, type Topology } from './tenancy';

/**
 * AXI-1149-validation (Workflow 5) — rule-access / entitlement / audit harness
 * for §5.19–§5.22 (AC21–AC34). Provisions, through the public gateway only:
 *
 *  - a THROWAWAY platform-ADMIN principal (`radm`). PRECONDITION: the suite admin must
 *    carry a JWT `role` claim of ADMIN (`E2E_ADMIN_EMAIL=admin@axiome.local`, the suite
 *    default). `admin@cro-one.com` is Super Admin by role assignment only and its JWT role is
 *    USER, so it cannot `POST /roles` (ADMIN-only); provisionRbac fails fast on it. `radm` is
 *    still minted (`PATCH /users/:id {role:'ADMIN'}`) and deleted at dispose for isolation and
 *    cleanup only: every role/user/org-mode change is made by an identity that is removed
 *    afterwards, and the shared admin session is never used to mutate rule-access state.
 *    (It is a hygiene choice, not a capability requirement.)
 *  - three custom roles (none / rules / shared) and one user per role. Users are
 *    created BY `radm`: a user created by a non-admin caller is auto-placed in the
 *    CREATOR's own org departments (assignNewUserToOrganization), which would
 *    silently entitle it through those orgs and make an org-level NONE inert.
 *  - a dedicated org + workspace + project (`ORG_R`/`WS_R`/`PROJ_R`) so toggling
 *    the org's OrgRuleAccess mode never perturbs the shared two-tenant topology.
 *  - two ingested datasets (a QC fixture, and a subject-keyed one for STRATIFY),
 *    a published project-scope QC rule (cloned from seeded IMM-QC-01), and the
 *    seeded system rules IMM-QC-01 / STRATIFY-01.
 *
 * Rule permissions are resolved per user with a 60s gateway cache and no
 * invalidation, so each role state has its OWN user, assigned before first use.
 */

const FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-1474', 'fixtures');
const PASSWORD_SUFFIX = 'Zz9!';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RuleAccessMode = 'ALL' | 'NONE';

export interface Rbac {
  tag: string;
  radm: Principal;
  ORG_R: string;
  WS_R: string;
  PROJ_R: string;
  uNone: Principal;
  uRules: Principal;
  uShared: Principal;
  /** department-only member of ORG_R (DepartmentUser row, NO WorkspaceMember row) holding role-shared. */
  uDan: Principal;
  RULE_WS: string; // published project-scope QC_RULE in WS_R
  RULE_SYS: string; // seeded system QC rule IMM-QC-01
  RULE_STRAT: string; // seeded system STRATIFY-01
  DS_QC: string;
  DS_STRAT: string;
  h: Record<string, string>;
  setMode(mode: RuleAccessMode): Promise<void>;
  /** POST /rule-runs for a QC run of `ruleId` over DS_QC as `who`. */
  execQc(who: Principal, ruleId: string, extra?: Record<string, unknown>): Promise<APIResponse>;
  /** Lazily materialize (once) a STRATIFY-01 run as uShared while entitled; returns its RuleRun id. */
  stratRun(): Promise<string>;
  mkUser(name: string, opts?: { organizationId?: string }): Promise<Principal>;
  dispose(): Promise<void>;
}

async function json(res: APIResponse, what: string): Promise<any> {
  if (!res.ok()) throw new Error(`${what} failed: ${res.status()} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function login(email: string, password: string): Promise<APIRequestContext> {
  const anon = await apiRequest.newContext();
  const { accessToken } = await json(await anon.post(`${API}/auth/login`, { data: { email, password } }), `login ${email}`);
  await anon.dispose();
  return apiRequest.newContext({ extraHTTPHeaders: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' } });
}

export async function provisionRbac(topo: Topology): Promise<Rbac> {
  const admin = topo.admin;
  const adminMe = await json(await admin.ctx.get(`${API}/auth/me`), 'admin me (role precondition)');
  if (adminMe.role !== 'ADMIN') {
    throw new Error(
      `provisionRbac precondition failed: suite admin ${admin.email} has role ${adminMe.role}, need ADMIN. ` +
        'Run with E2E_ADMIN_EMAIL=admin@axiome.local (admin@cro-one.com is Super Admin by role assignment only; JWT role USER).',
    );
  }
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const password = `Rb!${tag}${PASSWORD_SUFFIX}`;
  const owned: APIRequestContext[] = [];
  const createdUsers: string[] = [];
  const createdRoles: string[] = [];

  // 1. throwaway platform ADMIN
  const radmUser = await json(
    await admin.ctx.post(`${API}/users`, { data: { email: `radm-${tag}@rbac.test`, password, firstName: 'radm', lastName: 'AXI1149' } }),
    'create radm',
  );
  createdUsers.push(radmUser.id);
  await json(await admin.ctx.patch(`${API}/users/${radmUser.id}`, { data: { role: 'ADMIN' } }), 'promote radm');
  const radmCtx = await login(`radm-${tag}@rbac.test`, password);
  owned.push(radmCtx);
  const radm: Principal = { id: radmUser.id, email: `radm-${tag}@rbac.test`, ctx: radmCtx };

  const mkUser = async (name: string, opts: { organizationId?: string } = {}): Promise<Principal> => {
    const email = `${name}-${tag}@rbac.test`;
    const u = await json(
      await radmCtx.post(`${API}/users`, {
        data: { email, password, firstName: name, lastName: 'AXI1149', ...(opts.organizationId ? { organizationId: opts.organizationId } : {}) },
      }),
      `create user ${name}`,
    );
    createdUsers.push(u.id);
    const ctx = await login(email, password);
    owned.push(ctx);
    return { id: u.id, email, ctx };
  };
  const mkRole = async (n: string, permissions: string[]) => {
    const r = await json(
      await radmCtx.post(`${API}/roles`, { data: { name: `axi1149-${n}-${tag}`, scope: 'ORGANIZATION', permissions } }),
      `role ${n}`,
    );
    createdRoles.push(r.id);
    return r.id as string;
  };
  const assign = async (u: Principal, roleId: string) => {
    const res = await radmCtx.post(`${API}/users/${u.id}/roles`, { data: { roleId } });
    if (res.status() >= 300) throw new Error(`assign role failed: ${res.status()} ${await res.text()}`);
  };

  // 2. dedicated tenant
  const ORG_R = (await json(await admin.ctx.post(`${API}/organizations`, { data: { name: `AXI1149 R ${tag}`, type: 'biotech' } }), 'org R')).id as string;
  const WS_R = (
    await json(await admin.ctx.post(`${API}/workspaces`, { data: { name: `AXI1149 RW ${tag}`, type: 'internal', ownerOrganizationId: ORG_R } }), 'ws R')
  ).id as string;
  const h = wsHeader(WS_R);
  const PROJ_R = (await json(await admin.ctx.post(`${API}/projects`, { data: { name: `AXI1149 rp ${tag}`, workspaceId: WS_R }, headers: h }), 'project R')).id as string;

  // 3. roles + users (created by radm so they carry NO inherited org departments)
  const [roleNone, roleRules, roleShared] = await Promise.all([
    mkRole('none', ['dataset:read']),
    mkRole('rules', ['rule:read', 'rule:evaluate']),
    mkRole('shared', ['rule:read', 'rule:evaluate', 'rule:view_shared']),
  ]);
  const [uNone, uRules, uShared] = await Promise.all([mkUser('unone'), mkUser('urules'), mkUser('ushared')]);
  const uDan = await mkUser('udan', { organizationId: ORG_R });
  await assign(uNone, roleNone);
  await assign(uRules, roleRules);
  await assign(uShared, roleShared);
  await assign(uDan, roleShared);
  for (const u of [uNone, uRules, uShared]) {
    await json(await admin.ctx.post(`${API}/workspaces/${WS_R}/members`, { data: { userId: u.id, organizationId: ORG_R, role: 'editor' } }), `member ${u.email}`);
  }

  const setMode = async (mode: RuleAccessMode) => {
    await json(await radmCtx.put(`${API}/organizations/${ORG_R}/rule-access/mode`, { data: { mode } }), `set mode ${mode}`);
  };
  await setMode('ALL');

  // 4. seeded system rules
  const findSystem = async (code: string): Promise<string> => {
    const list = await json(await admin.ctx.get(`${API}/rules?search=${encodeURIComponent(code)}&scope=system&limit=50`), `find ${code}`);
    const hit = (list.data as { id: string; code: string }[]).find((r) => r.code === code);
    if (!hit) throw new Error(`seeded system rule ${code} not found`);
    return hit.id;
  };
  const RULE_SYS = await findSystem('IMM-QC-01');
  const RULE_STRAT = await findSystem('STRATIFY-01');

  // 5. datasets
  const ingest = async (filename: string, bytes: Buffer): Promise<string> => {
    const init = await json(
      await admin.ctx.post(`${API}/workspaces/${WS_R}/datasets`, { data: { organizationId: ORG_R, originalFilename: filename, contentType: 'text/csv' }, headers: h }),
      `init ${filename}`,
    );
    const id = init.dataset.id as string;
    const put = await fetch(init.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(bytes) });
    if (!put.ok) throw new Error(`presigned PUT ${filename} failed (${put.status})`);
    await json(await admin.ctx.patch(`${API}/workspaces/${WS_R}/datasets/${id}/finalize`, { headers: h }), `finalize ${filename}`);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const d = await json(await admin.ctx.get(`${API}/workspaces/${WS_R}/datasets/${id}`, { headers: h }), `poll ${filename}`);
      if (d.latestIngestion?.status === 'ready') break;
      if (d.latestIngestion?.status === 'failed') throw new Error(`ingestion of ${filename} failed`);
      await sleep(1_500);
    }
    await json(await admin.ctx.post(`${API}/projects/${PROJ_R}/datasets`, { data: { datasetId: id }, headers: h }), `link ${filename}`);
    return id;
  };
  const DS_QC = await ingest(`axi1149-qc-${tag}.csv`, readFileSync(join(FIXTURES_DIR, 'qc_sample.csv')));
  const stratCsv = 'subject_id,arm,response\n' + Array.from({ length: 24 }, (_, i) => `S${String(i).padStart(3, '0')},${i % 2 ? 'A' : 'B'},${i * 1.5}\n`).join('');
  const DS_STRAT = await ingest(`axi1149-strat-${tag}.csv`, Buffer.from(stratCsv));
  await json(await admin.ctx.patch(`${API}/projects/${PROJ_R}/profile`, { data: { profileId: 'immuno_oncology' }, headers: h }), 'assign profile');
  await sleep(6_000); // field-mapping recompute is asynchronous

  // 6. a published PROJECT-scope QC rule (clone of the seeded system QC rule)
  const clone = await json(
    await admin.ctx.post(`${API}/rules/${RULE_SYS}/clone`, { data: { targetScope: 'project', targetWorkspaceId: WS_R, targetProjectId: PROJ_R }, headers: h }),
    'clone QC rule',
  );
  const RULE_WS = clone.id as string;
  await json(
    await admin.ctx.patch(`${API}/rules/${RULE_WS}`, {
      data: {
        outputFields: [
          { key: 'include_mask', type: 'boolean', description: 'Whether this row passes QC' },
          { key: 'qc_fail_reasons', type: 'array', description: 'Array of QC failure reason codes' },
        ],
      },
      headers: h,
    }),
    'patch clone',
  );
  await json(await admin.ctx.post(`${API}/rules/${RULE_WS}/publish`, { data: {}, headers: h }), 'publish clone');

  let strat: Promise<string> | undefined;
  const execQc: Rbac['execQc'] = (who, ruleId, extra = {}) =>
    who.ctx.post(`${API}/rule-runs`, {
      data: { ruleId, runKind: 'QC', operationId: 'qc.rule_gate', projectId: PROJ_R, workspaceId: WS_R, datasetId: DS_QC, ...extra },
      headers: h,
    });

  return {
    tag, radm, ORG_R, WS_R, PROJ_R, uNone, uRules, uShared, uDan, RULE_WS, RULE_SYS, RULE_STRAT, DS_QC, DS_STRAT, h,
    setMode, execQc, mkUser,
    stratRun() {
      strat ??= (async () => {
        const res = await uShared.ctx.post(`${API}/rule-runs`, {
          data: {
            ruleId: RULE_STRAT, runKind: 'STRATIFY', projectId: PROJ_R, workspaceId: WS_R, datasetId: DS_STRAT,
            partitionRule: { field: 'arm', kind: 'categorical', groups: [{ id: 'a', label: 'A', levels: ['A'] }, { id: 'b', label: 'B', levels: ['B'] }] },
          },
          headers: h,
        });
        const { ruleRunId } = await json(res, 'submit STRATIFY-01');
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          const run = await json(await uShared.ctx.get(`${API}/rule-runs/${ruleRunId}`, { headers: h }), 'poll strat');
          if (run.status === 'SUCCEEDED') return ruleRunId as string;
          if (['FAILED', 'CANCELED'].includes(run.status)) throw new Error(`STRATIFY-01 run ${run.status}: ${run.errorMessage}`);
          await sleep(2_000);
        }
        throw new Error('STRATIFY-01 run did not finish');
      })();
      return strat;
    },
    async dispose() {
      // best effort: the API has no hard delete for orgs/rules/datasets (uniquely tagged, left behind).
      await radmCtx.put(`${API}/organizations/${ORG_R}/rule-access/mode`, { data: { mode: 'ALL' } }).catch(() => undefined);
      await admin.ctx.delete(`${API}/projects/${PROJ_R}`, { headers: h }).catch(() => undefined);
      await admin.ctx.delete(`${API}/workspaces/${WS_R}`).catch(() => undefined);
      for (const u of createdUsers) {
        for (const rid of createdRoles) await admin.ctx.delete(`${API}/users/${u}/roles/${rid}`).catch(() => undefined);
      }
      for (const rid of createdRoles) await radmCtx.delete(`${API}/roles/${rid}`).catch(() => undefined);
      for (const u of createdUsers) await admin.ctx.delete(`${API}/users/${u}`).catch(() => undefined);
      await Promise.all(owned.map((c) => c.dispose().catch(() => undefined)));
    },
  };
}

/** Worker-scoped rule-access tenant, layered on the shared two-tenant topology. */
export const test = base.extend<object, { rbac: Rbac }>({
  rbac: [
    async ({ topo }, use) => {
      const rbac = await provisionRbac(topo);
      await use(rbac);
      await rbac.dispose();
    },
    { scope: 'worker', timeout: 300_000 },
  ],
});

export { expect } from './fixtures';

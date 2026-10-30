import { apiUrl, API_BASE_URL } from '../../config/env';
import { ROLES } from '../../config/roles';
import { ApiClient, createApiClient, fetchTransport, loginForToken, okBody } from './harness/prod-suite/api-client';
import type { ProdSuiteConfig } from './harness/prod-suite/config';

/**
 * AXI-2318 — a self-provisioned STAND-IN for the dedicated prod test org, for
 * verifying the prod-suite infrastructure on a local/demo stack (never prod).
 *
 * It reproduces exactly the shape the operator provisions on production:
 * a fresh organization, one workspace it owns, and one self-registered test
 * identity that is (a) an `editor` member of that workspace only and (b) holds
 * a SYSTEM role with `rule:read` + `rule:evaluate` + `rule:view_shared` (without
 * `view_shared` the served system catalogue is empty for a non-admin). The
 * platform admin only creates the objects; the suite then runs as the confined
 * identity. Every name carries `E2E AXI-2318` so the stand-in is recognisable.
 *
 * It also creates a DECOY org, standing in for Paul's CeRAINOM-IgG4 org: the
 * identity is never a member of it, and its id is the world's
 * `PROD_E2E_FORBIDDEN_ORG_IDS` (required and non-empty, EC9). Every client
 * here, the admin's included, carries that id in its tripwire.
 */

export const TEST_IDENTITY_PERMISSIONS = ['rule:read', 'rule:evaluate', 'rule:view_shared'];

/** A syntactically valid org id no stack ever issues (v4 UUID, all zeros). */
const NEVER_ISSUED_ORG_ID = '00000000-0000-4000-8000-000000000000';

const unique = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function adminRole() {
  const role = ROLES.find((r) => r.name === 'admin');
  if (!role) throw new Error('admin role missing from ROLES registry');
  return role;
}

export class LocalTestOrgWorld {
  admin!: ApiClient;
  identity!: ApiClient;
  organizationId!: string;
  workspaceId!: string;
  email!: string;
  /** Id of the decoy "never touch" org — the stand-in's forbidden-org list. */
  forbiddenOrgId!: string;
  password = 'AXI2318-e2e-pw!';
  private roleId: string | null = null;

  static async create(): Promise<LocalTestOrgWorld> {
    const world = new LocalTestOrgWorld();
    const role = adminRole();
    const adminToken = await loginForToken(API_BASE_URL, role.email, role.password);
    await world.createDecoyForbiddenOrg(adminToken);
    world.admin = world.client(adminToken);
    await world.createOrgAndWorkspace();
    const userId = await world.registerIdentity();
    await world.grantIdentity(userId);
    world.identity = await world.identityClient();
    return world;
  }

  /** A plain client (no workspace header) armed with the decoy id. */
  private client(token: string): ApiClient {
    return createApiClient({ apiBaseUrl: API_BASE_URL, token, forbiddenIds: [this.forbiddenOrgId] }, fetchTransport);
  }

  /**
   * Created through a one-off client armed with a never-issued id (the decoy's
   * own id does not exist yet); nothing afterwards ever names it.
   */
  private async createDecoyForbiddenOrg(adminToken: string): Promise<void> {
    const bootstrap = createApiClient({ apiBaseUrl: API_BASE_URL, token: adminToken, forbiddenIds: [NEVER_ISSUED_ORG_ID] }, fetchTransport);
    const org = okBody(await bootstrap.post('/api/v1/organizations', { name: unique('E2E AXI-2318 forbidden decoy org'), type: 'cro' }), 'create decoy org');
    this.forbiddenOrgId = org.id;
  }

  private async createOrgAndWorkspace(): Promise<void> {
    const org = okBody(await this.admin.post('/api/v1/organizations', { name: unique('E2E AXI-2318 test org'), type: 'cro' }), 'create org');
    this.organizationId = org.id;
    const ws = okBody(await this.admin.post('/api/v1/workspaces', {
      name: unique('E2E AXI-2318 test workspace'), type: 'internal', ownerOrganizationId: org.id,
      description: 'AXI-2318 prod-suite infra stand-in for the dedicated test org',
    }), 'create workspace');
    this.workspaceId = ws.id;
  }

  private async registerIdentity(): Promise<string> {
    this.email = `${unique('axi2318-test-identity')}@axiome.local`;
    const anon = this.client('');
    okBody(await anon.post('/api/v1/auth/register', {
      email: this.email, password: this.password, firstName: 'AXI2318', lastName: 'test-identity',
    }), 'register test identity');
    const token = await loginForToken(API_BASE_URL, this.email, this.password);
    const me = okBody(await this.client(token).get('/api/v1/auth/me'), 'me');
    return me.id;
  }

  /** Membership + rule permissions, granted BEFORE the identity's first rule read (permission cache). */
  private async grantIdentity(userId: string): Promise<void> {
    okBody(await this.admin.post(`/api/v1/workspaces/${this.workspaceId}/members`, {
      userId, organizationId: this.organizationId, role: 'editor',
    }), 'add member');
    const role = okBody(await this.admin.post('/api/v1/roles', {
      name: unique('E2E AXI-2318 prod-suite test identity'), scope: 'SYSTEM', permissions: TEST_IDENTITY_PERMISSIONS,
    }), 'create role');
    this.roleId = role.id;
    okBody(await this.admin.post(`/api/v1/users/${userId}/roles`, { roleId: role.id }), 'assign role');
  }

  /** A client for the confined identity, its EC9 tripwire armed with the decoy id by default. */
  async identityClient(forbiddenIds: string[] = [this.forbiddenOrgId]): Promise<ApiClient> {
    const token = await loginForToken(API_BASE_URL, this.email, this.password);
    return createApiClient({ apiBaseUrl: API_BASE_URL, token, workspaceId: this.workspaceId, forbiddenIds }, fetchTransport);
  }

  /** The daily-suite configuration this stand-in corresponds to. */
  config(fixtureIdsJson: string, overrides: Partial<ProdSuiteConfig> = {}): ProdSuiteConfig {
    return {
      apiBaseUrl: apiUrl('').replace(/\/+$/, ''), email: this.email, password: this.password,
      organizationId: this.organizationId, workspaceId: this.workspaceId, fixtureIdsJson,
      forbiddenOrgIds: [this.forbiddenOrgId], targetLabel: 'local-stand-in', runId: unique('local-axi2318'),
      gitSha: null, trigger: 'local', ...overrides,
    };
  }

  async datasetCount(): Promise<number> {
    const body = okBody(await this.identity.get(`/api/v1/workspaces/${this.workspaceId}/datasets?page=1&limit=1`), 'count datasets');
    return Number(body?.meta?.total ?? -1);
  }

  async dispose(): Promise<void> {
    if (this.roleId) await this.admin.delete(`/api/v1/roles/${this.roleId}`).catch(() => undefined);
  }
}

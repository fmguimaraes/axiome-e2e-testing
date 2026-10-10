import { test, expect, request as apiRequest, type Page, type APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-1963 (epic AXI-1904 — FR17, FR18, FR24, FR25, FR26; AC18, AC19, AC25,
 * AC26; EC18, EC19, EC21). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-1904-Rule-Acquisition.md` §2.7. Tags:
 * @SI-035 @SI-031.
 *
 * AUTHORED, NOT YET RUN against a live stack (same constraint as every
 * other spec in this epic — `wt-up.sh` refuses to overwrite the shared
 * `axiome-infra/.env`; the shared demo stack is off limits / behind
 * `main`). Do not report `e2e-pass` for this spec until it has actually
 * run. It also depends on AXI-1961's `GET /rules/acquisitions/capabilities`
 * and `allowedDecisions`, which are not yet on `main` — a live run is owed
 * only once that story has merged.
 *
 * Self-provisions every actor/role/rule per run (no shared fixture import —
 * each acquisition story keeps its own `*World` class, mirroring
 * AXI-1909's `AcquisitionPanelWorld`). Also silences onboarding tours,
 * which otherwise `navigate()` a fresh user away from the page.
 *
 * Idempotency reminder (AXI-1906 NFR6, EC19): two records on one rule must
 * differ in content (varied by `excerpt`) to produce two rows; an identical
 * resend returns the FIRST record's id.
 */

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function send(
  api: APIRequestContext,
  method: 'post' | 'put' | 'patch' | 'get' | 'delete',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await api[method](apiUrl(path), body === undefined ? undefined : { data: body as any });
  const text = await res.text();
  return { status: res.status(), json: text ? JSON.parse(text) : {} };
}

interface Actor {
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  api: APIRequestContext;
}

const TOUR_IDS = [
  'orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets',
  'evidence-decisions', 'graph-rules', 'charts-views', 'help', 'admin', 'collaboration',
];

/** A fresh user's onboarding tours auto-start and navigate() away from the
 *  current page — silence every tour before signing in through the UI. */
async function silenceTours(accessToken: string): Promise<void> {
  const api = await apiRequest.newContext();
  try {
    for (const tourId of TOUR_IDS) {
      await api.put(apiUrl('/api/v1/onboarding-state'), {
        data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    }
  } finally {
    await api.dispose();
  }
}

async function adminApiContext(): Promise<APIRequestContext> {
  const email = process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com';
  const password = process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin';
  const bootstrap = await apiRequest.newContext();
  const login = await send(bootstrap, 'post', '/api/v1/auth/login', { email, password });
  await bootstrap.dispose();
  return apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${login.json.accessToken}` } });
}

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(who.email);
  await page.locator('input[type="password"]').fill(who.password);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

class AddSourceFormWorld {
  admin!: APIRequestContext;
  orgId!: string;
  private readonly roleIds: string[] = [];
  private readonly actors: Actor[] = [];
  private readonly ruleIds: string[] = [];

  static async create(): Promise<AddSourceFormWorld> {
    const world = new AddSourceFormWorld();
    world.admin = await adminApiContext();
    const orgs = await send(world.admin, 'get', '/api/v1/organizations');
    world.orgId =
      orgs.json?.data?.[0]?.id ??
      (
        await send(world.admin, 'post', '/api/v1/organizations', {
          name: unique('AXI-1963 Org'),
          type: 'biotech',
        })
      ).json.id;
    return world;
  }

  async role(label: string, permissions: string[]): Promise<string> {
    const res = await send(this.admin, 'post', '/api/v1/roles', {
      name: unique(`E2E AXI-1963 ${label}`),
      scope: 'SYSTEM',
      permissions,
    });
    expect(res.status, `creating role ${label}`).toBeLessThan(300);
    this.roleIds.push(res.json.id);
    return res.json.id;
  }

  async actor(label: string, roleId?: string): Promise<Actor> {
    const email = `${unique(`axi1963-${label}`)}@axiome.local`;
    const password = 'AXI1963-e2e-pw!';
    const bootstrap = await apiRequest.newContext();
    await send(bootstrap, 'post', '/api/v1/auth/register', {
      email,
      password,
      firstName: 'AXI1963',
      lastName: label,
    });
    const login = await send(bootstrap, 'post', '/api/v1/auth/login', { email, password });
    await bootstrap.dispose();
    const api = await apiRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${login.json.accessToken}` },
    });
    const me = await send(api, 'get', '/api/v1/auth/me');
    if (roleId) await send(this.admin, 'post', `/api/v1/users/${me.json.id}/roles`, { roleId });
    const actor = { userId: me.json.id, email, password, accessToken: login.json.accessToken, api };
    this.actors.push(actor);
    return actor;
  }

  /** A fresh workspace whose only member is `member` (plus whoever `addMember` adds later). */
  async workspace(label: string, member: Actor): Promise<string> {
    const ws = await send(this.admin, 'post', '/api/v1/workspaces', {
      name: unique(`E2E AXI-1963 ${label}`),
      description: 'AXI-1963 add-source-form E2E fixture',
      type: 'internal',
      ownerOrganizationId: this.orgId,
    });
    await send(this.admin, 'post', `/api/v1/workspaces/${ws.json.id}/members`, {
      userId: member.userId,
      organizationId: this.orgId,
      role: 'admin',
    });
    return ws.json.id;
  }

  async addMember(workspaceId: string, member: Actor, role: 'admin' | 'member' = 'member'): Promise<void> {
    await send(this.admin, 'post', `/api/v1/workspaces/${workspaceId}/members`, {
      userId: member.userId,
      organizationId: this.orgId,
      role,
    });
  }

  /** A minimal, immediately-usable workspace QC_RULE under the given code. */
  async rule(owner: Actor, workspaceId: string, code: string): Promise<{ id: string; version: number; code: string }> {
    const res = await send(owner.api, 'post', '/api/v1/rules', {
      code,
      title: 'AXI-1963 fixture rule',
      category: 'qc_guard',
      protocolType: 'QC_RULE',
      scope: 'workspace',
      workspaceId,
    });
    expect(res.status, 'creating fixture rule').toBeLessThan(300);
    this.ruleIds.push(res.json.id);
    return { id: res.json.id, version: res.json.version, code };
  }

  async dispose(): Promise<void> {
    for (const id of this.ruleIds) await this.admin.delete(apiUrl(`/api/v1/rules/${id}`)).catch(() => undefined);
    for (const actor of this.actors) await actor.api.dispose();
    for (const roleId of this.roleIds) await this.admin.delete(apiUrl(`/api/v1/roles/${roleId}`)).catch(() => undefined);
    await this.admin.dispose();
  }
}

let world: AddSourceFormWorld;
let acquireRoleId: string;
let readOnlyRoleId: string;

test.beforeAll(async () => {
  world = await AddSourceFormWorld.create();
  acquireRoleId = await world.role('acquire', ['rule:acquire', 'rule:read']);
  readOnlyRoleId = await world.role('read-only', ['rule:read']);
});

test.afterAll(async () => {
  await world.dispose();
});

test.describe('AXI-1963 - add source form on the acquisition panel', { tag: ['@SI-035', '@SI-031'] }, () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // §2.7 row 1 / AC18
  test('AC18: a canAcquire holder adds a source from the panel; it lists as draft, manual, pinned to the current version @SI-035', async ({ page }) => {
    const acquirer = await world.actor('acquirer-ac18', acquireRoleId);
    const workspaceId = await world.workspace('ws-ac18', acquirer);
    const code = unique('AXI1963AC18');
    const rule = await world.rule(acquirer, workspaceId, code);

    await silenceTours(acquirer.accessToken);
    await signIn(page, acquirer);
    await page.goto(`/rules/${rule.id}`);

    const form = page.getByTestId('acquisition-add-source-form');
    await expect(form).toBeVisible();
    await form.getByTestId('acquisition-source-reference').fill('10.1000/axi1963-ac18');
    await form.getByTestId('acquisition-source-excerpt').fill('AC18 excerpt — measured threshold is 7 ng/mL');
    await form.getByTestId('acquisition-add-source-save').click();

    const record = page.getByTestId('acquisition-record');
    await expect(record).toHaveCount(1);
    await expect(record.getByTestId('acquisition-status-badge')).toHaveText('Draft');
    await expect(record.locator(`text=v${rule.version}`)).toBeVisible();
    await record.getByTestId('acquisition-record-toggle').click();
    await expect(record.getByTestId('acquisition-excerpt')).toHaveText('AC18 excerpt — measured threshold is 7 ng/mL');

    // Form resets after a successful save.
    await expect(form.getByTestId('acquisition-source-reference')).toHaveValue('');
    await expect(form.getByTestId('acquisition-source-excerpt')).toHaveValue('');
  });

  // §2.7 row 2 / AC19 (client-side)
  test('AC19: Save stays disabled for a blank excerpt or a reference that does not match its type @SI-035', async ({ page }) => {
    const acquirer = await world.actor('acquirer-ac19', acquireRoleId);
    const workspaceId = await world.workspace('ws-ac19', acquirer);
    const code = unique('AXI1963AC19');
    const rule = await world.rule(acquirer, workspaceId, code);

    await silenceTours(acquirer.accessToken);
    await signIn(page, acquirer);
    await page.goto(`/rules/${rule.id}`);

    const form = page.getByTestId('acquisition-add-source-form');
    const save = form.getByTestId('acquisition-add-source-save');
    await expect(save).toBeDisabled();

    // reference filled but excerpt blank
    await form.getByTestId('acquisition-source-reference').fill('10.1000/axi1963-ac19');
    await expect(save).toBeDisabled();

    // excerpt filled but reference malformed for its declared type (doi)
    await form.getByTestId('acquisition-source-reference').fill('not-a-doi');
    await form.getByTestId('acquisition-source-excerpt').fill('AC19 excerpt');
    await expect(save).toBeDisabled();
    await expect(form.getByTestId('acquisition-source-reference-error')).toBeVisible();

    // both valid: Save enables
    await form.getByTestId('acquisition-source-reference').fill('10.1000/axi1963-ac19');
    await expect(save).toBeEnabled();
  });

  // §2.7 row 3 / EC19
  test('AC19: EC19 — an identical source is reported as already recorded; no second row @SI-035 @SI-031', async ({ page }) => {
    const acquirer = await world.actor('acquirer-ec19', acquireRoleId);
    const workspaceId = await world.workspace('ws-ec19', acquirer);
    const code = unique('AXI1963EC19');
    const rule = await world.rule(acquirer, workspaceId, code);

    await silenceTours(acquirer.accessToken);
    await signIn(page, acquirer);
    await page.goto(`/rules/${rule.id}`);

    const form = page.getByTestId('acquisition-add-source-form');
    const reference = '10.1000/axi1963-ec19';
    const excerpt = 'EC19 excerpt — identical both times';

    await form.getByTestId('acquisition-source-reference').fill(reference);
    await form.getByTestId('acquisition-source-excerpt').fill(excerpt);
    await form.getByTestId('acquisition-add-source-save').click();
    await expect(page.getByTestId('acquisition-record')).toHaveCount(1);

    await form.getByTestId('acquisition-source-reference').fill(reference);
    await form.getByTestId('acquisition-source-excerpt').fill(excerpt);
    await form.getByTestId('acquisition-add-source-save').click();

    await expect(page.getByTestId('add-source-notice')).toContainText(/already recorded/i);
    await expect(page.getByTestId('acquisition-record')).toHaveCount(1);
  });

  // §2.7 row 4 / EC18
  test('FR24: EC18 — a viewer without rule:acquire sees no Add source form; rule creation is unaffected @SI-035', async ({ page }) => {
    const acquirer = await world.actor('acquirer-ec18', acquireRoleId);
    const workspaceId = await world.workspace('ws-ec18', acquirer);
    const code = unique('AXI1963EC18');
    const rule = await world.rule(acquirer, workspaceId, code);

    const reader = await world.actor('reader-ec18', readOnlyRoleId);
    await world.addMember(workspaceId, reader);
    await silenceTours(reader.accessToken);
    await signIn(page, reader);
    await page.goto(`/rules/${rule.id}`);

    await expect(page.getByTestId('rule-acquisition-panel')).toBeVisible();
    await expect(page.getByTestId('acquisition-add-source-form')).toHaveCount(0);
  });

  // §2.7 row 5 / EC21
  test('FR24: EC21 — a failed capabilities read offers no acquisition action; records stay read-only @SI-035', async ({ page }) => {
    const acquirer = await world.actor('acquirer-ec21', acquireRoleId);
    const workspaceId = await world.workspace('ws-ec21', acquirer);
    const code = unique('AXI1963EC21');
    const rule = await world.rule(acquirer, workspaceId, code);
    const created = await send(
      acquirer.api,
      'post',
      '/api/v1/rules/acquisitions',
      {
        ruleCode: code,
        reference: '10.1000/axi1963-ec21',
        referenceType: 'doi',
        excerpt: 'EC21 excerpt',
        acquisitionMethod: 'manual',
        acquiredAt: new Date().toISOString(),
      },
    );
    expect(created.status).toBeLessThan(300);

    await silenceTours(acquirer.accessToken);
    await signIn(page, acquirer);
    // Fail only the capabilities probe — every other call stays live.
    await page.route('**/rules/acquisitions/capabilities', (route) => route.abort('failed'));
    await page.goto(`/rules/${rule.id}`);

    await expect(page.getByTestId('acquisition-record')).toHaveCount(1);
    await expect(page.getByTestId('acquisition-add-source-form')).toHaveCount(0);
    await page.getByTestId('acquisition-record-toggle').click();
    await expect(page.getByTestId('acquisition-decision-controls')).toHaveCount(0);
  });

  // §2.7 row 6 / AC26
  test('AC26: the role editor lists both rule:acquire and rule:self_approve_acquisition, each with a description @SI-030', async ({ page }) => {
    const roleId = await world.role('catalog-ac26', ['rule:read']);
    const adminEmail = process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com';
    const adminPassword = process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin';
    await signIn(page, { email: adminEmail, password: adminPassword });
    await page.goto(`/system/roles/${roleId}/edit`);

    await expect(page.getByText('Acquire rule source records')).toBeVisible();
    await expect(page.getByText('Create acquisition records (source evidence) for rules')).toBeVisible();
    await expect(page.getByText('Self-approve acquisition records')).toBeVisible();
    await expect(page.getByText(/Approve an acquisition record this same user acquired/)).toBeVisible();
  });
});

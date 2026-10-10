import { test, expect, request as apiRequest, type Page, type APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-1909 (epic AXI-1904 — FR11, AC10, EC15; also exercises FR7/FR8/FR14/
 * FR15 end to end through the UI). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-1904-Rule-Acquisition.md` §2.5. Tags:
 * @SI-035 @SI-031.
 *
 * AUTHORED, NOT YET RUN against a live stack: `wt-up.sh` refuses to
 * overwrite the shared `axiome-infra/.env` (holds
 * `GUIDED_ANALYSIS_ANTHROPIC_API_KEY`) and the shared demo stack is off
 * limits / behind `main` (dev-epic-context gotcha). Do not report
 * `e2e-pass` for this spec until it has actually run.
 *
 * Self-provisions every actor/role/rule/record per run (no shared fixture
 * import — AXI-1906/1907/1908 each keep their own `*World` class per story
 * file ownership; this one is UI-driving, so it also silences onboarding
 * tours, which otherwise `navigate()` a fresh user away from the page
 * (`reference_onboarding_tour_hijacks_navigation`).
 *
 * Idempotency reminder (AXI-1906 NFR6): two records on one rule must differ
 * in content (varied by `excerpt`) or the second POST returns the first
 * record's id instead of creating a second row.
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

class AcquisitionPanelWorld {
  admin!: APIRequestContext;
  orgId!: string;
  private readonly roleIds: string[] = [];
  private readonly actors: Actor[] = [];
  private readonly ruleIds: string[] = [];

  static async create(): Promise<AcquisitionPanelWorld> {
    const world = new AcquisitionPanelWorld();
    world.admin = await adminApiContext();
    const orgs = await send(world.admin, 'get', '/api/v1/organizations');
    world.orgId =
      orgs.json?.data?.[0]?.id ??
      (
        await send(world.admin, 'post', '/api/v1/organizations', {
          name: unique('AXI-1909 Org'),
          type: 'biotech',
        })
      ).json.id;
    return world;
  }

  async role(label: string, permissions: string[]): Promise<string> {
    const res = await send(this.admin, 'post', '/api/v1/roles', {
      name: unique(`E2E AXI-1909 ${label}`),
      scope: 'SYSTEM',
      permissions,
    });
    expect(res.status, `creating role ${label}`).toBeLessThan(300);
    this.roleIds.push(res.json.id);
    return res.json.id;
  }

  async actor(label: string, roleId?: string): Promise<Actor> {
    const email = `${unique(`axi1909-${label}`)}@axiome.local`;
    const password = 'AXI1909-e2e-pw!';
    const bootstrap = await apiRequest.newContext();
    await send(bootstrap, 'post', '/api/v1/auth/register', {
      email,
      password,
      firstName: 'AXI1909',
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
      name: unique(`E2E AXI-1909 ${label}`),
      description: 'AXI-1909 acquisition panel E2E fixture',
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
  async rule(owner: Actor, workspaceId: string, code: string): Promise<{ id: string; version: number }> {
    const res = await send(owner.api, 'post', '/api/v1/rules', {
      code,
      title: 'AXI-1909 fixture rule',
      category: 'qc_guard',
      protocolType: 'QC_RULE',
      scope: 'workspace',
      workspaceId,
    });
    expect(res.status, 'creating fixture rule').toBeLessThan(300);
    this.ruleIds.push(res.json.id);
    return { id: res.json.id, version: res.json.version };
  }

  async dispose(): Promise<void> {
    for (const id of this.ruleIds) await this.admin.delete(apiUrl(`/api/v1/rules/${id}`)).catch(() => undefined);
    for (const actor of this.actors) await actor.api.dispose();
    for (const roleId of this.roleIds) await this.admin.delete(apiUrl(`/api/v1/roles/${roleId}`)).catch(() => undefined);
    await this.admin.dispose();
  }
}

function baseAcquisitionBody(ruleCode: string, overrides: Record<string, unknown> = {}) {
  return {
    ruleCode,
    reference: '10.1000/e2e-axi1909',
    referenceType: 'doi',
    excerpt: 'the measured threshold is 9 ng/mL for AXI-1909',
    acquisitionMethod: 'manual',
    acquiredAt: new Date().toISOString(),
    ...overrides,
  };
}

let world: AcquisitionPanelWorld;
let acquireRoleId: string;
let publishRoleId: string;
let readOnlyRoleId: string;

test.beforeAll(async () => {
  world = await AcquisitionPanelWorld.create();
  acquireRoleId = await world.role('acquire', ['rule:acquire', 'rule:read']);
  publishRoleId = await world.role('publish', ['rule:publish', 'rule:read']);
  readOnlyRoleId = await world.role('read-only', ['rule:read']);
});

test.afterAll(async () => {
  await world.dispose();
});

test.describe('AXI-1909 - acquisition panel on the rule detail page', { tag: ['@SI-035', '@SI-031'] }, () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // §2.5 row 1 / AC10, FR11
  test('AC10, FR11: records show newest first with status, rule version, reference, locator, excerpt @SI-035', async ({ page }) => {
    const acquirer = await world.actor('acquirer-order', acquireRoleId);
    const workspaceId = await world.workspace('ws-order', acquirer);
    const code = unique('AXI1909ORDER');
    const rule = await world.rule(acquirer, workspaceId, code);

    const older = await send(
      acquirer.api,
      'post',
      '/api/v1/rules/acquisitions',
      baseAcquisitionBody(code, {
        locator: 'Table 2',
        excerpt: 'older excerpt for AXI-1909 ordering',
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect(older.status).toBeLessThan(300);
    const newer = await send(
      acquirer.api,
      'post',
      '/api/v1/rules/acquisitions',
      baseAcquisitionBody(code, { locator: 'Figure 3', excerpt: 'newer excerpt for AXI-1909 ordering' }),
    );
    expect(newer.status).toBeLessThan(300);

    await silenceTours(acquirer.accessToken);
    await signIn(page, acquirer);
    await page.goto(`/rules/${rule.id}`);

    const records = page.getByTestId('acquisition-record');
    await expect(records).toHaveCount(2);
    // newest first
    await expect(records.nth(0).getByTestId('acquisition-status-badge')).toHaveText('Draft');
    await records.nth(0).getByTestId('acquisition-record-toggle').click();
    await expect(records.nth(0).getByTestId('acquisition-excerpt')).toHaveText('newer excerpt for AXI-1909 ordering');
    await records.nth(1).getByTestId('acquisition-record-toggle').click();
    await expect(records.nth(1).getByTestId('acquisition-excerpt')).toHaveText('older excerpt for AXI-1909 ordering');
    await expect(records.nth(1).getByText('Figure 3')).toHaveCount(0);
    await expect(records.nth(1).getByText('Table 2')).toBeVisible();
  });

  // §2.5 row 2 / "no acquisition records yet" empty state
  test('a rule with zero records shows the empty state, not a bare blank panel @SI-035', async ({ page }) => {
    const acquirer = await world.actor('acquirer-empty', acquireRoleId);
    const workspaceId = await world.workspace('ws-empty', acquirer);
    const code = unique('AXI1909EMPTY');
    const rule = await world.rule(acquirer, workspaceId, code);

    await silenceTours(acquirer.accessToken);
    await signIn(page, acquirer);
    await page.goto(`/rules/${rule.id}`);

    await expect(page.getByTestId('acquisition-empty')).toBeVisible();
    await expect(page.getByTestId('acquisition-record')).toHaveCount(0);
  });

  // §2.5 row 3 / EC15
  test('EC15: a draft rule edited after the record was written is flagged as content-changed @SI-035', async ({ page }) => {
    const acquirer = await world.actor('acquirer-ec15', acquireRoleId);
    const workspaceId = await world.workspace('ws-ec15', acquirer);
    const code = unique('AXI1909EC15');
    const rule = await world.rule(acquirer, workspaceId, code);
    const created = await send(
      acquirer.api,
      'post',
      '/api/v1/rules/acquisitions',
      baseAcquisitionBody(code, { excerpt: 'excerpt pinned before the edit, AXI-1909' }),
    );
    expect(created.status).toBeLessThan(300);

    await silenceTours(acquirer.accessToken);
    await signIn(page, acquirer);
    await page.goto(`/rules/${rule.id}`);
    await expect(page.getByTestId('acquisition-content-changed')).toHaveCount(0);

    const patchRes = await acquirer.api.patch(apiUrl(`/api/v1/rules/${rule.id}`), {
      data: { title: 'AXI-1909 fixture rule — edited' },
    });
    expect(patchRes.status()).toBeLessThan(300);

    await page.reload();
    await expect(page.getByTestId('acquisition-content-changed')).toBeVisible();
    await expect(page.locator('[data-testid="acquisition-record"][data-content-changed="true"]')).toHaveCount(1);
  });

  // §2.5 row 4 / AC14, FR15 — no rule:publish, no decision controls
  test('AC14: a viewer without rule:publish sees the records but no decision controls @SI-035', async ({ page }) => {
    const acquirer = await world.actor('acquirer-noperm', acquireRoleId);
    const workspaceId = await world.workspace('ws-noperm', acquirer);
    const code = unique('AXI1909NOPERM');
    const rule = await world.rule(acquirer, workspaceId, code);
    const created = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', baseAcquisitionBody(code, { excerpt: 'excerpt for the no-permission viewer, AXI-1909' }));
    expect(created.status).toBeLessThan(300);

    const reader = await world.actor('reader-noperm', readOnlyRoleId);
    await world.addMember(workspaceId, reader);
    await silenceTours(reader.accessToken);
    await signIn(page, reader);
    await page.goto(`/rules/${rule.id}`);

    await page.getByTestId('acquisition-record-toggle').click();
    await expect(page.getByTestId('acquisition-excerpt')).toBeVisible();
    await expect(page.getByTestId('acquisition-decision-controls')).toHaveCount(0);
  });

  // §2.5 row 5 / AC7, AC9, FR15 — Approve via the UI, status comes from the server
  test('AC7, AC9: a rule:publish holder approves a draft record from the panel @SI-035 @SI-031', async ({ page }) => {
    const acquirer = await world.actor('acquirer-approve', acquireRoleId);
    const workspaceId = await world.workspace('ws-approve', acquirer);
    const code = unique('AXI1909APPROVE');
    const rule = await world.rule(acquirer, workspaceId, code);
    const created = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', baseAcquisitionBody(code, { excerpt: 'excerpt to be approved via the UI, AXI-1909' }));
    expect(created.status).toBeLessThan(300);

    const publisher = await world.actor('publisher-approve', publishRoleId);
    await world.addMember(workspaceId, publisher);
    await silenceTours(publisher.accessToken);
    await signIn(page, publisher);
    await page.goto(`/rules/${rule.id}`);

    await page.getByTestId('acquisition-record-toggle').click();
    await page.getByTestId('acquisition-approve').click();
    await expect(page.getByTestId('acquisition-status-badge')).toHaveText('Approved');

    // the server's word, not a local guess: re-reading confirms it persisted
    const readBack = await send(publisher.api, 'get', `/api/v1/rules/acquisitions/${created.json.id}`);
    expect(readBack.json.status).toBe('approved');
  });

  // §2.5 row 6 / AC8 — Supersede with a target picked from the panel's own approved siblings
  test('AC8: supersede replaces one approved record with another, chosen from the panel @SI-035 @SI-031', async ({ page }) => {
    const acquirer = await world.actor('acquirer-supersede', acquireRoleId);
    const workspaceId = await world.workspace('ws-supersede', acquirer);
    const code = unique('AXI1909SUPERSEDE');
    const rule = await world.rule(acquirer, workspaceId, code);
    const first = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', baseAcquisitionBody(code, { excerpt: 'first excerpt, to be superseded, AXI-1909' }));
    expect(first.status).toBeLessThan(300);
    const second = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', baseAcquisitionBody(code, { excerpt: 'second excerpt, the replacement, AXI-1909' }));
    expect(second.status).toBeLessThan(300);

    const publisher = await world.actor('publisher-supersede', publishRoleId);
    await world.addMember(workspaceId, publisher);
    const approveFirst = await send(publisher.api, 'post', `/api/v1/rules/acquisitions/${first.json.id}/decisions`, { decision: 'approve' });
    expect(approveFirst.status).toBeLessThan(300);
    const approveSecond = await send(publisher.api, 'post', `/api/v1/rules/acquisitions/${second.json.id}/decisions`, { decision: 'approve' });
    expect(approveSecond.status).toBeLessThan(300);

    await silenceTours(publisher.accessToken);
    await signIn(page, publisher);
    await page.goto(`/rules/${rule.id}`);

    // Newest first (FR10): `second` is index 0, the older `first` is index 1.
    const records = page.getByTestId('acquisition-record');
    await expect(records).toHaveCount(2);
    const olderRecord = records.nth(1);
    await olderRecord.getByTestId('acquisition-record-toggle').click();
    await expect(olderRecord.getByTestId('acquisition-excerpt')).toHaveText('first excerpt, to be superseded, AXI-1909');

    // Exactly one supersede candidate exists (the other approved record, `second`).
    const targetSelect = olderRecord.getByTestId('acquisition-supersede-target');
    const targetValue = await targetSelect.locator('option').nth(1).getAttribute('value');
    expect(targetValue).toBe(second.json.id);
    await targetSelect.selectOption(targetValue!);
    await olderRecord.getByTestId('acquisition-supersede').click();

    await expect(olderRecord.getByTestId('acquisition-status-badge')).toHaveText('Superseded');
    const readBack = await send(publisher.api, 'get', `/api/v1/rules/acquisitions/${first.json.id}`);
    expect(readBack.json.status).toBe('superseded');
    expect(readBack.json.supersededBy).toBe(second.json.id);
  });

  // §2.5 row 7 / AC15 raw output on-demand
  test('AC15: raw model output is fetched and shown only once a record is expanded @SI-035', async ({ page }) => {
    const acquirer = await world.actor('acquirer-raw', acquireRoleId);
    const workspaceId = await world.workspace('ws-raw', acquirer);
    const code = unique('AXI1909RAW');
    const rule = await world.rule(acquirer, workspaceId, code);
    const created = await send(
      acquirer.api,
      'post',
      '/api/v1/rules/acquisitions',
      baseAcquisitionBody(code, {
        acquisitionMethod: 'llm',
        modelId: 'gpt-fixture',
        promptVersionHash: 'hash-fixture',
        rawOutput: 'exact raw model output text for AXI-1909 panel',
        excerpt: 'llm excerpt for raw-output on-demand test, AXI-1909',
      }),
    );
    expect(created.status).toBeLessThan(300);

    await silenceTours(acquirer.accessToken);
    await signIn(page, acquirer);
    await page.goto(`/rules/${rule.id}`);

    await expect(page.getByText('exact raw model output text for AXI-1909 panel')).toHaveCount(0);
    await page.getByTestId('acquisition-record-toggle').click();
    await expect(page.getByText('exact raw model output text for AXI-1909 panel')).toBeVisible();
  });
});

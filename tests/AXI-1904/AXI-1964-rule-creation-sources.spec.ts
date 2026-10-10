import { test, expect, request as apiRequest, type Page, type APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-1964 (epic AXI-1904 — FR19, FR20; AC20, AC21; EC17, EC18, EC22).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1904-Rule-Acquisition.md` §2.8
 * (owed to the epic doc owner — not written here per lead instruction).
 * Tags: @SI-035 @SI-030.
 *
 * AUTHORED, NOT YET RUN against a live stack — same standing constraint as
 * every other spec in this epic (`wt-up.sh` refuses to overwrite the shared
 * `axiome-infra/.env`; the shared demo stack is off limits / behind `main`).
 * Do not report `e2e-pass` for this spec until it has actually been run.
 *
 * Self-provisions every actor/role/workspace per run (no shared fixture
 * import — mirrors AXI-1963's `AddSourceFormWorld`). Also silences
 * onboarding tours, which otherwise `navigate()` a fresh user away from the
 * page, and seeds the active-workspace scope into `localStorage` the same
 * key `topMenuStore` persists to (`axiome-active-workspace`) — `RuleCreate`
 * computes its `navigationLevel`/`availableScopes` from that store, and a
 * fresh actor with no scope selected would see an empty scope list and be
 * unable to reach a submittable form at all.
 *
 * AC21/EC17 forced-failure mechanism: no client-accepted-but-server-refused
 * input was found for a *first* acquisition create (the client's own
 * `validateSourceDraft` mirrors every format rule the server enforces on
 * `reference`/`referenceType`, and `RULE_CODE_NOT_FOUND`/`RULE_CODE_AMBIGUOUS`
 * cannot be forced without a genuinely racy second rule). Per the lead's
 * explicit fallback instruction, this spec instead intercepts the SECOND
 * `POST /rules/acquisitions` call with `page.route` and fulfills it with a
 * 400, while letting the first call go live — stated here explicitly rather
 * than left implicit in the test body.
 *
 * Idempotency reminder (AXI-1906 NFR6, EC19): two records on one rule must
 * differ in content (varied by `excerpt`) to produce two distinct rows.
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

/**
 * Seeds the active-workspace scope `RuleCreate` reads from `topMenuStore`
 * (persisted under the `axiome-active-workspace` localStorage key) so a
 * freshly-signed-in actor lands on `/rules/new` with `navigationLevel` ===
 * `'workspace'` and a non-empty `availableScopes`/`defaultScope` — without
 * this, a non-admin actor with no org/workspace selected sees an empty
 * scope list and cannot submit the form at all.
 */
async function selectWorkspaceScope(page: Page, workspaceId: string) {
  await page.goto('/');
  await page.evaluate((id) => window.localStorage.setItem('axiome-active-workspace', id), workspaceId);
  await page.goto('/rules/new');
}

async function selectQcRuleAndFillBasics(page: Page, code: string, title: string) {
  await page.getByText('QC Rule').click();
  await page.getByPlaceholder('e.g., IMM-ACT-01').fill(code);
  await page.getByPlaceholder('e.g., Evidence of immune activation').fill(title);
}

class RuleCreationSourcesWorld {
  admin!: APIRequestContext;
  orgId!: string;
  private readonly roleIds: string[] = [];
  private readonly actors: Actor[] = [];
  private readonly ruleIds: string[] = [];

  static async create(): Promise<RuleCreationSourcesWorld> {
    const world = new RuleCreationSourcesWorld();
    world.admin = await adminApiContext();
    const orgs = await send(world.admin, 'get', '/api/v1/organizations');
    world.orgId =
      orgs.json?.data?.[0]?.id ??
      (
        await send(world.admin, 'post', '/api/v1/organizations', {
          name: unique('AXI-1964 Org'),
          type: 'biotech',
        })
      ).json.id;
    return world;
  }

  async role(label: string, permissions: string[]): Promise<string> {
    const res = await send(this.admin, 'post', '/api/v1/roles', {
      name: unique(`E2E AXI-1964 ${label}`),
      scope: 'SYSTEM',
      permissions,
    });
    expect(res.status, `creating role ${label}`).toBeLessThan(300);
    this.roleIds.push(res.json.id);
    return res.json.id;
  }

  async actor(label: string, roleId?: string): Promise<Actor> {
    const email = `${unique(`axi1964-${label}`)}@axiome.local`;
    const password = 'AXI1964-e2e-pw!';
    const bootstrap = await apiRequest.newContext();
    await send(bootstrap, 'post', '/api/v1/auth/register', {
      email,
      password,
      firstName: 'AXI1964',
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

  /** A fresh workspace whose only member is `member`, as workspace admin (so `rule:create`/`rule:acquire` apply at workspace scope). */
  async workspace(label: string, member: Actor): Promise<string> {
    const ws = await send(this.admin, 'post', '/api/v1/workspaces', {
      name: unique(`E2E AXI-1964 ${label}`),
      description: 'AXI-1964 rule-creation-sources E2E fixture',
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

  trackRule(id: string): void {
    this.ruleIds.push(id);
  }

  async dispose(): Promise<void> {
    for (const id of this.ruleIds) await this.admin.delete(apiUrl(`/api/v1/rules/${id}`)).catch(() => undefined);
    for (const actor of this.actors) await actor.api.dispose();
    for (const roleId of this.roleIds) await this.admin.delete(apiUrl(`/api/v1/roles/${roleId}`)).catch(() => undefined);
    await this.admin.dispose();
  }
}

let world: RuleCreationSourcesWorld;
// Every actor that CREATES A RULE through this page needs `rule:create`.
// Every actor whose Sources section must be live (AC20/AC21/EC22) also needs
// `rule:acquire` (`canAcquire` is read from the server, never guessed) plus
// `rule:read` (the post-create redirect lands on `/rules/:id`, which reads
// the rule and its acquisition panel). An actor for EC18 deliberately omits
// `rule:acquire` to prove the section never renders without it.
let creatorAcquireRoleId: string;
let creatorOnlyRoleId: string;

test.beforeAll(async () => {
  world = await RuleCreationSourcesWorld.create();
  creatorAcquireRoleId = await world.role('creator-acquire', ['rule:create', 'rule:acquire', 'rule:read']);
  creatorOnlyRoleId = await world.role('creator-only', ['rule:create', 'rule:read']);
});

test.afterAll(async () => {
  await world.dispose();
});

test.describe('AXI-1964 - rule creation with sources', { tag: ['@SI-035', '@SI-030'] }, () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // §2.8 row 1 / AC20
  test('AC20: two sources staged on Create Rule become two acquisition records on the new rule @SI-035', async ({ page }) => {
    const actor = await world.actor('creator-ac20', creatorAcquireRoleId);
    const workspaceId = await world.workspace('ws-ac20', actor);
    const code = unique('AXI1964AC20');

    await silenceTours(actor.accessToken);
    await signIn(page, actor);
    await selectWorkspaceScope(page, workspaceId);

    await selectQcRuleAndFillBasics(page, code, 'AC20 rule');

    const section = page.getByTestId('rule-create-sources-section');
    await expect(section).toBeVisible();

    await page.getByTestId('acquisition-source-reference').fill('10.1000/axi1964-ac20-a');
    await page.getByTestId('acquisition-source-excerpt').fill('AC20 first source excerpt');
    await page.getByTestId('rule-create-source-add').click();

    await page.getByTestId('acquisition-source-reference').fill('10.1000/axi1964-ac20-b');
    await page.getByTestId('acquisition-source-excerpt').fill('AC20 second source excerpt');
    await page.getByTestId('rule-create-source-add').click();

    await expect(page.getByTestId('rule-create-source-item')).toHaveCount(2);

    await page.getByRole('button', { name: 'Create Rule' }).click();
    await expect(page).toHaveURL(/\/rules\/[^/]+$/);
    const ruleId = page.url().split('/').pop()!;
    world.trackRule(ruleId);

    const records = page.getByTestId('acquisition-record');
    await expect(records).toHaveCount(2);
    await expect(page.getByText('10.1000/axi1964-ac20-a', { exact: false }).or(page.getByText('AC20 first source excerpt'))).toBeVisible();
  });

  // §2.8 row 2 / AC21 + EC17 + FR20
  test('AC21/EC17: a failed source write does not lose the rule, and is carried to the detail page pre-filled with the server reason @SI-035', async ({ page }) => {
    const actor = await world.actor('creator-ac21', creatorAcquireRoleId);
    const workspaceId = await world.workspace('ws-ac21', actor);
    const code = unique('AXI1964AC21');

    await silenceTours(actor.accessToken);
    await signIn(page, actor);
    await selectWorkspaceScope(page, workspaceId);

    const failingReference = '10.1000/axi1964-ac21-fail';
    const okReference = '10.1000/axi1964-ac21-ok';
    let callIndex = 0;
    // Forced-failure mechanism (stated per the lead's explicit fallback
    // instruction): no client-accepted/server-refused input exists for a
    // first acquisition create, so the SECOND `POST /rules/acquisitions`
    // call is intercepted and fulfilled with a 400; the first call is left
    // live, proving a real record is created for it.
    await page.route('**/rules/acquisitions', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      callIndex += 1;
      if (callIndex === 2) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'RAW_OUTPUT_TOO_LARGE: forced failure for AXI-1964 AC21/EC17' }),
        });
        return;
      }
      await route.continue();
    });

    await selectQcRuleAndFillBasics(page, code, 'AC21 rule');

    await page.getByTestId('acquisition-source-reference').fill(okReference);
    await page.getByTestId('acquisition-source-excerpt').fill('AC21 ok source excerpt');
    await page.getByTestId('rule-create-source-add').click();

    await page.getByTestId('acquisition-source-reference').fill(failingReference);
    await page.getByTestId('acquisition-source-excerpt').fill('AC21 failing source excerpt');
    await page.getByTestId('rule-create-source-add').click();

    await expect(page.getByTestId('rule-create-source-item')).toHaveCount(2);

    await page.getByRole('button', { name: 'Create Rule' }).click();

    // The rule exists despite the second source's failure (AC21: never lose the rule).
    await expect(page).toHaveURL(/\/rules\/[^/]+$/);
    const ruleId = page.url().split('/').pop()!;
    world.trackRule(ruleId);

    // The successful source is recorded normally.
    await expect(page.getByTestId('acquisition-record')).toHaveCount(1);

    // The failed source is carried to this same detail view (FR20), pre-filled
    // with its draft and the server's reason (EC17), as an extra Add-source
    // form distinct from the always-present blank one.
    const carried = page.getByTestId('rule-acquisition-carried-failures');
    await expect(carried).toBeVisible();
    await expect(carried.getByTestId('acquisition-source-reference')).toHaveValue(failingReference);
    await expect(carried.getByTestId('acquisition-source-excerpt')).toHaveValue('AC21 failing source excerpt');
    await expect(carried).toContainText(/too large/i);

    // Carried state must not survive a reload (FR20) — a mount-time effect
    // strips the navigation state immediately after the single read.
    await page.reload();
    await expect(page.getByTestId('rule-acquisition-carried-failures')).toHaveCount(0);
  });

  // §2.8 row 3 / EC18 (capabilities false)
  test('FR19 EC18: an actor without rule:acquire never sees the Sources section, and rule creation is unaffected @SI-035', async ({ page }) => {
    const actor = await world.actor('creator-ec18-noacquire', creatorOnlyRoleId);
    const workspaceId = await world.workspace('ws-ec18a', actor);
    const code = unique('AXI1964EC18A');

    await silenceTours(actor.accessToken);
    await signIn(page, actor);
    await selectWorkspaceScope(page, workspaceId);

    await selectQcRuleAndFillBasics(page, code, 'EC18 rule (no acquire)');

    await expect(page.getByTestId('rule-create-sources-section')).toHaveCount(0);

    await page.getByRole('button', { name: 'Create Rule' }).click();
    await expect(page).toHaveURL(/\/rules\/[^/]+$/);
    const ruleId = page.url().split('/').pop()!;
    world.trackRule(ruleId);
    await expect(page.getByTestId('acquisition-empty').or(page.getByTestId('acquisition-record'))).toHaveCount(1);
  });

  // §2.8 row 4 / EC18 (capabilities read failure — fails closed)
  test('FR19 EC18: a failed capabilities read hides the Sources section even for a rule:acquire holder @SI-035', async ({ page }) => {
    const actor = await world.actor('creator-ec18-capsfail', creatorAcquireRoleId);
    const workspaceId = await world.workspace('ws-ec18b', actor);
    const code = unique('AXI1964EC18B');

    await silenceTours(actor.accessToken);
    await signIn(page, actor);
    await selectWorkspaceScope(page, workspaceId);
    await page.route('**/rules/acquisitions/capabilities', (route) => route.abort('failed'));
    await page.goto('/rules/new');

    await selectQcRuleAndFillBasics(page, code, 'EC18 rule (caps fail)');

    await expect(page.getByTestId('rule-create-sources-section')).toHaveCount(0);

    await page.getByRole('button', { name: 'Create Rule' }).click();
    await expect(page).toHaveURL(/\/rules\/[^/]+$/);
    const ruleId = page.url().split('/').pop()!;
    world.trackRule(ruleId);
  });

  // §2.8 row 5 / EC22
  test('FR19 EC22: a source identical (trimmed) to one already staged is refused in-form before save, with a message @SI-035', async ({ page }) => {
    const actor = await world.actor('creator-ec22', creatorAcquireRoleId);
    const workspaceId = await world.workspace('ws-ec22', actor);
    const code = unique('AXI1964EC22');

    await silenceTours(actor.accessToken);
    await signIn(page, actor);
    await selectWorkspaceScope(page, workspaceId);

    await selectQcRuleAndFillBasics(page, code, 'EC22 rule');

    const reference = '  10.1000/axi1964-ec22  ';
    const excerpt = '  EC22 excerpt  ';
    await page.getByTestId('acquisition-source-reference').fill(reference);
    await page.getByTestId('acquisition-source-excerpt').fill(excerpt);
    await page.getByTestId('rule-create-source-add').click();
    await expect(page.getByTestId('rule-create-source-item')).toHaveCount(1);

    // Same values (even with different surrounding whitespace) are refused
    // before save, never silently staged twice.
    await page.getByTestId('acquisition-source-reference').fill(reference.trim());
    await page.getByTestId('acquisition-source-excerpt').fill(excerpt.trim());
    await page.getByTestId('rule-create-source-add').click();

    await expect(page.getByTestId('rule-create-source-duplicate-error')).toBeVisible();
    await expect(page.getByTestId('rule-create-source-item')).toHaveCount(1);

    // The fully-empty-section rule (no block) still holds: submitting with
    // only the one staged source still succeeds.
    await page.getByRole('button', { name: 'Create Rule' }).click();
    await expect(page).toHaveURL(/\/rules\/[^/]+$/);
    const ruleId = page.url().split('/').pop()!;
    world.trackRule(ruleId);
    await expect(page.getByTestId('acquisition-record')).toHaveCount(1);
  });
});

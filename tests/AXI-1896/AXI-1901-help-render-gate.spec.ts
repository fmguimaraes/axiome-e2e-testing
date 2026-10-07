import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';

/**
 * AXI-1901 (epic AXI-1896 — FR15, FR18, FR19, FR22, NFR3; AC9, AC10, AC12,
 * AC17). Scenario doc: `manual-e2e/AXI-1896-Help-Onboarding-Content-Approval.md`
 * §AXI-1901 (CA-1901-1..5).
 *
 * Wires the EXISTING pure `gate.ts#resolveServed` into the Help System's
 * document render (drawer + `/help` route, both through `HelpDocPane`) and
 * the nav/search visibility seam (`useHelpVisibility`). Nothing here
 * reimplements the gate's decision logic — only the real app's reaction to
 * it is asserted.
 *
 * Real pieces: the "welcome" help document (shipped corpus, `en`, category
 * `getting-started`, canonical URL `/help/getting-started/welcome`) rendered
 * by the real app; a `content:approve` holder provisioned through the real
 * admin roles API (mirrors `AXI-1899-content-approvals-api.spec.ts`'s
 * `ContentApprovalWorld`) so `useIsContentApprover()` resolves against a REAL
 * global-role permission list, not a stub.
 *
 * Stubbed piece: `GET /api/v1/content-approvals/status` is intercepted with
 * `page.route` to put the gate into a known mode/approved/helpFallbacks
 * shape. This is an HTTP-boundary stub (the same technique
 * `AXI-1882-help-anchor.spec.ts` uses for a served operation descriptor), NOT
 * a reimplementation of `resolveServed` — the real client code still reads
 * whatever the stub returns and the real `gate.ts` still decides. The
 * alternative (writing real approval ledger rows bound to the corpus file's
 * CURRENT hash) would make every scenario depend on `welcome.md`'s exact
 * bytes never changing, which is not this story's contract to hold.
 *
 * NOT run in this pass — W5 runs it against the ONE shared demo DB
 * (`npx playwright test tests/AXI-1896/AXI-1901-*`). Authored against the
 * real component contracts (`HelpDocPane.tsx`, `ContentApprovalNotices.tsx`,
 * `HelpPage.tsx`, `useHelpVisibility.ts`) read directly from the merged
 * front-end branch, not against a running app.
 */

const DOC_PATH = '/help/getting-started/welcome';
const DOC_TITLE = 'Welcome';
const CATEGORY_TITLE = 'Getting started';
const STATUS_ROUTE = '**/api/v1/content-approvals/status';
const ACTOR_PASSWORD = 'AXI1901-e2e-pw!';

async function send(
  api: APIRequestContext,
  method: 'post' | 'put' | 'get' | 'delete',
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
  api: APIRequestContext;
}

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

class World {
  admin!: APIRequestContext;
  private readonly roleIds: string[] = [];
  private readonly actors: Actor[] = [];

  static async create(): Promise<World> {
    const w = new World();
    w.admin = await adminApiContext();
    return w;
  }

  async role(label: string, permissions: string[]): Promise<string> {
    const res = await send(this.admin, 'post', '/api/v1/roles', {
      name: unique(`E2E AXI-1901 ${label}`),
      scope: 'SYSTEM',
      permissions,
    });
    expect(res.status, `creating role ${label}`).toBeLessThan(300);
    this.roleIds.push(res.json.id);
    return res.json.id;
  }

  async actor(label: string, roleId?: string): Promise<Actor> {
    const email = `${unique(`axi1901-${label}`)}@axiome.local`;
    const bootstrap = await apiRequest.newContext();
    await send(bootstrap, 'post', '/api/v1/auth/register', {
      email,
      password: ACTOR_PASSWORD,
      firstName: 'AXI1901',
      lastName: label,
    });
    const login = await send(bootstrap, 'post', '/api/v1/auth/login', { email, password: ACTOR_PASSWORD });
    await bootstrap.dispose();
    const api = await apiRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${login.json.accessToken}` },
    });
    const me = await send(api, 'get', '/api/v1/auth/me');
    if (roleId) await send(this.admin, 'post', `/api/v1/users/${me.json.id}/roles`, { roleId });
    const actor = { userId: me.json.id, email, api };
    this.actors.push(actor);
    return actor;
  }

  async dispose(): Promise<void> {
    for (const a of this.actors) await a.api.dispose();
    for (const roleId of this.roleIds) {
      await this.admin.delete(apiUrl(`/api/v1/roles/${roleId}`)).catch(() => undefined);
    }
    await this.admin.dispose();
  }
}

/** Seed `page` with `actor`'s own session (the app reads tokens from localStorage) and skip onboarding tours (memory: a fresh user's tour navigate()s away from the page under test). */
async function signIn(page: Page, actor: Actor): Promise<void> {
  const login = await apiRequest.newContext();
  const res = await send(login, 'post', '/api/v1/auth/login', { email: actor.email, password: ACTOR_PASSWORD });
  await login.dispose();
  const ctx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${res.json.accessToken}` } });
  const TOUR_IDS = [
    'orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets', 'evidence-decisions',
    'graph-rules', 'help', 'admin', 'charts-views', 'collaboration',
  ];
  for (const tourId of TOUR_IDS) {
    await ctx.put(apiUrl('/api/v1/onboarding-state'), { data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 } });
  }
  await ctx.dispose();
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('access_token', access as string);
      localStorage.setItem('refresh_token', refresh as string);
    },
    [res.json.accessToken, res.json.refreshToken] as const,
  );
}

/** Stub `GET /content-approvals/status` with a fixed shape — the ONE boundary this spec controls directly. */
async function stubStatus(
  page: Page,
  body: { mode: 'report' | 'enforce'; approved: unknown[]; helpFallbacks: unknown[] },
): Promise<void> {
  await page.route(STATUS_ROUTE, (route) => route.fulfill({ status: 200, json: body }));
}

let world: World;
let approverRoleId: string;
let approver: Actor;
let nonApprover: Actor;

test.beforeAll(async () => {
  world = await World.create();
  approverRoleId = await world.role('content-approve', ['content:approve']);
  approver = await world.actor('approver', approverRoleId);
  nonApprover = await world.actor('non-approver');
});

test.afterAll(async () => {
  await world.dispose();
});

test.describe('AXI-1901 — Help render gate & fallback', { tag: ['@SI-037'] }, () => {
  // CA-1901-1 / AC12 / FR18 / EC1
  test('AC12: a content:approve holder sees the CURRENT (pending) bundle with the Pending-approval badge, never the fallback', async ({ page }) => {
    await signIn(page, approver);
    await stubStatus(page, {
      mode: 'enforce',
      approved: [],
      helpFallbacks: [
        { id: 'welcome', locale: 'en', contentHash: 'sha256:fallback-old-hash', bytes: 'OLD approved welcome text.\n' },
      ],
    });
    await page.goto(DOC_PATH);

    await expect(page.getByRole('heading', { name: DOC_TITLE, level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('help-pending-approval-badge')).toBeVisible();
    await expect(page.getByTestId('help-pending-approval-badge')).toContainText('Pending approval');
    await expect(page.getByTestId('help-doc')).not.toContainText('OLD approved welcome text.');
  });

  // CA-1901-2 / AC9
  test('AC9: a non-holder sees the last approved fallback text, through the shared renderer, with no badge', async ({ page }) => {
    await signIn(page, nonApprover);
    await stubStatus(page, {
      mode: 'enforce',
      approved: [],
      helpFallbacks: [
        { id: 'welcome', locale: 'en', contentHash: 'sha256:fallback-old-hash', bytes: '# Welcome\n\nOLD approved welcome text.\n' },
      ],
    });
    await page.goto(DOC_PATH);

    await expect(page.getByTestId('help-doc')).toContainText('OLD approved welcome text.', { timeout: 20_000 });
    await expect(page.getByTestId('help-pending-approval-badge')).toHaveCount(0);
  });

  // CA-1901-3 / AC10 / FR19
  test('AC10: a non-holder finds no result searching a never-approved document, and its deep link opens a "not available yet" notice with a category link', async ({ page }) => {
    await signIn(page, nonApprover);
    await stubStatus(page, { mode: 'enforce', approved: [], helpFallbacks: [] });

    await page.goto('/help');
    await page.getByTestId('help-search-field').click();
    await page.getByTestId('help-search-input').fill('Welcome');
    await expect(
      page.getByTestId('help-search-no-results').or(page.getByRole('option')),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('option').filter({ hasText: DOC_TITLE })).toHaveCount(0);

    await page.goto(DOC_PATH);
    // AXI-1901 (1st bounce, finding 2): the notice is GENERIC — it must never
    // disclose the unapproved document's title. Assert the title is ABSENT,
    // never present.
    const notice = page.getByTestId('help-doc-pending-notice');
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toContainText('waiting for approval');
    await expect(notice).not.toContainText(DOC_TITLE);
    await expect(page.getByTestId('help-doc')).toHaveCount(0);

    await page.getByTestId('help-doc-pending-notice-category-link').click();
    await expect(page.getByRole('heading', { name: CATEGORY_TITLE })).toBeVisible({ timeout: 20_000 });
  });

  // CA-1901-4 / AC17 / EC9
  test('AC17/EC9: a failed status read fails the whole /help surface closed, never a silently-stale document', async ({ page }) => {
    await signIn(page, nonApprover);
    await page.route(STATUS_ROUTE, (route) => route.fulfill({ status: 500, json: { message: 'content-approvals unavailable' } }));

    await page.goto('/help');
    const unavailable = page.getByTestId('help-content-approval-unavailable');
    await expect(unavailable).toBeVisible({ timeout: 20_000 });
    await expect(unavailable).toContainText('Help is temporarily unavailable.');
    await expect(page.getByTestId('help-search-field')).toHaveCount(0);
    await expect(page.getByTestId('help-doc')).toHaveCount(0);
  });

  // CA-1901-5 / FR22
  test('FR22: report mode (no stub) renders byte-identical to pre-epic behaviour for a non-holder — no badge, no fallback swap, no hidden entries', async ({ page }) => {
    await signIn(page, nonApprover);
    // Deliberately NO route stub: this is the server's real, current default mode.
    await page.goto(DOC_PATH);

    await expect(page.getByRole('heading', { name: DOC_TITLE, level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('help-doc')).toBeVisible();
    await expect(page.getByTestId('help-pending-approval-badge')).toHaveCount(0);
    await expect(page.getByTestId('help-doc-pending-notice')).toHaveCount(0);
    await expect(page.getByTestId('help-content-approval-unavailable')).toHaveCount(0);
  });

  // CA-1901-6 / 1st bounce, finding 4 / 2nd bounce residual (tags) / @SI-037
  test('finding 4: a non-holder search can never match a fallback document\'s unapproved bundle text (body OR tags), only its approved fallback text', async ({ page }) => {
    await signIn(page, nonApprover);
    // The CURRENT bundle's "welcome" doc carries unique unapproved words
    // ("UNAPPROVEDTERMXYZ") AND the real corpus tags `orientation`/
    // `getting-started` — none of which appear in the approved fallback
    // bytes below. A search for any of them must find nothing for a
    // non-holder, because the served fallback's approved text/tags are all
    // search is allowed to read.
    await stubStatus(page, {
      mode: 'enforce',
      approved: [],
      helpFallbacks: [
        { id: 'welcome', locale: 'en', contentHash: 'sha256:fallback-old-hash', bytes: '---\ntitle: Approved Welcome\nid: welcome\ncategory: getting-started\norder: 10\nsummary: s\nreviewed: 2026-08-24\ngenerated_by: human\nauthored_by: a@cro-one.com\ntags: [approved-fallback-tag]\n---\nOLD approved welcome text.\n' },
      ],
    });

    await page.goto('/help');
    await page.getByTestId('help-search-field').click();
    await page.getByTestId('help-search-input').fill('UNAPPROVEDTERMXYZ');
    await expect(page.getByTestId('help-search-no-results')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('option')).toHaveCount(0);

    // 2nd bounce residual: the CURRENT bundle's own tag (real corpus
    // frontmatter, never stubbed) must not match either.
    await page.getByTestId('help-search-input').fill('');
    await page.getByTestId('help-search-input').fill('orientation');
    await expect(page.getByTestId('help-search-no-results')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('option')).toHaveCount(0);

    // The approved fallback's OWN tag DOES match — proving a real
    // substitution happened, not a blanket block on tag search.
    await page.getByTestId('help-search-input').fill('');
    await page.getByTestId('help-search-input').fill('approved-fallback-tag');
    await expect(page.getByRole('option')).toHaveCount(1, { timeout: 20_000 });

    // The approved fallback's OWN text still matches, through the browse tree
    // title too (never the current bundle's "Welcome").
    await page.getByTestId('help-search-input').fill('');
    await page.getByTestId('help-search-input').fill('Approved Welcome');
    await expect(page.getByRole('option').filter({ hasText: 'Approved Welcome' })).toBeVisible({ timeout: 20_000 });
  });

  // CA-1901-7 / 1st bounce, finding 3 / @SI-037
  test('finding 3: a non-holder sees a neutral loading state, never the unfiltered surface, while the status/approver facts are still settling', async ({ page }) => {
    await signIn(page, nonApprover);
    // Delay the status response indefinitely (never resolves within the test) —
    // the mode itself is unknown for as long as this is pending.
    await page.route(STATUS_ROUTE, async (route) => {
      await new Promise(() => {}); // never resolves within the test's lifetime
      await route.fulfill({ status: 200, json: { mode: 'enforce', approved: [], helpFallbacks: [] } });
    });

    await page.goto('/help');
    await expect(page.getByTestId('help-content-approval-settling')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('help-search-field')).toHaveCount(0);
    await expect(page.getByRole('button', { name: DOC_TITLE })).toHaveCount(0);
    await expect(page.getByTestId('help-content-approval-unavailable')).toHaveCount(0);
  });
});

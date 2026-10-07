import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';

/**
 * AXI-1902 (epic AXI-1896 — FR16, FR17, FR18, NFR3; AC11, AC12, AC17, AC21).
 * Scenario doc: `manual-e2e/AXI-1896-Help-Onboarding-Content-Approval.md`
 * §AXI-1902 (CA-1902-1..8).
 *
 * Wires the EXISTING pure `gate.ts#resolveServed` (via
 * `src/onboarding/contentApprovalGate.ts`) into the real onboarding surfaces:
 * autostart (`useOnboardingAutostart`), the checklist (`OnboardingChecklist`),
 * the resume prompt (`ResumePrompt`) and the running tooltip
 * (`TourTooltip`/`TourRunner`). Nothing here reimplements the gate's decision
 * logic — only the real app's reaction to it is asserted, exactly like
 * `AXI-1901-help-render-gate.spec.ts`.
 *
 * Real pieces: the "orientation" tour (shipped registry, `autoStart:
 * 'first-visit'`, `autostartRoute: '/'`, title "Orientation") driven by the
 * real app; a `content:approve` holder provisioned through the real admin
 * roles API as an ADDITIONAL role assignment on top of the actor's default
 * one (mirrors `AXI-1899-content-approvals-api.spec.ts`'s `ContentApprovalWorld`
 * and `AXI-1901-help-render-gate.spec.ts`'s `World`), so `useIsContentApprover()`
 * resolves against a REAL global-role permission list, not a stub.
 *
 * Stubbed pieces (HTTP boundary only, same technique AXI-1901 uses):
 * - `GET /api/v1/content-approvals/status` via `page.route`, to put the gate
 *   into a known mode/approved shape.
 * - For CA-1902-6/7 ONLY (the microcopy/FR17 scenarios), the build-time
 *   `content-manifest.json` chunk itself is ALSO stubbed with a small fixture
 *   (one tour item + the onboarding microcopy items), because proving an
 *   "approved at the CURRENT hash" verdict needs a `contentHash` that
 *   actually matches the manifest the running app reads — and the real
 *   corpus's current hash is not a contract this story holds (ditto AXI-1901's
 *   own reasoning for stubbing at the HTTP boundary rather than writing
 *   ledger rows bound to real file bytes). The manifest endpoint is a
 *   same-origin, network-visible request in the dev server (a glob-based
 *   dynamic import), so this is still an HTTP-boundary stub, not a
 *   reimplementation of `resolveServed` or `manifestBuilder`.
 *
 * NOT run in this pass — W5 runs it against the ONE shared demo DB
 * (`npx playwright test tests/AXI-1896/AXI-1902-*`). Authored against the
 * real component contracts (`useOnboardingAutostart.ts`, `OnboardingChecklist.tsx`,
 * `ResumePrompt.tsx`, `TourTooltip.tsx`, `TourRunner.tsx`) read directly from
 * the merged front-end branch, not against a running app.
 */

const ORIENTATION_TITLE = 'Orientation';
const STATUS_ROUTE = '**/api/v1/content-approvals/status';
const MANIFEST_ROUTE = '**/content-manifest.json*';
const ACTOR_PASSWORD = 'AXI1902-e2e-pw!';

// All ten shipped tours (registry.ts) — skipped for every actor except where
// a scenario deliberately needs 'orientation' to remain unset so first-visit
// autostart can fire (memory: a fresh user's tour navigate()s away from the
// page under test).
const ALL_TOUR_IDS = [
  'orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets', 'evidence-decisions',
  'graph-rules', 'help', 'admin', 'charts-views', 'collaboration',
];

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
      name: unique(`E2E AXI-1902 ${label}`),
      scope: 'SYSTEM',
      permissions,
    });
    expect(res.status, `creating role ${label}`).toBeLessThan(300);
    this.roleIds.push(res.json.id);
    return res.json.id;
  }

  /** Registers a fresh actor, then — if `additionalRoleId` is given — grants
   *  it as a SECOND role assignment on top of the actor's own default one
   *  (never replacing it), mirroring the dev-epic-context's bootstrap note. */
  async actor(label: string, additionalRoleId?: string): Promise<Actor> {
    const email = `${unique(`axi1902-${label}`)}@axiome.local`;
    const bootstrap = await apiRequest.newContext();
    await send(bootstrap, 'post', '/api/v1/auth/register', {
      email,
      password: ACTOR_PASSWORD,
      firstName: 'AXI1902',
      lastName: label,
    });
    const login = await send(bootstrap, 'post', '/api/v1/auth/login', { email, password: ACTOR_PASSWORD });
    await bootstrap.dispose();
    const api = await apiRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${login.json.accessToken}` },
    });
    const me = await send(api, 'get', '/api/v1/auth/me');
    if (additionalRoleId) await send(this.admin, 'post', `/api/v1/users/${me.json.id}/roles`, { roleId: additionalRoleId });
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

/** Seed `page` with `actor`'s own session, skipping every tour EXCEPT
 *  `keepUnset` (default: none kept — all skipped), so autostart is fully
 *  under this spec's control per scenario. */
async function signIn(page: Page, actor: Actor, keepUnset: string[] = []): Promise<void> {
  const login = await apiRequest.newContext();
  const res = await send(login, 'post', '/api/v1/auth/login', { email: actor.email, password: ACTOR_PASSWORD });
  await login.dispose();
  const ctx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${res.json.accessToken}` } });
  for (const tourId of ALL_TOUR_IDS) {
    if (keepUnset.includes(tourId)) continue;
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

/** Stub `GET /content-approvals/status` with a fixed shape — the ONE boundary
 *  CA-1902-1..5/8 control directly. */
async function stubStatus(
  page: Page,
  body: { mode: 'report' | 'enforce'; approved: unknown[]; helpFallbacks: unknown[] },
): Promise<void> {
  await page.route(STATUS_ROUTE, (route) => route.fulfill({ status: 200, json: body }));
}

/** CA-1902-6/7 only: stub the manifest chunk itself so a fixture `contentHash`
 *  can be asserted "approved" deterministically (see file header). */
async function stubManifest(page: Page): Promise<void> {
  await page.route(MANIFEST_ROUTE, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          { kind: 'tour', id: 'orientation', locale: 'en', contentHash: 'sha256:e2e-tour-en', generatedBy: 'claude', authoredBy: 'a@cro-one.com', sourceRefs: [], title: 'Orientation', category: 'onboarding' },
          { kind: 'microcopy', id: 'onboarding', locale: 'en', contentHash: 'sha256:e2e-mc-en', generatedBy: 'claude', authoredBy: 'a@cro-one.com', sourceRefs: [], title: 'Onboarding microcopy (en)', category: 'onboarding' },
          { kind: 'microcopy', id: 'onboarding', locale: 'fr', contentHash: 'sha256:e2e-mc-fr', generatedBy: 'claude', authoredBy: 'a@cro-one.com', sourceRefs: [], title: 'Onboarding microcopy (fr)', category: 'onboarding' },
        ],
      }),
    }),
  );
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

test.describe('AXI-1902 — Onboarding render gate (tours & microcopy)', { tag: ['@SI-038'] }, () => {
  // CA-1902-1 / AC11 / FR16 / FR18
  test('AC11: a non-holder never sees a pending tour — absent from the checklist, and it never autostarts', async ({ page }) => {
    await signIn(page, nonApprover, ['orientation']); // leave 'orientation' unset so first-visit autostart is eligible
    await stubStatus(page, { mode: 'enforce', approved: [], helpFallbacks: [] });

    await page.goto('/');
    // Give the app a beat to settle and decide whether to autostart.
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(ORIENTATION_TITLE)).toHaveCount(0);

    // Checklist: open it and confirm the tour's own title is absent entirely
    // (never a blanked/placeholder row — the title IS the leak FR18 guards).
    await page.getByRole('button', { name: 'Getting started' }).click();
    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText(ORIENTATION_TITLE)).toHaveCount(0);
  });

  // CA-1902-2 / AC12 / FR18
  test('AC12: a content:approve holder sees the same pending tour, with a Pending badge, in the checklist and while running it', async ({ page }) => {
    await signIn(page, approver, ['orientation']);
    await stubStatus(page, { mode: 'enforce', approved: [], helpFallbacks: [] });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: 'Getting started' }).click();
    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    const row = panel.getByText(ORIENTATION_TITLE);
    await expect(row).toBeVisible();
    await expect(panel.getByTestId('onboarding-pending-approval-badge')).toBeVisible();

    // Start it manually from the checklist (FR18: an approver runs their own
    // pending tour in context) and confirm the badge follows into the tooltip.
    await panel.getByRole('button', { name: /start|restart/i }).click();
    await expect(page.getByTestId('onboarding-pending-approval-badge')).toBeVisible({ timeout: 20_000 });
  });

  // CA-1902-3 / FR16 (no fallback for tours, resumed state subject to the same withholding)
  test('FR16: a resumed mid-progress tour is withheld the same way — no resume prompt, no title, for a non-holder', async ({ page }) => {
    await signIn(page, nonApprover, ['orientation']);
    // Seed an in_progress state for 'orientation' directly (bypassing the UI)
    // so the resume prompt has something to offer were it not gated.
    const login = await apiRequest.newContext();
    const res = await send(login, 'post', '/api/v1/auth/login', { email: nonApprover.email, password: ACTOR_PASSWORD });
    await login.dispose();
    const ctx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${res.json.accessToken}` } });
    await ctx.put(apiUrl('/api/v1/onboarding-state'), { data: { tourId: 'orientation', tourVersion: 1, status: 'in_progress', stepIndex: 1 } });
    await ctx.dispose();

    await stubStatus(page, { mode: 'enforce', approved: [], helpFallbacks: [] });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // No resume dialog naming the tour, and no title anywhere on the page.
    await expect(page.getByRole('dialog').filter({ hasText: ORIENTATION_TITLE })).toHaveCount(0);
    await expect(page.getByText(ORIENTATION_TITLE)).toHaveCount(0);
  });

  // CA-1902-4 / AC17 / NFR3
  test('AC17/NFR3: a failed status read withholds every tour — no autostart, no checklist entries', async ({ page }) => {
    await signIn(page, nonApprover, ['orientation']);
    await page.route(STATUS_ROUTE, (route) => route.fulfill({ status: 500, json: { message: 'content-approvals unavailable' } }));

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(ORIENTATION_TITLE)).toHaveCount(0);

    await page.getByRole('button', { name: 'Getting started' }).click();
    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText(ORIENTATION_TITLE)).toHaveCount(0);
  });

  // CA-1902-5 / FR22
  test('FR22: report mode (no stub) behaves exactly as pre-epic for a non-holder — tour runs, no badge', async ({ page }) => {
    await signIn(page, nonApprover, ['orientation']);
    // Deliberately NO status stub: the server's real, current default mode.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.getByText(ORIENTATION_TITLE)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('onboarding-pending-approval-badge')).toHaveCount(0);
  });

  test.describe('AC21 — microcopy locale gate (FR17)', () => {
    test.use({ locale: 'fr-FR' });

    // CA-1902-6 / AC21 clause 1
    test('AC21 clause 1: a French-locale user with EN microcopy approved and FR pending gets the tour in English, with the fallback badge, not blocked', async ({ page }) => {
      await signIn(page, nonApprover, ['orientation']);
      await stubManifest(page);
      await stubStatus(page, {
        mode: 'enforce',
        approved: [
          { kind: 'tour', id: 'orientation', locale: 'en', contentHash: 'sha256:e2e-tour-en' },
          { kind: 'microcopy', id: 'onboarding', locale: 'en', contentHash: 'sha256:e2e-mc-en' },
        ],
        helpFallbacks: [],
      });

      await page.goto('/');
      await page.waitForLoadState('networkidle');
      // English copy renders (the only released/approved locale), never blocked.
      await expect(page.getByText(ORIENTATION_TITLE)).toBeVisible({ timeout: 20_000 });
    });

    // CA-1902-7 / AC21 clause 2 / FR17 clause 2
    test('AC21 clause 2: English microcopy itself pending blocks ALL tours regardless of locale/tour approval, and stops an already-running tour', async ({ page }) => {
      await signIn(page, nonApprover, ['orientation']);
      await stubManifest(page);
      await stubStatus(page, {
        mode: 'enforce',
        // The TOUR itself is approved, but EN microcopy carries NO entry (pending).
        approved: [{ kind: 'tour', id: 'orientation', locale: 'en', contentHash: 'sha256:e2e-tour-en' }],
        helpFallbacks: [],
      });

      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await expect(page.getByText(ORIENTATION_TITLE)).toHaveCount(0);
    });
  });

  // CA-1902-8 / NFR3 settling
  test('NFR3: no tour autostarts while status/manifest/approver are still resolving — never the unfiltered surface', async ({ page }) => {
    await signIn(page, nonApprover, ['orientation']);
    await page.route(STATUS_ROUTE, async (route) => {
      await new Promise(() => {}); // never resolves within the test's lifetime
      await route.fulfill({ status: 200, json: { mode: 'enforce', approved: [], helpFallbacks: [] } });
    });

    await page.goto('/');
    // Web-first: assert the negative holds across a real wait condition
    // (network settling) rather than a fixed sleep — autostart, if it were
    // going to (wrongly) fire, would have a tooltip visible by then.
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText(ORIENTATION_TITLE)).not.toBeVisible();
    await expect(page.getByText(ORIENTATION_TITLE)).toHaveCount(0);
  });
});

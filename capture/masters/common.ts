import type { BrowserContext, Page } from '@playwright/test';
import { assertNoDoNotShipContent } from '../doNotShip';
import { ACTION_TIMEOUT_MS, VIEWPORT, masterPngPath } from '../config';
import { captured } from './types';
import type { MasterResult } from './types';

/**
 * The active org/workspace/project is CLIENT-STATE ONLY — no URL param, no
 * cookie — read straight from `localStorage` by `useTopMenuStore`
 * (`axiome-front/src/stores/topMenuStore.ts`: keys `axiome-top-org`,
 * `axiome-active-workspace`, `axiome-active-project`) and gates
 * `ProjectViewAnalysisDetail`'s `canView` (real read: `hasPermission(roleId,
 * 'view-analysis:view')`, and `roleId` is only resolved for the ACTIVE
 * workspace). A direct `page.goto` to an internal analysis URL with no
 * active workspace selected renders "Access denied" regardless of the
 * account's real backend permissions — confirmed live while debugging this
 * story's first capture run (0/12 captured until this fix). Setting these
 * three keys via `context.addInitScript` — once per `BrowserContext`, before
 * any page navigates — reproduces exactly what clicking through the
 * workspace switcher would set, without simulating those clicks on every
 * master.
 */
export async function primeWorkspaceSelection(context: BrowserContext, orgId: string, workspaceId: string, projectId: string): Promise<void> {
  await context.addInitScript(
    ([org, ws, proj]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-active-project', proj);
    },
    [orgId, workspaceId, projectId],
  );
}

/**
 * Shared per-master mechanics (NFR4 determinism): every master disables
 * animations the same way, waits for network idle the same way, and takes
 * the shutter the same way — a master module only decides WHERE to
 * navigate and WHAT to assert, never how the frame itself is produced.
 */

/** Freezes CSS transitions/animations so two runs against the same tenant
 *  render pixel-identical frames (NFR4) instead of differing by whatever
 *  animation frame the shutter happened to land on. */
export async function disableAnimations(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({
    content: '*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; }',
  });
}

/** Applies the one shared timeout (`ACTION_TIMEOUT_MS`) to every action and
 *  navigation on `page` — called once right after page creation, so every
 *  master's locator/goto calls inherit it without repeating the number. */
export function applyTimeouts(page: Page): void {
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
}

/**
 * Navigate and let the DOM settle before any interaction. Deliberately
 * `domcontentloaded`, not `networkidle` — this SPA can keep a background
 * poller alive indefinitely, which would make `networkidle` wait out the
 * whole navigation timeout on every single master for no reason. Each
 * master's own explicit locator wait (chart rendered, drawer open, canvas
 * ready, ...) is the real "page is ready" gate, not this one.
 */
export async function gotoStable(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await disableAnimations(page);
  await dismissOnboardingIfPresent(page);
}

/**
 * The "Resume 'Orientation' where you left off?" prompt
 * (`components/onboarding/ResumePrompt.tsx`, `role="dialog"`) appears on
 * nearly every navigation (visible in M1/M3/M5's own captured frames,
 * bottom-right corner) and, live, its guided-tour overlay (react-joyride —
 * confirmed by browser console logs during debugging) intercepts clicks via
 * a full-screen `z-[1100]` backdrop (`.../pointer events intercepted`) —
 * this is what made M7's Evidence-tab click fail after 90s of retries.
 * Dismissed via its own "Not now" button where present; `Escape` as a
 * second, generic line of defense for the tour overlay itself. Both are
 * best-effort (the prompt does not always appear) — never thrown on absence.
 */
export async function dismissOnboardingIfPresent(page: Page): Promise<void> {
  const notNow = page.getByRole('button', { name: /not now/i });
  const appeared = await notNow
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) await notNow.click().catch(() => undefined);
  await page.keyboard.press('Escape').catch(() => undefined);
}

/**
 * A click that recovers from exactly the failure mode `dismissOnboardingIfPresent`
 * exists for: a tour backdrop intercepting the target element. Tries the
 * plain click first (cheap, usually enough); on failure, dismisses once more
 * and retries a single time before giving up (the caller's own timeout
 * still bounds the whole thing — this never introduces an unbounded retry).
 */
export async function clickResilient(page: Page, locator: ReturnType<Page['locator']>): Promise<void> {
  try {
    await locator.click({ timeout: ACTION_TIMEOUT_MS / 3 });
  } catch {
    await dismissOnboardingIfPresent(page);
    await locator.click({ timeout: ACTION_TIMEOUT_MS });
  }
}

/** AC15 defense-in-depth: scan the fully-rendered page's own text before
 *  the shutter, so a do-not-ship leak fails the master instead of shipping. */
export async function assertFrameIsShippable(masterId: string, page: Page): Promise<void> {
  const text = (await page.locator('body').innerText()).slice(0, 200_000);
  assertNoDoNotShipContent(masterId, text);
}

/**
 * AC6/§19 — asserts the chart gallery's own origin-filter `<select>`
 * (`DatasetVisualizations.tsx`) is actually set to "User-created", not just
 * that `?chartOrigin=user` was in the URL. Confirmed live (first capture
 * run): without this, the SAME embedded gallery M1/M2 use shows all ~30
 * specs, most auto-generated cross-product ("Correlation Matrix", "Scatter
 * Matrix (SPLOM)", ...) — exactly the do-not-ship content AC6 exists to keep
 * out of a shipped frame. A master calling this fails loudly if the filter
 * did not take, instead of silently shipping the wrong gallery. */
export async function assertOriginFilterIsUser(masterId: string, page: Page): Promise<void> {
  const select = page.locator('select').filter({ has: page.locator('option[value="user"]') }).first();
  await select.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  const value = await select.inputValue();
  if (value !== 'user') throw new Error(`${masterId}: precondition failed — chart gallery origin filter is "${value}", not "user" (AC6/§19)`);
}

/** The one shutter every master calls — fixed viewport, no full-page scroll
 *  (identical viewport across every master, FR19), PNG only. */
export async function shutter(masterId: string, title: string, page: Page): Promise<MasterResult> {
  await assertFrameIsShippable(masterId, page);
  const path = masterPngPath(masterId);
  await page.screenshot({ path, clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });
  return captured(masterId, title, path, VIEWPORT.width * 2, VIEWPORT.height * 2);
}

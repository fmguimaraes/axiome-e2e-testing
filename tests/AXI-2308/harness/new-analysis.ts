import { expect, type Page, type Route } from '@playwright/test';
import { sleep } from '../../AXI-1400/harness/api';
import type { Tenant } from '../../AXI-1400/harness/seed';

/**
 * AXI-2328 (epic AXI-2308 — FR47–FR53, NFR12, NFR13; @SI-066). Browser helpers for the New
 * analysis wizard spec: the tenant scope in localStorage, the stubbed routes (AXI-2345's
 * suggestion + intent catalog, the project SAP list, the idempotent semantic-declaration fill),
 * the one deliberate pause the wizard's press guard needs, and the in-page WCAG contrast
 * measurement. All fixed waits live here, never in a `*.spec.ts` (AXI-1265/NFR4).
 */

/** The wizard accepts one act per deliberate press (EC27): a new press is honoured after 250 ms. */
const PRESS_GUARD_MS = 300;

/** AXI-2345's served catalog (`GET /guided-analysis/intent-prefill/catalog`), as served. */
export const INTENT_CATALOG = [
  { id: 'explore_dataset', label: 'Explore a dataset' },
  { id: 'compare_groups', label: 'Compare groups' },
  { id: 'find_validate_biomarkers', label: 'Find and validate biomarkers' },
  { id: 'follow_patients_over_time', label: 'Follow patients over time' },
  { id: 'reproduce_published_analysis', label: 'Reproduce a published analysis' },
];

export type SuggestionStub =
  | { kind: 'answer'; body: Record<string, unknown>; delayMs?: number }
  | { kind: 'fail' }
  | { kind: 'hang' };

export interface WizardStubs {
  suggestion?: SuggestionStub;
  /** Rows the project SAP list returns (default: none — the project has no SAP). */
  saps?: Array<Record<string, unknown>>;
  /** Replace `match` with every template ineligible. */
  noTemplateFits?: boolean;
}

export interface StubLog {
  suggestionBodies: Array<Record<string, unknown>>;
  fillCalls: number;
}

/** An answered `QuestionSuggestionResult` (AXI-2345). Spans carry offsets into `question`. */
export function answered(question: string, intent: string | null, slots: Array<[string, string, string]> = [], contradictions: Array<[string, string]> = []) {
  const span = (text: string) => {
    const start = question.indexOf(text);
    return { text, start, end: start + text.length };
  };
  return {
    status: 'answered',
    intent,
    slots: slots.map(([slot, value, words]) => ({ slot, value, sourceSpan: span(words) })),
    contradictions: contradictions.map(([slot, words]) => ({ slot, sourceSpan: span(words), reason: 'not_in_vocabulary' })),
  };
}

/** Put the tenant in scope the way the team UI reads it (org + workspace + project). */
export async function seedScope(page: Page, t: Tenant): Promise<void> {
  await page.addInitScript(
    ([org, ws, project]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-active-project', project);
    },
    [t.orgId, t.workspaceId, t.projectId] as const,
  );
}

async function answerSuggestion(route: Route, stub: SuggestionStub, log: StubLog): Promise<void> {
  log.suggestionBodies.push(route.request().postDataJSON());
  if (stub.kind === 'hang') return;
  if (stub.kind === 'fail') return route.fulfill({ status: 500, json: { message: 'stubbed failure' } });
  if (stub.delayMs) await sleep(stub.delayMs);
  await route.fulfill({ status: 200, json: stub.body }).catch(() => undefined);
}

/** Install every stub the wizard needs; returns a log of what the page sent. */
export async function stubWizardRoutes(page: Page, stubs: WizardStubs = {}): Promise<StubLog> {
  const log: StubLog = { suggestionBodies: [], fillCalls: 0 };
  const suggestion = stubs.suggestion ?? { kind: 'answer', body: { status: 'answered', intent: null, slots: [], contradictions: [] } };
  await page.route('**/api/v1/guided-analysis/intent-prefill/catalog', (r) => r.fulfill({ status: 200, json: INTENT_CATALOG }));
  await page.route('**/api/v1/guided-analysis/intent-prefill/suggest', (r) => answerSuggestion(r, suggestion, log));
  await page.route(/\/api\/v1\/projects\/[^/]+\/saps(\?|$)/, (r) =>
    r.request().method() === 'GET' ? r.fulfill({ status: 200, json: { data: stubs.saps ?? [], total: (stubs.saps ?? []).length } }) : r.fallback(),
  );
  await page.route('**/semantic-declaration/ensure-recognized-fill', (r) => {
    log.fillCalls += 1;
    return r.fulfill({ status: 200, json: null });
  });
  if (stubs.noTemplateFits) await stubNoTemplateFits(page);
  return log;
}

async function stubNoTemplateFits(page: Page): Promise<void> {
  await page.route('**/api/v1/guided-analysis/opening-templates/match', async (r) => {
    const res = await r.fetch();
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    await r.fulfill({ response: res, json: rows.map((m) => ({ ...m, eligible: false, unmetGuards: ['stubbed'] })) });
  });
}

/** How many times a page load torn by a host network change is retried. */
const NETWORK_CHANGED_ATTEMPTS = 3;
/** Upper bound on waiting for the app's boot reads to go quiet (a poll may keep it from idling). */
const BOOT_READS_MS = 15_000;

/**
 * `page.goto` that survives the shared host's network churn — and nothing else. The dev server
 * serves ~1000 unbundled modules per load; a sibling worktree attaching a container to the shared
 * Docker network makes Chromium abort every in-flight request with `net::ERR_NETWORK_CHANGED`,
 * leaving a blank page. Only a load that saw THAT failure is reloaded (bounded); an assertion is
 * never retried, so a product defect still fails the test.
 */
export async function gotoSettled(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    let torn = false;
    const onFail = (r: { failure(): { errorText: string } | null }) => (torn ||= r.failure()?.errorText === 'net::ERR_NETWORK_CHANGED');
    page.on('requestfailed', onFail);
    await page.goto(url, { waitUntil: 'load' });
    // the app's boot reads (auth, permissions, scope) run after `load` — a tear there poisons state too
    await page.waitForLoadState('networkidle', { timeout: BOOT_READS_MS }).catch(() => undefined);
    page.off('requestfailed', onFail);
    if (!torn || attempt >= NETWORK_CHANGED_ATTEMPTS) return;
  }
}

/** Press a key as a deliberate, separate press (past the wizard's 250 ms press guard). */
export async function press(page: Page, key: string): Promise<void> {
  await sleep(PRESS_GUARD_MS);
  await page.keyboard.press(key);
}

/** Click a wizard control as a deliberate, separate act (past the 250 ms press guard). */
export async function choose(page: Page, testId: string): Promise<void> {
  await sleep(PRESS_GUARD_MS);
  await page.getByTestId(testId).click();
}

/** Click the radio whose accessible name matches, as a deliberate, separate act. */
export async function chooseRadio(page: Page, name: RegExp): Promise<void> {
  await sleep(PRESS_GUARD_MS);
  await page.getByRole('radio', { name }).click();
}

/** Type the question and submit it with Enter. */
export async function askQuestion(page: Page, question: string): Promise<void> {
  const input = page.getByLabel('What do you want to find out?');
  await expect(input).toBeFocused();
  await input.fill(question);
  await page.keyboard.press('Enter');
}

/** The data-testid of the focused element ('' when focus is on <body>). */
export function focusedTestId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.id ?? '');
}

export interface ControlMeasure {
  theme: string;
  testId: string;
  text: number;
  border: number | null;
  focusRing: number;
  focusVisible: boolean;
}

/**
 * WCAG contrast of every wizard control on screen: text vs its effective background (4.5:1),
 * the control border vs the background behind the control (3:1), and the focus outline vs that
 * background (3:1, measured while the control is focused) — on the light AND the dark theme
 * (the root `data-theme` is flipped for the measurement, then restored). Computed in-page from
 * computed styles — the suite carries no axe.
 */
export async function measureControls(page: Page): Promise<ControlMeasure[]> {
  const original = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const out: ControlMeasure[] = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => document.documentElement.setAttribute('data-theme', th), theme);
    await settleAnimations(page); // `transition-colors` would otherwise be measured mid-fade
    out.push(...(await measureTheme(page, theme)));
  }
  await page.evaluate((th) => (th ? document.documentElement.setAttribute('data-theme', th) : document.documentElement.removeAttribute('data-theme')), original);
  return out;
}

/** Resolve once every running finite CSS transition/animation has finished (a pulse never does). */
function settleAnimations(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const finite = document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity);
    return Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
  });
}

async function measureTheme(page: Page, theme: string): Promise<ControlMeasure[]> {
  const ids = await page.locator('[data-testid^="na-choice-"], [data-testid="na-run"], [data-testid="na-read-confirm"], [data-testid="na-question-ok"], [data-testid="na-back"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid') as string),
  );
  const out: ControlMeasure[] = [];
  for (const id of ids) {
    await page.getByTestId(id).focus();
    await settleAnimations(page);
    out.push({ ...(await page.getByTestId(id).evaluate(measureInPage, id)), theme });
  }
  return out;
}

function measureInPage(el: Element, testId: string): Omit<ControlMeasure, 'theme'> {
  const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const bgOf = (start: Element | null): number[] => {
    for (let n = start; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] > 0)) return c.slice(0, 3);
    }
    return [255, 255, 255];
  };
  const cs = getComputedStyle(el);
  const own = bgOf(el);
  const behind = bgOf(el.parentElement);
  const hasBorder = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
  return {
    testId,
    text: ratio(parse(cs.color), own),
    border: hasBorder ? ratio(parse(cs.borderTopColor), behind) : null,
    focusRing: ratio(parse(cs.outlineColor), behind),
    focusVisible: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
  };
}

/** No horizontal scroll on the page. */
export function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

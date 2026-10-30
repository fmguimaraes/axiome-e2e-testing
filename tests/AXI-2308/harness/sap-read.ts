import type { Page, Route } from '@playwright/test';

/**
 * AXI-2356 (epic AXI-2308 — FR17, FR19; owner ruling D20 Q11; @SI-066). A switchable stub of the
 * project SAP list read (`GET /api/v1/projects/:id/saps`) for the New analysis wizard: answer
 * "no SAP", one SAP, a server error (500), a network failure (aborted request), or hold the read
 * pending. The mode can be switched mid-test, so Retry is driven against a real change of answer.
 * A held read stays unanswered until `set()` switches to another mode — then every held request is
 * answered with that mode. No timed delay: a fixed delay would race the page's own settle wait.
 * Registered AFTER `stubWizardRoutes`, so it wins over that harness's fixed SAP list (the last
 * registered Playwright route handles the request).
 */

export type SapReadMode =
  | { kind: 'none' }
  | { kind: 'sap'; row: Record<string, unknown> }
  | { kind: 'server-error' }
  | { kind: 'network-error' }
  | { kind: 'pending' };

export interface SapReadStub {
  set(mode: SapReadMode): void;
  /** How many times the page asked for the SAP list. */
  readonly reads: number;
  /** How many reads are held unanswered right now (mode `pending`). */
  readonly held: number;
}

const SAP_LIST = /\/api\/v1\/projects\/[^/]+\/saps(\?|$)/;

async function reply(route: Route, m: Exclude<SapReadMode, { kind: 'pending' }>): Promise<void> {
  // a held request may belong to a page that has since navigated away — never fail the test on it
  if (m.kind === 'server-error') {
    await route.fulfill({ status: 500, json: { statusCode: 500, message: 'stubbed SAP read failure' } }).catch(() => undefined);
    return;
  }
  if (m.kind === 'network-error') {
    await route.abort('failed').catch(() => undefined);
    return;
  }
  const data = m.kind === 'sap' ? [m.row] : [];
  await route.fulfill({ status: 200, json: { data, meta: { total: data.length } } }).catch(() => undefined);
}

export async function stubSapRead(page: Page, initial: SapReadMode): Promise<SapReadStub> {
  let mode = initial;
  let reads = 0;
  let held: Route[] = [];
  const answer = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    reads += 1;
    if (mode.kind === 'pending') {
      held.push(route);
      return;
    }
    await reply(route, mode);
  };
  await page.route(SAP_LIST, answer);
  return {
    set: (next) => {
      mode = next;
      if (next.kind === 'pending') return;
      const release = held;
      held = [];
      for (const route of release) void reply(route, next);
    },
    get reads() {
      return reads;
    },
    get held() {
      return held.length;
    },
  };
}

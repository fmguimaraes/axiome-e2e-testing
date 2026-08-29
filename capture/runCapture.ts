import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import type { Page } from '@playwright/test';
import { COLOR_SCHEME, DEVICE_SCALE_FACTOR, MASTERS_DIR, VIEWPORT } from './config';
import { resolveCaptureContext } from './resolveCaptureContext';
import type { CaptureContext } from './resolveCaptureContext';
import { runVerifyGate } from './verifyGate';
import { MASTERS, ensureDefaultLogin } from './masters/index';
import { applyTimeouts, primeWorkspaceSelection } from './masters/common';
import { blocked } from './masters/types';
import type { MasterResult } from './masters/types';

/**
 * FR19/AC14 entrypoint — `npm run capture`. Order: (1) FR18 verify gate,
 * hard-abort on failure, before a browser is even launched; (2) resolve
 * every live id capture needs, over REST only; (3) run every master
 * against ONE fixed Playwright configuration (2400px width, 2x DPR, light
 * theme, no browser chrome — NFR4 determinism, Capture Spec §18); (4)
 * report captured vs blocked honestly (never a fabricated frame for a
 * master whose precondition failed — FR19).
 *
 * FULL BROWSER ISOLATION PER MASTER (not just a fresh `BrowserContext`):
 * confirmed live that a browser CRASH (M8, headless Chromium killed
 * mid-run — this box's `earlyoom` is configured with `--prefer
 * '(chrome|chromium)'`, i.e. it kills the browser first under memory
 * pressure) cascaded into "Target page, context or browser has been
 * closed" for M9 and M11, the two masters queued after it on the SAME
 * shared browser. A `browser.newContext()` cannot protect against the
 * BROWSER PROCESS itself dying — only a fresh `chromium.launch()` per
 * master can. The added cost (one browser launch + one UI login per
 * master, each roughly a second) is worth paying for the guarantee that
 * no master's failure can ever take another down with it.
 */
async function main(): Promise<void> {
  const frontendUrl = (process.env.CAPTURE_FRONTEND_URL?.trim() || 'http://localhost:5173').replace(/\/+$/, '');
  const apiUrl = (process.env.STAGING_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  const adminEmail = process.env.STAGING_ADMIN_EMAIL?.trim() || 'admin@axiome.local';
  const adminPassword = process.env.STAGING_ADMIN_PASSWORD?.trim() || 'admin';

  console.log('[capture] running the FR18 verify gate...');
  await runVerifyGate(apiUrl, adminEmail, adminPassword);
  console.log('[capture] verify gate PASSED — proceeding to capture.');

  const ctx = await resolveCaptureContext(apiUrl, adminEmail, adminPassword);
  mkdirSync(MASTERS_DIR, { recursive: true });

  const results: MasterResult[] = [];
  for (const master of MASTERS) {
    const result = await runOneMasterIsolated(master, frontendUrl, ctx);
    console.log(`[capture] ${master.id}: ${result.status === 'captured' ? `CAPTURED (${result.widthPx}x${result.heightPx})` : `BLOCKED — ${firstLine(result.detail)}`}`);
    results.push(result);
  }
  report(results);
  writeSummary(results);
  exitFor(results);
}

/** Every master — including the 10 that share the same `service` login —
 *  gets its OWN browser, launched and closed here, so one master's crash
 *  is contained to that one master's `try`. M12 needs no browser at all (a
 *  structural precondition check decides its outcome — see
 *  `m12FlowCytometry.ts`). M10 (AXI-1368 FIX 3) moved OFF this REST-only
 *  path once its precondition became satisfiable — it now needs the same
 *  browser every other master gets, to actually open Tiles → Complete view. */
async function runOneMasterIsolated(master: (typeof MASTERS)[number], frontendUrl: string, ctx: CaptureContext): Promise<MasterResult> {
  if (master.id === 'M12') {
    return runCaught(master, () => master.run(undefined as unknown as Page, frontendUrl, ctx));
  }
  return runCaught(master, async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR, colorScheme: COLOR_SCHEME });
      // Primed for EVERY master, not just the default-login ones — M8 (its
      // own external-stakeholder login) hit the identical "Select workspace
      // first" empty state live until this was widened; the org/workspace
      // top-menu selection is client-state every internal page reads,
      // regardless of which identity is logged in.
      await primeWorkspaceSelection(context, ctx.orgId, ctx.workspaceId, ctx.projectId);
      const page = await context.newPage();
      applyTimeouts(page);
      if (master.needsDefaultLogin) await ensureDefaultLogin(page, frontendUrl);
      return await master.run(page, frontendUrl, ctx);
    } finally {
      await browser.close().catch(() => undefined); // the browser may already be dead (the crash this isolation exists for) — closing a dead browser must never itself throw and mask the real error
    }
  });
}

async function runCaught(master: (typeof MASTERS)[number], run: () => Promise<MasterResult>): Promise<MasterResult> {
  try {
    return await run();
  } catch (err) {
    return blocked(master.id, master.id, err instanceof Error ? err.message : String(err));
  }
}

function firstLine(detail: string): string {
  return detail.split('\n')[0] ?? detail;
}

function report(results: MasterResult[]): void {
  const captured = results.filter((r) => r.status === 'captured').length;
  console.log(`[capture] DONE — ${captured}/${results.length} masters captured.`);
}

function writeSummary(results: MasterResult[]): void {
  writeFileSync(`${MASTERS_DIR}summary.json`, JSON.stringify(results, null, 2));
}

function exitFor(results: MasterResult[]): void {
  const captured = results.filter((r) => r.status === 'captured').length;
  if (captured === 0) {
    console.error('[capture] FAILED — zero masters captured.');
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('runCapture.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

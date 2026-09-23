import { existsSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { CaptureContext } from '../resolveCaptureContext';
import { ACTION_TIMEOUT_MS } from '../config';
import { gotoStable, shutter } from './common';
import { blocked } from './types';
import type { MasterResult } from './types';
import { Q12_SENTENCE } from '../../staging/steps/riazDescribeExpectations';

/**
 * M13 (AXI-1565, epic AXI-1555 — FR37/AC14) — the epic's objective in one
 * frame: Q12's describe result view, showing the deterministic sentence, the
 * `SUM-RANK-01 · match` connector chip, the bound parameters and the
 * platform's own recommended chart, above the ranked result table.
 *
 * Unlike M1–M12 this master does NOT belong to the SI-044 tenant: its subject
 * is the Riaz 2017 demo project, whose ids only exist once
 * `npm run stage:riaz-questions` has run. They are therefore read from that
 * step's trace (never hard-coded, never invented) and the workspace selection
 * is re-primed to the Riaz tenant before navigating — `runCapture.ts` primed
 * the SI-044 one, and the active workspace is client state every internal page
 * reads (`masters/common.ts`). No trace, no Q12 run, no describe result: the
 * master reports BLOCKED with the reason, exactly like every other
 * unsatisfiable precondition here — a capture is never fabricated.
 */
const ID = 'M13';
const TITLE = 'Describe result — Q12 sentence, connector match and recommended chart';

export const RIAZ_TRACE_PATH = process.env.STAGING_RIAZ_QUESTIONS_TRACE?.trim() || '../axiome-docs/demo/riaz-2017/riaz-questions-trace.json';

export interface Q12Target {
  orgId: string;
  workspaceId: string;
  projectId: string;
  analysisId: string;
  snapshotId: string;
  decisionId: string | null;
  sentence: string;
  connectorCode: string;
}

interface TraceFile {
  organizationId?: string | null;
  workspaceId?: string;
  projectId?: string;
  questions?: Array<{
    id: string;
    viewAnalysisId?: string | null;
    describe?: { results?: Array<{ snapshotId?: string; sentence?: string | null; citedConnector?: string | null; decision?: { id?: string } | null }> };
  }>;
}

/** The ids M13 navigates to, or the sentence saying why it cannot. */
export function resolveQ12Target(trace: TraceFile): Q12Target | string {
  const q12 = (trace.questions ?? []).find((q) => q.id === 'Q12');
  if (!q12) return 'the trace has no Q12 — run `npm run stage:riaz-questions -- --only Q12`';
  const result = q12.describe?.results?.[0];
  if (!result?.snapshotId || !q12.viewAnalysisId) return 'Q12 produced no describe result (the run failed, or the DESCRIBE carrier rules are not seeded)';
  if (!trace.organizationId || !trace.workspaceId || !trace.projectId) return 'the trace carries no org/workspace/project — re-run `stage:riaz-questions`';
  return {
    orgId: trace.organizationId,
    workspaceId: trace.workspaceId,
    projectId: trace.projectId,
    analysisId: q12.viewAnalysisId,
    snapshotId: result.snapshotId,
    decisionId: result.decision?.id ?? null,
    sentence: result.sentence ?? '',
    connectorCode: result.citedConnector ?? 'SUM-RANK-01',
  };
}

export function readTrace(path: string = RIAZ_TRACE_PATH): TraceFile | string {
  if (!existsSync(path)) return `no Riaz questions trace at ${path}`;
  return JSON.parse(readFileSync(path, 'utf8')) as TraceFile;
}

export async function captureM13(page: Page, baseUrl: string, _ctx: CaptureContext): Promise<MasterResult> {
  const trace = readTrace();
  if (typeof trace === 'string') return blocked(ID, TITLE, trace);
  const target = resolveQ12Target(trace);
  if (typeof target === 'string') return blocked(ID, TITLE, target);

  await primeRiazSelection(page, baseUrl, target);
  await gotoStable(page, `${baseUrl}/projects/${target.projectId}/view-analyses/${target.analysisId}?snapshotId=${target.snapshotId}`);

  const summary = page.locator('[data-testid="describe-result-summary"]');
  await summary.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  const sentence = summary.locator('[data-testid="describe-sentence-text"]');
  await sentence.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  const rendered = ((await sentence.textContent()) ?? '').trim();
  if (rendered !== Q12_SENTENCE) return blocked(ID, TITLE, `${ID}: precondition failed — sentence reads "${rendered}", expected "${Q12_SENTENCE}"`);
  const chip = summary.locator('[data-testid="describe-binding-chip"]');
  const verdict = await chip.getAttribute('data-verdict');
  if (verdict !== 'match') return blocked(ID, TITLE, `${ID}: precondition failed — binding chip verdict is "${verdict ?? 'none'}", expected "match"`);
  await page.locator('[data-testid="ga-recommended-chart"]').waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  return shutter(ID, TITLE, page);
}

/** Re-prime the top-menu selection onto the Riaz tenant (see the module note). */
async function primeRiazSelection(page: Page, baseUrl: string, target: Q12Target): Promise<void> {
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ([org, ws, proj]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-active-project', proj);
    },
    [target.orgId, target.workspaceId, target.projectId],
  );
}

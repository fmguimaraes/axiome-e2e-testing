import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RestClient } from '../client/RestClient';
import { STAGING_ACTIONS } from './actionCatalog';
import { extractRouteTable, findDuplicateRoutes } from './routeExtractor';
import { probeActions } from './probe';
import type { ActionAuditReport } from './types';

/**
 * FR15 CLI entrypoint — `npm run stage:audit`.
 *
 * Emits the machine-readable action→route audit (`action-route-audit.json`)
 * and a human summary (`action-route-audit.md`), then exits non-zero if any
 * staging action has no mapped/existing route that isn't a declared FR16 gap.
 */

const OQ2_FINDING = {
  question: 'OQ2 — is the failed-threshold surface (Capture Spec §8, optional third threshold) built?',
  answer: 'NOT BUILT — do not stage a third threshold in AXI-1376.',
  evidence:
    "`libs/contracts/src/threshold/threshold.patterns.ts` declares `ThresholdStatus = 'active' | 'superseded' | 'archived'` — no failed/breached/evaluative state exists. " +
    'A repo-wide grep for breach/violat/exceed near "threshold" in `apps/organization-service/src` and `libs/contracts/src` finds nothing threshold-evaluation-shaped. ' +
    'Thresholds are comparison rules (operator + value) rendered as chart lines; there is no server-side pass/fail evaluation to surface. ' +
    '(Static-analysis finding — no live tenant exists yet to create a real threshold and observe the API; AXI-1376 should re-confirm once data exists, but the contract has no field to hold the answer either way.)',
};

function defaultGatewaySrcPath(): string {
  return join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'axiome-back', 'apps', 'gateway', 'src');
}

function resolveGatewaySrcPath(): string {
  const configured = process.env.GATEWAY_SRC_PATH?.trim();
  if (configured) return configured;
  return defaultGatewaySrcPath();
}

function resolveBaseUrl(): string {
  return (process.env.STAGING_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
}

function buildReport(baseUrl: string, duplicates: string[], rows: ActionAuditReport['rows'], unresolved: string[]): ActionAuditReport {
  return {
    generatedAt: new Date().toISOString(),
    baseUrl,
    totalActions: rows.length,
    confirmed: rows.filter((r) => r.outcome === 'confirmed').length,
    gaps: rows.filter((r) => r.outcome === 'gap').length,
    rows,
    duplicateRouteFindings: duplicates,
    unresolvedBasePathFindings: unresolved,
    oq2: OQ2_FINDING,
  };
}

function renderMarkdown(report: ActionAuditReport): string {
  const lines = [
    `# Staging action → route audit`,
    ``,
    `Generated ${report.generatedAt} against \`${report.baseUrl}\`.`,
    ``,
    `${report.confirmed}/${report.totalActions} actions confirmed, ${report.gaps} declared gap(s).`,
    ``,
    `## Rows`,
    ``,
    `| Action | Method | Path | Outcome | Evidence |`,
    `|---|---|---|---|---|`,
    ...report.rows.map((r) => `| ${r.action.id} | ${r.action.method} | \`${r.probedPath}\` | ${r.outcome} | ${r.evidence.replace(/\|/g, '\\|')} |`),
    ``,
    `## Duplicate route declarations`,
    report.duplicateRouteFindings.length > 0 ? report.duplicateRouteFindings.map((d) => `- ${d}`).join('\n') : '- none found',
    ``,
    `## ${report.oq2.question}`,
    report.oq2.answer,
    ``,
    report.oq2.evidence,
    ``,
  ];
  return lines.join('\n');
}

function writeArtifacts(report: ActionAuditReport, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'action-route-audit.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, 'action-route-audit.md'), renderMarkdown(report));
}

function reportUnresolvedBasePaths(): string[] {
  // AXI-1369 finding: neither controller's @Controller decorator declares a `path`
  // — `{ version: '1' }` only — so the extractor correctly resolves the base path
  // to '' (routes hang directly off /api/v1/…), not an unresolved placeholder.
  return [
    "thresholds.controller.ts (`ThresholdsProxyController` + the annotations routes it also declares): @Controller({ version: '1' }) → base path '' → e.g. POST /api/v1/thresholds, POST /api/v1/annotations",
    "notifications.controller.ts (`NotificationsProxyController`): @Controller({ version: '1' }) → base path '' → e.g. GET /api/v1/notifications, GET /api/v1/activity",
  ];
}

async function main(): Promise<void> {
  const baseUrl = resolveBaseUrl();
  const gatewaySrc = resolveGatewaySrcPath();
  if (!existsSync(gatewaySrc)) {
    console.error(`GATEWAY_SRC_PATH does not exist: ${gatewaySrc}. Set it explicitly for this checkout layout.`);
    process.exit(2);
  }

  const routeTable = extractRouteTable(gatewaySrc);
  const duplicates = findDuplicateRoutes(routeTable);
  console.log(`extracted ${routeTable.length} routes from ${gatewaySrc}`);

  const client = new RestClient({ baseUrl });
  const rows = await probeActions(client, STAGING_ACTIONS);

  const report = buildReport(baseUrl, duplicates, rows, reportUnresolvedBasePaths());
  writeArtifacts(report, join('staging', 'audit'));

  console.log(renderMarkdown(report));

  const failed = rows.filter((r) => r.outcome === 'unexpected-missing');
  if (failed.length > 0) {
    console.error(`FAILED — ${failed.length} action(s) have no mapped/existing route (FR15):`);
    failed.forEach((r) => console.error(`  ${r.action.id}: ${r.action.method} ${r.probedPath}`));
    process.exit(1);
  }
  console.log('PASSED — every staging action is mapped to an existing route or a declared FR16 gap.');
}

if (process.argv[1] && process.argv[1].endsWith('runAudit.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

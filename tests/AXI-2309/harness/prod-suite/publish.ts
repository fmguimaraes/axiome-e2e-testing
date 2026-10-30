import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPORT_JSON, REPORT_MD, REPORT_SCHEMA_VERSION, type ProdSuiteReport } from './report';

/**
 * AXI-2318 — publishing a daily report (FR33, NFR3, NFR6).
 *
 * Decides WHAT is published and WHERE; the workflow only copies what this
 * produced. Only the two report files are ever published (`report.json`,
 * `report.md`) — never the Playwright HTML report, test-results or a
 * `trace.zip`, which record the test user's bearer token (NFR6). Each file is
 * scanned for token / credential shapes first, and a hit refuses the whole
 * publication (NFR3).
 *
 * S3 layout (the listing contract AXI-2320's admin page reads):
 *   `<prefix>/<YYYY-MM-DD>/<runId>/report.json|report.md`
 * Repo layout (the reports rule): `reports/AXI-2318/<YYYY-MM-DD>-prod-daily-<runId>/`.
 */

export const PUBLISHABLE_FILES: readonly string[] = [REPORT_JSON, REPORT_MD];
export const DEFAULT_S3_PREFIX = 'prod-e2e/daily';
export const REPORTS_STORY_DIR = 'reports/AXI-2318';

const SECRET_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/],
  ['bearer', /Bearer\s+[A-Za-z0-9._~+/-]{8,}/i],
  ['aws-access-key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['presigned-url', /X-Amz-(Signature|Credential)=/i],
  ['password-field', /"password"\s*:/i],
];

/** Names of every secret shape found in `text` (empty = clean). */
export function findSecretShapes(text: string): string[] {
  return SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Validate an S3 key prefix: path segments of `[A-Za-z0-9._-]`, no traversal. */
export function safePrefix(raw: string): string {
  const prefix = (raw || DEFAULT_S3_PREFIX).replace(/^\/+|\/+$/g, '');
  const ok = prefix.split('/').every((seg) => /^[A-Za-z0-9._-]+$/.test(seg) && seg !== '..' && seg !== '.');
  if (!ok) throw new Error(`unsafe S3 prefix: ${JSON.stringify(raw)}`);
  return prefix;
}

/** The UTC date (YYYY-MM-DD) a report belongs to — its start time. */
export function reportDate(report: ProdSuiteReport): string {
  const date = report.run.startedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('report.run.startedAt is not an ISO timestamp');
  return date;
}

export function s3KeyFor(prefix: string, report: ProdSuiteReport, file: string): string {
  return `${safePrefix(prefix)}/${reportDate(report)}/${report.run.runId}/${file}`;
}

export function repoDirFor(report: ProdSuiteReport): string {
  return `${REPORTS_STORY_DIR}/${reportDate(report)}-prod-daily-${report.run.runId}`;
}

export interface PublicationEntry {
  file: string;
  localPath: string;
  s3Key: string;
}

function readReport(dir: string): ProdSuiteReport {
  const jsonPath = path.join(dir, REPORT_JSON);
  if (!existsSync(jsonPath)) throw new Error(`no ${REPORT_JSON} in ${dir} — the suite did not produce a report`);
  const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as ProdSuiteReport;
  if (report?.schemaVersion !== REPORT_SCHEMA_VERSION) throw new Error(`unexpected report schemaVersion ${report?.schemaVersion}`);
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(report.run?.runId ?? '')) throw new Error('report.run.runId is not a safe path segment');
  return report;
}

/** Refuse the publication if any publishable file carries a secret shape (NFR3/NFR6). */
export function assertPublishable(dir: string): void {
  for (const file of PUBLISHABLE_FILES) {
    const shapes = findSecretShapes(readFileSync(path.join(dir, file), 'utf8'));
    if (shapes.length > 0) throw new Error(`refusing to publish ${file}: it carries ${shapes.join(', ')} (NFR3)`);
  }
}

/** Validate `reportDir` and return what goes where in S3. */
export function planPublication(reportDir: string, prefix: string): { report: ProdSuiteReport; entries: PublicationEntry[] } {
  const report = readReport(reportDir);
  assertPublishable(reportDir);
  const entries = PUBLISHABLE_FILES.map((file) => ({
    file, localPath: path.join(reportDir, file), s3Key: s3KeyFor(prefix, report, file),
  }));
  return { report, entries };
}

/** Stage the publishable files under `<repoRoot>/<repoDirFor(report)>/` for the commit job. */
export function stageForRepo(entries: PublicationEntry[], report: ProdSuiteReport, repoRoot: string): string {
  const target = path.join(repoRoot, repoDirFor(report));
  mkdirSync(target, { recursive: true });
  for (const entry of entries) copyFileSync(entry.localPath, path.join(target, entry.file));
  return target;
}

/** `localPath<TAB>s3Key` lines — the only list the workflow's upload loop reads. */
export function writePublicationPlan(entries: PublicationEntry[], outFile: string): void {
  writeFileSync(outFile, entries.map((e) => `${e.localPath}\t${e.s3Key}`).join('\n') + '\n');
}

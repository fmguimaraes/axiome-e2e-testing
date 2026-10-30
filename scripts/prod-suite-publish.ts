import { appendFileSync } from 'node:fs';
import path from 'node:path';
import {
  planPublication,
  stageForRepo,
  writePublicationPlan,
} from '../tests/AXI-2309/harness/prod-suite/publish';

/**
 * AXI-2318 — prepare a daily prod E2E report for publication (FR33, NFR6).
 *
 *   tsx scripts/prod-suite-publish.ts <reportDir> <stageRoot> [s3Prefix]
 *
 * Validates `<reportDir>/report.json` (schema, safe run id) and secret-scans the
 * two publishable files, then stages them under
 * `<stageRoot>/reports/AXI-2318/<date>-prod-daily-<runId>/` and writes
 * `<stageRoot>/publish-plan.tsv` (`<path relative to stageRoot>\t<s3 key>`).
 * The workflow's publish job uploads exactly those lines and its commit job
 * copies `<stageRoot>/reports/` into the repo. Nothing else is ever published.
 * Exits non-zero (publishing nothing) on any validation failure.
 */

function main(argv: string[]): void {
  const [reportDir, stageRoot, prefixArg] = argv;
  if (!reportDir || !stageRoot) throw new Error('usage: prod-suite-publish.ts <reportDir> <stageRoot> [s3Prefix]');
  const prefix = prefixArg ?? process.env.PROD_E2E_S3_PREFIX ?? '';
  const { report, entries } = planPublication(reportDir, prefix);
  const stagedDir = stageForRepo(entries, report, stageRoot);
  const staged = entries.map((e) => ({ ...e, localPath: path.relative(stageRoot, path.join(stagedDir, e.file)) }));
  writePublicationPlan(staged, path.join(stageRoot, 'publish-plan.tsv'));
  const repoDir = path.relative(stageRoot, stagedDir);
  console.log(`staged ${staged.length} file(s) for ${report.run.runId} (${report.status}) -> ${repoDir}`);
  for (const e of staged) console.log(`  ${e.localPath} -> s3://<bucket>/${e.s3Key}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `repo_dir=${repoDir}\nstatus=${report.status}\n`);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`prod-suite-publish: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

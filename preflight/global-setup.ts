import { runPreflight, INFRA_FAULT_EXIT_CODE } from './preflight';

/**
 * Playwright `globalSetup` — runs once before any test (FR9). On failure it
 * aborts the whole run with the reserved infrastructure-fault exit code so no
 * test executes and the failure is unmistakably an environment fault, not a
 * defect (FR10/FR28).
 */
export default async function globalSetup(): Promise<void> {
  const result = await runPreflight();
  if (result.ok) {
    return;
  }
  console.error('\n✗ E2E preflight failed — aborting before any test (infrastructure fault):');
  for (const failure of result.failures) {
    console.error(`  · ${failure}`);
  }
  console.error(`\nExiting ${INFRA_FAULT_EXIT_CODE} (reserved infrastructure-fault code, distinct from test failures).\n`);
  process.exit(INFRA_FAULT_EXIT_CODE);
}

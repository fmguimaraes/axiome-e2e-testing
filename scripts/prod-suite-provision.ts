import { createApiClient, fetchTransport, loginForToken } from '../tests/AXI-2309/harness/prod-suite/api-client';
import { readProdSuiteConfig } from '../tests/AXI-2309/harness/prod-suite/config';
import { provisionFixtures } from '../tests/AXI-2309/harness/prod-suite/fixtures';
import { verifyIsolation } from '../tests/AXI-2309/harness/prod-suite/isolation-guard';

/**
 * AXI-2318 — ONE-TIME upload of the prod-suite fixtures into the dedicated
 * test workspace (FR29 "uploaded once"). Run by the operator (the workflow's
 * `provision-fixtures` dispatch mode, or locally with the same env), never by
 * the daily run.
 *
 * Same env as the daily suite, except `PROD_E2E_FIXTURE_IDS` is not needed
 * (this is what produces it). The isolation guard runs FIRST (EC9): nothing is
 * uploaded unless the identity is confined to the test org. Idempotent — a
 * fixture whose bytes already exist in the workspace is reused, not re-uploaded.
 * Prints the JSON to store as the `PROD_E2E_FIXTURE_IDS` repo variable.
 */

async function main(): Promise<void> {
  const env = { ...process.env, PROD_E2E_FIXTURE_IDS: process.env.PROD_E2E_FIXTURE_IDS || '{}' };
  const result = readProdSuiteConfig(env);
  if (!result.ok) throw new Error(`missing configuration: ${result.missing.join(', ')}`);
  const cfg = result.config;
  const token = await loginForToken(cfg.apiBaseUrl, cfg.email, cfg.password);
  const client = createApiClient(
    { apiBaseUrl: cfg.apiBaseUrl, token, workspaceId: cfg.workspaceId, forbiddenIds: cfg.forbiddenOrgIds },
    fetchTransport,
  );
  await verifyIsolation(client, cfg);
  const ids = await provisionFixtures(client, cfg);
  console.log('Store this as the PROD_E2E_FIXTURE_IDS repository variable:');
  console.log(JSON.stringify(ids));
}

main().catch((err) => {
  console.error(`prod-suite-provision: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

/**
 * Environment resolution facade (AXI-1261).
 *
 * Single seam every spec and config reads instead of scattering `process.env`
 * lookups (DIP). Defaults target the local `make local-up` stack, so the suite
 * runs locally, in CI, and against a deployed environment by changing only these
 * variables — no spec, selector, or config edit (FR6/FR7, refined by AXI-1262).
 */

/** Read an env var, falling back to a default; empty string counts as unset. */
function fromEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

/** Strip a single trailing slash so callers can join paths uniformly. */
function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/** Front-end origin the browser drives. Default: local stack front-end. */
export const BASE_URL = normalizeOrigin(fromEnv('BASE_URL', 'http://localhost:5173'));

/** API origin used for setup/teardown and API-only specs. Default: local stack backend. */
export const API_BASE_URL = normalizeOrigin(fromEnv('API_BASE_URL', 'http://localhost:3000'));

/**
 * Public, browser-reachable object-storage endpoint (MinIO/S3). Browser-facing
 * artifact URLs must go through this, never the service-internal endpoint (FR8,
 * exercised by AXI-1262). Default: local MinIO public port.
 */
export const OBJECT_PUBLIC_URL = normalizeOrigin(fromEnv('OBJECT_PUBLIC_URL', 'http://localhost:9000'));

/**
 * Metabase origin for the Behavior Tracking read layer (AXI-1048). Default: the
 * local `make analytics-up` overlay port. Metabase is an optional overlay, not
 * part of the base `make local-up` stack — read-layer specs probe it and skip
 * when it is unreachable rather than failing the suite.
 */
export const METABASE_BASE_URL = normalizeOrigin(fromEnv('METABASE_BASE_URL', 'http://localhost:3001'));

/** True when running under CI (used for retry/artifact policy). */
export const IS_CI = /^(1|true)$/i.test(process.env.CI ?? '');

/**
 * Opt-in for specs that make REAL planner calls (`POST /guided-analysis/plan`
 * unmocked, which reaches Anthropic and is billed). Default OFF: an ordinary
 * suite run spends zero LLM tokens; a spec that needs the live provider skips
 * with {@link LIVE_LLM_SKIP_REASON} instead of silently running the bank.
 * Set `E2E_LIVE_LLM=1` deliberately, per run, when the spend is intended.
 * Route-intercepted planner specs (`page.route`) are free and never gated.
 */
export const LIVE_LLM = /^(1|true)$/i.test(process.env.E2E_LIVE_LLM ?? '');

/** Skip reason shared by every live-provider spec, so the report reads uniformly. */
export const LIVE_LLM_SKIP_REASON =
  'real Anthropic planner calls are opt-in — set E2E_LIVE_LLM=1 to run this spec (billed)';

/**
 * Dedicated test-mailbox credentials (AXI-2315 — FR24/NFR8). Reads the REAL
 * Mailjet-delivered password-reset email from a test inbox via API, never a
 * human checking a human inbox and never a committed credential. Absent in
 * most local/dev runs — the forgot-password scenario `test.skip()`s with
 * {@link TEST_MAILBOX_SKIP_REASON} rather than faking a result (EC11: a
 * missing seam must never read as a pass).
 */
export const TEST_MAILBOX_API_TOKEN = fromEnv('TEST_MAILBOX_API_TOKEN', '');
export const TEST_MAILBOX_INBOX_ID = fromEnv('TEST_MAILBOX_INBOX_ID', '');
export const TEST_MAILBOX_ACCOUNT_ID = fromEnv('TEST_MAILBOX_ACCOUNT_ID', '');
export const TEST_MAILBOX_ADDRESS = fromEnv('TEST_MAILBOX_ADDRESS', '');

export const HAS_TEST_MAILBOX = Boolean(
  TEST_MAILBOX_API_TOKEN && TEST_MAILBOX_INBOX_ID && TEST_MAILBOX_ACCOUNT_ID && TEST_MAILBOX_ADDRESS,
);

export const TEST_MAILBOX_SKIP_REASON =
  'no dedicated test mailbox configured — set TEST_MAILBOX_API_TOKEN/_INBOX_ID/_ACCOUNT_ID/_ADDRESS ' +
  '(never committed, NFR8) to run the real Mailjet-reset-email scenario';

/**
 * Write access to the daily prod-E2E report store the backend lists
 * (AXI-2320 — FR34). Used ONLY to seed fixture `report.json` objects into a
 * worktree-owned bucket so the admin listing has known data to show; must name
 * the SAME bucket/prefix the organization-service reads
 * (`PROD_E2E_REPORTS_BUCKET` / `PROD_E2E_S3_PREFIX`). Never pointed at the
 * production bucket. Absent ⇒ the seeded-data scenarios `test.skip()` with
 * {@link REPORT_STORE_SKIP_REASON}; the access-boundary scenarios still run.
 * Credentials are never committed (NFR3).
 */
export const REPORT_STORE_ENDPOINT = normalizeOrigin(fromEnv('E2E_REPORTS_S3_ENDPOINT', ''));
export const REPORT_STORE_BUCKET = fromEnv('E2E_REPORTS_S3_BUCKET', '');
export const REPORT_STORE_PREFIX = fromEnv('E2E_REPORTS_S3_PREFIX', 'prod-e2e/daily');
export const REPORT_STORE_REGION = fromEnv('E2E_REPORTS_S3_REGION', 'us-east-1');
export const REPORT_STORE_ACCESS_KEY = fromEnv('E2E_REPORTS_S3_ACCESS_KEY', '');
export const REPORT_STORE_SECRET_KEY = fromEnv('E2E_REPORTS_S3_SECRET_KEY', '');

export const HAS_REPORT_STORE = Boolean(
  REPORT_STORE_ENDPOINT && REPORT_STORE_BUCKET && REPORT_STORE_ACCESS_KEY && REPORT_STORE_SECRET_KEY,
);

export const REPORT_STORE_SKIP_REASON =
  'no seedable report store configured — set E2E_REPORTS_S3_ENDPOINT/_BUCKET/_ACCESS_KEY/_SECRET_KEY ' +
  '(the same bucket/prefix the backend lists; never the production bucket) to run the seeded-data scenarios';

/** Join an API path onto {@link API_BASE_URL} (leading slash optional). */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}/${path.replace(/^\/+/, '')}`;
}

/**
 * Build a browser-facing object-storage URL from the **public** endpoint
 * (FR8). Specs must reach uploads/downloads/presigned objects through this,
 * never the service-internal endpoint, which the browser cannot resolve.
 */
export function objectUrl(path: string): string {
  return `${OBJECT_PUBLIC_URL}/${path.replace(/^\/+/, '')}`;
}

export const env = { BASE_URL, API_BASE_URL, OBJECT_PUBLIC_URL, METABASE_BASE_URL, IS_CI, LIVE_LLM };

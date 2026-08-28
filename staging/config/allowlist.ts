/**
 * Base-URL allow-list guard (NFR2, EC10 — AXI-1369).
 *
 * The staging toolkit MUST refuse to run against any instance whose base URL
 * is not explicitly allow-listed, so it can never be pointed at production by
 * a copy-pasted env var or a stale shell. The list is exact-match only — no
 * wildcard, no suffix/prefix match — so "https://platform.axiomebio.com.evil.example"
 * or a forgotten "staging." prefix can never slip through.
 *
 * Defaults cover only the local `make local-up` stack. Anything else must be
 * added explicitly via `STAGING_ALLOWED_BASE_URLS` (comma-separated), which is
 * itself never allowed to be silently satisfied by a production-looking value —
 * see {@link assertNotProductionLike}.
 */

const DEFAULT_ALLOWED_BASE_URLS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

/** Domains that MUST NEVER appear in the allow-list, even if the operator adds them by mistake. */
const FORBIDDEN_SUBSTRINGS = ['axiomebio.com'];

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Read the allow-list from env, falling back to the local-stack defaults only. */
export function readAllowList(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.STAGING_ALLOWED_BASE_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const merged = [...DEFAULT_ALLOWED_BASE_URLS, ...extra].map(normalize);
  return [...new Set(merged)];
}

/** Hard stop even if an operator's env somehow adds a production-looking origin. */
function assertNotProductionLike(url: string): void {
  const lower = url.toLowerCase();
  const isForbidden = FORBIDDEN_SUBSTRINGS.some((s) => lower.includes(s));
  if (isForbidden) {
    throw new Error(`refusing to allow-list a production-looking base URL: ${url} (EC10)`);
  }
}

/**
 * Refuse to proceed unless `baseUrl` is exactly present in the allow-list
 * (NFR2/EC10). Throws rather than returning a boolean so a caller can never
 * accidentally ignore the result.
 */
export function assertAllowListed(baseUrl: string, allowList: string[] = readAllowList()): void {
  allowList.forEach(assertNotProductionLike);
  const target = normalize(baseUrl);
  if (!allowList.includes(target)) {
    throw new Error(
      `base URL "${target}" is not allow-listed for staging (NFR2/EC10). ` +
        `Allowed: [${allowList.join(', ')}]. Add it via STAGING_ALLOWED_BASE_URLS if intentional.`,
    );
  }
}

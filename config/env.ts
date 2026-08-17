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

/** True when running under CI (used for retry/artifact policy). */
export const IS_CI = /^(1|true)$/i.test(process.env.CI ?? '');

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

export const env = { BASE_URL, API_BASE_URL, OBJECT_PUBLIC_URL, IS_CI };

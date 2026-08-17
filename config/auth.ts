import type { APIRequestContext } from '@playwright/test';
import { apiUrl } from './env';
import type { Role } from './roles';

/**
 * Token acquisition for the auth setup project (AXI-1264).
 *
 * Obtains a role's tokens via the platform API (never the UI). A self-registering
 * role is created idempotently: try login, and only register when login fails so
 * a second run reuses the existing account (FR13 — no residue dependence between
 * runs, deterministic under NFR3).
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

async function login(api: APIRequestContext, role: Role): Promise<AuthTokens | null> {
  const res = await api.post(apiUrl('/api/v1/auth/login'), {
    data: { email: role.email, password: role.password },
  });
  return res.ok() ? tokensFrom(await res.json()) : null;
}

async function register(api: APIRequestContext, role: Role): Promise<AuthTokens> {
  const res = await api.post(apiUrl('/api/v1/auth/register'), {
    data: { email: role.email, password: role.password, firstName: 'E2E', lastName: role.name },
  });
  if (!res.ok()) {
    throw new Error(`register failed for ${role.name} (${res.status()}): ${await res.text()}`);
  }
  return tokensFrom(await res.json());
}

function tokensFrom(body: { accessToken: string; refreshToken: string }): AuthTokens {
  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

/** Ensure the role can authenticate and return fresh tokens. */
export async function ensureAuthTokens(api: APIRequestContext, role: Role): Promise<AuthTokens> {
  const existing = await login(api, role);
  if (existing) {
    return existing;
  }
  if (!role.selfRegister) {
    throw new Error(`login failed for non-self-registering role ${role.name} — is the seed applied?`);
  }
  await register(api, role);
  const afterRegister = await login(api, role);
  if (!afterRegister) {
    throw new Error(`login still failing after registering ${role.name}`);
  }
  return afterRegister;
}

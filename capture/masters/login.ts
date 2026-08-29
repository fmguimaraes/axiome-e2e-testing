import type { Page } from '@playwright/test';
import { IDENTITY_REGISTRY, findIdentity } from '../../staging/identities/registry';
import { resolvePassword } from '../../staging/identities/credentials';
import { ACTION_TIMEOUT_MS } from '../config';
import type { IdentityHandle } from '../../staging/identities/types';

/**
 * UI login (never the REST token pool) — a master's frame must show what a
 * real browser session renders for that identity, cookies/localStorage
 * included, not a REST-authenticated fetch. `Login.tsx` has no
 * `data-testid` (confirmed by source read); selectors below are the exact
 * ones the component renders (`input[type="email"]`, `input[type="password"]`,
 * `button[type="submit"]`), never CSS class/XPath (CONVENTIONS.md NFR5
 * spirit, applied here to the harness even though this isn't a `tests/`
 * spec).
 */
export async function loginAsUi(page: Page, baseUrl: string, handle: IdentityHandle): Promise<void> {
  const identity = findIdentity(handle, IDENTITY_REGISTRY);
  const password = resolvePassword(handle);
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="email"]').fill(identity.email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: ACTION_TIMEOUT_MS });
}

import { request as apiRequest, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import type { Actor } from './private-projects-fixtures';

/** AXI-2269 — an actor that can also drive the browser (carries its tokens). */
export interface UiActor extends Actor {
  email: string;
  accessToken: string;
  refreshToken: string;
}

const PASSWORD = 'AXI2269-e2e-pw!';

/** Register + login a throwaway user, scoped to `workspaceId` via X-Workspace-Id. */
export async function uiActor(label: string, workspaceId: string): Promise<UiActor> {
  const email = `axi2269-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const boot = await apiRequest.newContext();
  await boot.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2269', lastName: label },
  });
  const tokens = await (await boot.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } })).json();
  await boot.dispose();
  const api = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}`, 'X-Workspace-Id': workspaceId },
  });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { userId: me.id, api, email, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

/** Seed `page` with the actor's session and active workspace (the app reads both from localStorage). */
export async function signInAs(page: Page, actor: UiActor, workspaceId: string): Promise<void> {
  await page.addInitScript(
    ([access, refresh, ws]) => {
      localStorage.setItem('access_token', access as string);
      localStorage.setItem('refresh_token', refresh as string);
      localStorage.setItem('axiome-active-workspace', ws as string);
    },
    [actor.accessToken, actor.refreshToken, workspaceId] as const,
  );
}

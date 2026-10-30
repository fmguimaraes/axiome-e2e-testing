import { expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { apiUrl } from '../../../config/env';
import type { Api } from '../../AXI-1400/harness/api';
import type { Tenant } from '../../AXI-1400/harness/seed';
import { drainGoverned } from './opening-templates';
import { gotoSettled } from './new-analysis';

/**
 * AXI-2327 (epic AXI-2308 — FR29, FR30, FR32, FR35) — helpers for the result page spec: throwaway
 * membership-only people (Investigator, Reviewer, outsider), a wizard-run launch (the one request
 * the wizard's Run makes), a UI sign-in on either surface, and a read of the drawn chart's traces.
 * Condition polls only (a harness, never a `*.spec.ts` — AXI-1265/NFR4).
 */

export const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
export const REVIEWER_ROLE_ID = '00000000-0000-0000-0000-000000000101';
export const PASSWORD = 'AXI2327-e2e-pw!';
export const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';

export interface Person {
  email: string;
  userId: string;
  accessToken: string;
  api: APIRequestContext;
}

export function unique(label: string): string {
  return `axi2327-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** A self-registered user scoped to `workspaceId` — NOT yet a member of it. */
export async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `${unique(label)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2327', lastName: label },
  });
  expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': workspaceId },
  });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { email, userId: me.id, accessToken, api };
}

/** Add `p` to the tenant's workspace by membership role id (as the platform admin). */
export async function addMember(admin: Api, t: Tenant, p: Person, roleId: string): Promise<void> {
  const res = await admin.post(`/api/v1/workspaces/${t.workspaceId}/members`, { userId: p.userId, organizationId: t.orgId, roleId }, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

export interface Slot {
  slot: string;
  value: string | string[];
}

/** The wizard's Run body for `templateId` with every answer `decided` (no question span). */
export function wizardBody(t: Tenant, dataset: unknown, templateId: string, question: string, intent: string, slots: Slot[]) {
  const answeredAt = new Date().toISOString();
  return {
    projectId: t.projectId, dataset, question, intent, intentSource: 'chosen', templateId,
    slots: slots.map((s) => ({ ...s, provenance: 'decided', answeredAt })),
  };
}

/** Launch through the wizard's own request as the admin harness; returns the governed run id once settled. */
export async function launchAndDrain(api: Api, t: Tenant, body: unknown): Promise<string> {
  const res = await api.post(WIZARD_RUNS, body, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
  await drainGoverned(api, t, res.body.runId);
  return res.body.runId;
}

/** The same launch as a throwaway person (his own token); returns the run id once settled. */
export async function launchAs(p: Person, admin: Api, t: Tenant, body: unknown): Promise<string> {
  const res = await p.api.post(apiUrl(WIZARD_RUNS), { data: body });
  const answer = await res.json();
  expect(res.status(), JSON.stringify(answer)).toBe(200);
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  await drainGoverned(admin, t, answer.runId);
  return answer.runId;
}

/** Sign in through the UI with the tenant in scope, then open `landing`. */
export async function signIn(page: Page, p: Person, t: Tenant, landing: string): Promise<void> {
  await page.addInitScript(
    ([org, ws, project]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-active-project', project);
    },
    [t.orgId, t.workspaceId, t.projectId] as const,
  );
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(p.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
  await gotoSettled(page, landing);
}

export interface DrawnTrace {
  type: string;
  name: string | null;
  color: string | null;
}

/** The traces Plotly drew in the result figure: type, group name and marker colour. */
export async function drawnTraces(page: Page): Promise<DrawnTrace[]> {
  const plot = page.getByTestId('rp-chart').locator('.js-plotly-plot');
  await expect(plot).toBeVisible({ timeout: 30_000 });
  return plot.evaluate((el) =>
    ((el as unknown as { data?: Array<Record<string, any>> }).data ?? []).map((t) => ({
      type: String(t.type),
      name: typeof t.name === 'string' ? t.name : null,
      color: typeof t.marker?.color === 'string' ? t.marker.color : null,
    })),
  );
}

/** Wait until the drawn box traces carry these colours by group name (the raw sample loads async). */
export async function expectGroupColours(page: Page, expected: Record<string, string>): Promise<void> {
  await expect
    .poll(async () => {
      const traces = (await drawnTraces(page)).filter((t) => t.type === 'box' && t.name !== null);
      return Object.fromEntries(traces.map((t) => [t.name as string, t.color]));
    }, { timeout: 30_000 })
    .toEqual(expected);
}

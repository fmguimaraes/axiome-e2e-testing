import { expect, request as apiRequest, type Page } from '@playwright/test';
import { apiUrl } from '../../../config/env';
import { PrivateProjectsWorld, access, type Actor } from '../../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../../AXI-1904/harness/tours';
import { gotoSettled } from '../../AXI-2308/harness/new-analysis';
import { PlanQuestionStub, STUB_ID } from './plan-question-stub';

/**
 * AXI-2590 (epic AXI-2567) — the REAL part of the Plan a question specs: a throwaway workspace
 * (never MAG4 / AP-HM), a self-registered INVESTIGATOR, a throwaway project the owner grants to
 * them. Torn down in `dispose()` (project deleted, actors disposed). The SAP routes are the
 * `PlanQuestionStub` double.
 */

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2590-e2e-pw!';

interface Person extends Actor { email: string; accessToken: string }

export class PlanQuestionWorld {
  world!: PrivateProjectsWorld;
  investigator!: Person;
  owner!: Actor;
  projectId!: string;

  static async create(label: string): Promise<PlanQuestionWorld> {
    const w = new PlanQuestionWorld();
    w.world = await PrivateProjectsWorld.create();
    w.investigator = await w.person(label);
    await w.world.addMember(w.investigator, { roleId: INVESTIGATOR_ROLE_ID });
    w.owner = await w.world.actor('owner');
    await w.world.addMember(w.owner, 'editor');
    await w.world.leaveWorkspace();
    await silenceTours(w.investigator.accessToken);
    const res = await w.owner.api.post(apiUrl('/api/v1/projects'), { data: { name: `E2E AXI-2590 ${label} ${Date.now()}`, workspaceId: w.world.workspaceId } });
    expect(res.status(), await res.text()).toBe(201);
    w.projectId = (await res.json()).id;
    const grant = await access.grant(w.owner, w.projectId, w.investigator.userId);
    expect(grant.status(), await grant.text()).toBeLessThan(300);
    return w;
  }

  private async person(label: string): Promise<Person> {
    const email = `axi2590-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
    const bootstrap = await apiRequest.newContext();
    const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), { data: { email, password: PASSWORD, firstName: 'AXI2590', lastName: label } });
    expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
    const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
    expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
    const { accessToken } = await login.json();
    await bootstrap.dispose();
    const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': this.world.workspaceId } });
    const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
    return { email, accessToken, userId: me.id, api };
  }

  /** Sign in as the investigator, then open `path` (relative to the investigator project). */
  async open(page: Page, stub: PlanQuestionStub, path = `sap/questions/${STUB_ID}`): Promise<void> {
    await stub.install(page);
    await page.addInitScript(([org, ws, p]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-active-project', p);
    }, [this.world.orgId, this.world.workspaceId, this.projectId] as const);
    await gotoSettled(page, '/login');
    await page.locator('input[type="email"]').fill(this.investigator.email);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
    await gotoSettled(page, `/investigator/projects/${this.projectId}/${path}`);
  }

  async dispose(): Promise<void> {
    if (this.projectId) await this.owner?.api.delete(apiUrl(`/api/v1/projects/${this.projectId}`)).catch(() => undefined);
    await this.investigator?.api.dispose();
    await this.world?.dispose();
  }
}

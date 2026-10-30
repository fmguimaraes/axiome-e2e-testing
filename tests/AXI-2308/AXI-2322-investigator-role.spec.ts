import { randomUUID } from 'crypto';
import { APIRequestContext, APIResponse, expect, request as apiRequest, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';

/**
 * AXI-2322 (epic AXI-2308 — Platform Opening: Human Guided) — the Investigator
 * role, its server-side refusals and the role-selected login surface.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md`
 * § AXI-2322 §1–§5. Self-provisioned: a fresh fixture workspace with ONE
 * Investigator member and ONE Editor (team) member, both throwaway
 * self-registered users; the platform admin creates the workspace and the two
 * memberships, then leaves it. No seeded or demo account is signed in through
 * the UI, and every FR5 probe is a refused call, so nothing shared is mutated.
 *
 * Fresh storage state for every test (the login flow is under test).
 */

test.use({ storageState: { cookies: [], origins: [] } });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const INVESTIGATOR_DENIED = 'This endpoint is not available to the Investigator role';
const PASSWORD = 'AXI2322-e2e-pw!';

interface Person {
  email: string;
  userId: string;
  accessToken: string;
  api: APIRequestContext;
}

let world: PrivateProjectsWorld;
let investigator: Person;
let teamUser: Person;
let worldB: PrivateProjectsWorld | undefined;

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2322-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2322', lastName: label },
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

async function messageOf(res: APIResponse): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text);
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message ?? '');
  } catch {
    return text;
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  teamUser = await person('editor', world.workspaceId);
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  await world.addMember(teamUser, 'editor');
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);
  await silenceTours(teamUser.accessToken);
});

test.afterAll(async () => {
  await worldB?.dispose();
  await investigator?.api.dispose();
  await teamUser?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2322 Investigator role — server side @SI-001 @SI-010 @SI-011', () => {
  test('AC2 — §1 the seeded Investigator role is recognised and selects the investigator surface @SI-011 @SI-001', async () => {
    // Arrange
    const role = await world.admin.get(apiUrl(`/api/v1/roles/${INVESTIGATOR_ROLE_ID}`));

    // Act
    const investigatorSurface = await investigator.api.get(apiUrl('/api/v1/surface'));
    const teamSurface = await teamUser.api.get(apiUrl('/api/v1/surface'));

    // Assert
    expect(role.status()).toBe(200);
    const body = await role.json();
    expect(body.name).toBe('Investigator');
    expect(body.scope).toBe('WORKSPACE');
    expect(body.permissions).toEqual(
      expect.arrayContaining([
        'sponsor-review:access',
        'sponsor-review:comment',
        'sponsor-review:export',
        'dataset:upload',
        'dataset:delete_own',
        'guided_analysis:run',
        'governed_execution:submit',
      ]),
    );
    expect(body.permissions).not.toContain('governed_execution:approve');
    expect(body.permissions).not.toContain('governs_analysis_parameters');
    expect(investigatorSurface.status()).toBe(200);
    expect(await investigatorSurface.json()).toEqual({ surface: 'investigator' });
    expect(teamSurface.status()).toBe(200);
    expect(await teamSurface.json()).toEqual({ surface: 'team' });
  });

  test('AC2 — §1 the membership persists the Reviewer tier in the legacy column, the Investigator role by id @SI-001', async () => {
    // Arrange / Act — read by the team member (the admin has left the workspace)
    const workspace = await teamUser.api.get(apiUrl(`/api/v1/workspaces/${world.workspaceId}`));

    // Assert
    expect(workspace.ok(), `workspace: ${workspace.status()}`).toBe(true);
    const rows: Array<{ userId: string; role?: string; roleId?: string }> = (await workspace.json()).members ?? [];
    const row = rows.find((m) => m.userId === investigator.userId);
    expect(row?.roleId).toBe(INVESTIGATOR_ROLE_ID);
    expect(row?.role).toBe('sponsor_viewer');
  });

  test('AC4 — §2 every FR5 endpoint refuses the Investigator with 403, server-side @SI-010', async () => {
    // Arrange
    const ws = world.workspaceId;
    const anyId = randomUUID();
    const probes: Array<[string, () => Promise<APIResponse>]> = [
      ['GET /rules', () => investigator.api.get(apiUrl('/api/v1/rules'))],
      ['GET /admin/rulesets', () => investigator.api.get(apiUrl('/api/v1/admin/rulesets'))],
      ['GET /rule-families', () => investigator.api.get(apiUrl('/api/v1/rule-families'))],
      ['GET /rules/acquisitions/capabilities', () => investigator.api.get(apiUrl('/api/v1/rules/acquisitions/capabilities'))],
      ['GET /rule-runs/operations', () => investigator.api.get(apiUrl('/api/v1/rule-runs/operations'))],
      ['GET /rule-runs/offered-rules', () => investigator.api.get(apiUrl('/api/v1/rule-runs/offered-rules'))],
      ['GET /workspaces/:ws/analysis-policy', () => investigator.api.get(apiUrl(`/api/v1/workspaces/${ws}/analysis-policy`))],
      ['GET /semantic-profiles/workspace/:ws/policy', () => investigator.api.get(apiUrl(`/api/v1/semantic-profiles/workspace/${ws}/policy`))],
      ['GET /workflows/provenance/projection', () => investigator.api.get(apiUrl('/api/v1/workflows/provenance/projection'))],
      ['POST /workspaces', () => investigator.api.post(apiUrl('/api/v1/workspaces'), { data: { name: 'axi2322-must-not-exist', type: 'internal' } })],
      ['PATCH /workspaces/:ws', () => investigator.api.patch(apiUrl(`/api/v1/workspaces/${ws}`), { data: { description: 'axi2322-must-not-change' } })],
      ['POST /workspaces/:ws/members', () => investigator.api.post(apiUrl(`/api/v1/workspaces/${ws}/members`), { data: { userId: investigator.userId, organizationId: world.orgId, role: 'admin' } })],
      ['POST /projects', () => investigator.api.post(apiUrl('/api/v1/projects'), { data: { name: 'axi2322-must-not-exist', workspaceId: ws } })],
      // Review bounce #1 (F2): the team-administration controllers the first pass missed
      ['GET /teams', () => investigator.api.get(apiUrl('/api/v1/teams'))],
      ['GET /roles', () => investigator.api.get(apiUrl('/api/v1/roles'))],
      ['GET /users', () => investigator.api.get(apiUrl('/api/v1/users'))],
      ['GET /audit-logs', () => investigator.api.get(apiUrl('/api/v1/audit-logs'))],
      // Review bounce #2 (F3): writes and lineage/provenance/audit routes that sat on "allowed"
      // controllers. Ids are random — the deny answers before any lookup could 404.
      ['POST /projects/:p/client-exploration/enable', () => investigator.api.post(apiUrl(`/api/v1/projects/${anyId}/client-exploration/enable`), { data: {} })],
      ['POST /projects/:p/client-exploration/members', () => investigator.api.post(apiUrl(`/api/v1/projects/${anyId}/client-exploration/members`), { data: { email: 'axi2322@example.org' } })],
      ['PUT /projects/:p/client-exploration/proposals/:id/approve', () => investigator.api.put(apiUrl(`/api/v1/projects/${anyId}/client-exploration/proposals/${anyId}/approve`), { data: {} })],
      ['GET /derived-evidence/:id/lineage', () => investigator.api.get(apiUrl(`/api/v1/derived-evidence/${anyId}/lineage`))],
      ['POST /de-evidence-references/:id/finalize', () => investigator.api.post(apiUrl(`/api/v1/de-evidence-references/${anyId}/finalize`), { data: {} })],
      ['POST /rule-runs', () => investigator.api.post(apiUrl('/api/v1/rule-runs'), { data: {} })],
      ['POST /workspaces/:ws/datasets/:id/query', () => investigator.api.post(apiUrl(`/api/v1/workspaces/${ws}/datasets/${anyId}/query`), { data: {} })],
      ['GET /view-analyses/evidences/:id/versions/1/audit-report', () => investigator.api.get(apiUrl(`/api/v1/view-analyses/evidences/${anyId}/versions/1/audit-report`))],
    ];

    // Act
    const outcomes: string[] = [];
    for (const [label, call] of probes) {
      const res = await call();
      outcomes.push(`${label} -> ${res.status()} ${await messageOf(res)}`);
    }

    // Assert
    expect(outcomes).toEqual(probes.map(([label]) => `${label} -> 403 ${INVESTIGATOR_DENIED}`));
  });

  test('AC4 — §2 without the workspace header an Investigator-only user is still refused @SI-010', async () => {
    // Arrange / Act
    const res = await investigator.api.get(apiUrl('/api/v1/rules'), { headers: { 'X-Workspace-Id': '' } });

    // Assert
    expect(res.status()).toBe(403);
    expect(await messageOf(res)).toBe(INVESTIGATOR_DENIED);
  });

  test('AC1/AC4 — §3 a team user is not refused by the Investigator deny (NFR2) @SI-010', async () => {
    // Arrange
    const ws = world.workspaceId;

    // Act
    const rules = await teamUser.api.get(apiUrl('/api/v1/rules'));
    const operations = await teamUser.api.get(apiUrl('/api/v1/rule-runs/operations'));
    const policy = await teamUser.api.get(apiUrl(`/api/v1/workspaces/${ws}/analysis-policy`));
    const lineage = await teamUser.api.get(apiUrl(`/api/v1/derived-evidence/${randomUUID()}/lineage`));

    // Assert
    expect(rules.status()).toBe(200);
    expect(operations.status()).toBe(200);
    expect(policy.status()).toBe(200);
    // review bounce #2: a newly denied controller still serves the team (a miss, never the deny)
    expect(await messageOf(lineage)).not.toBe(INVESTIGATOR_DENIED);
  });
});

test.describe('AXI-2322 Investigator role — login surface @SI-030 @SI-066', () => {
  /** The team Layout's sidebar collapse toggle — present only on the team UI. */
  const teamSidebarToggle = (page: import('@playwright/test').Page) =>
    page.getByRole('button', { name: /^(Collapse|Expand)$/ });

  async function signIn(page: import('@playwright/test').Page, who: Person): Promise<void> {
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(who.email);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
  }

  test('AC1/AC4 — §4 the Investigator lands on /investigator, team routes send him back, sign out returns to login @SI-030 @SI-066', async ({ page }) => {
    // Arrange / Act
    await signIn(page, investigator);

    // Assert — landing
    await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
    await expect(page.getByTestId('investigator-surface')).toBeVisible();
    await expect(page.getByTestId('investigator-home')).toBeVisible();
    await expect(teamSidebarToggle(page)).toHaveCount(0);

    // Act / Assert — team routes redirect (EC10)
    for (const route of ['/projects', '/rules']) {
      await page.goto(route);
      await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
      await expect(page.getByTestId('investigator-surface')).toBeVisible();
    }

    // Act / Assert — sign out
    await page.getByTestId('investigator-logout').click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 });
  });

  test('AC1 — §5 a team user stays on the team UI and /investigator sends him home @SI-030', async ({ page }) => {
    // Arrange / Act
    await signIn(page, teamUser);

    // Assert
    await expect(page).not.toHaveURL(/\/login$/, { timeout: 30_000 });
    await expect(page.getByTestId('surface-resolving')).toHaveCount(0, { timeout: 30_000 });
    await expect(teamSidebarToggle(page)).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).pathname.startsWith('/investigator')).toBe(false);
    await expect(page.getByTestId('investigator-surface')).toHaveCount(0);

    // Act / Assert — the investigator prefix is not a team route
    await page.goto('/investigator');
    await expect(page).not.toHaveURL(/\/investigator/, { timeout: 30_000 });
    await expect(page.getByTestId('investigator-surface')).toHaveCount(0);
  });
});

/**
 * Review bounce #1 (F1) — the header steer. The SAME person is Investigator in
 * workspace A and Admin in workspace B; every request carries `X-Workspace-Id: B`.
 * The refusal follows the ACTION TARGET (A), never the header; an action that
 * really targets B passes; a route with no derivable target refuses him (fail
 * closed). Runs LAST: once he holds a team role, /surface answers 'team'.
 */
test.describe('AXI-2322 Investigator role — mixed membership cannot steer the deny with the header @SI-010', () => {
  test('AC4 — §6 Investigator in A + Admin in B: header B never unlocks an action on A @SI-010', async () => {
    // Arrange — B is a second fixture workspace where the Investigator is Admin
    worldB = await PrivateProjectsWorld.create();
    await worldB.addMember(investigator, 'admin');
    await worldB.leaveWorkspace();
    const wsA = world.workspaceId;
    const wsB = worldB.workspaceId;
    const created = await teamUser.api.post(apiUrl('/api/v1/projects'), {
      data: { name: `axi2322-project-in-A-${Date.now()}`, workspaceId: wsA },
    });
    expect(created.status(), `team create in A: ${await created.text()}`).toBe(201);
    const projectA = (await created.json()).id as string;
    const steered = await apiRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${investigator.accessToken}`, 'X-Workspace-Id': wsB },
    });

    // Act
    const onA: Array<[string, APIResponse]> = [
      ['POST /projects {A}', await steered.post(apiUrl('/api/v1/projects'), { data: { name: 'axi2322-must-not-exist', workspaceId: wsA } })],
      ['PATCH /projects/:A-project', await steered.patch(apiUrl(`/api/v1/projects/${projectA}`), { data: { description: 'axi2322-must-not-change' } })],
      ['DELETE /projects/:A-project', await steered.delete(apiUrl(`/api/v1/projects/${projectA}`))],
      ['PATCH /workspaces/:A', await steered.patch(apiUrl(`/api/v1/workspaces/${wsA}`), { data: { description: 'axi2322-must-not-change' } })],
      ['GET /rules (no target)', await steered.get(apiUrl('/api/v1/rules'))],
      ['GET /teams (no target)', await steered.get(apiUrl('/api/v1/teams'))],
    ];
    const onB = await steered.patch(apiUrl(`/api/v1/workspaces/${wsB}`), { data: { description: 'axi2322 admin of B' } });
    const createB = await steered.post(apiUrl('/api/v1/projects'), { data: { name: `axi2322-project-in-B-${Date.now()}`, workspaceId: wsB } });
    const strangerInB = await teamUser.api.post(apiUrl('/api/v1/projects'), { data: { name: 'axi2322-must-not-exist', workspaceId: wsB } });

    // Assert — every action on A is the Investigator refusal, whatever the header says
    const outcomes: string[] = [];
    for (const [label, res] of onA) outcomes.push(`${label} -> ${res.status()} ${await messageOf(res)}`);
    expect(outcomes).toEqual(onA.map(([label]) => `${label} -> 403 ${INVESTIGATOR_DENIED}`));
    const stillThere = await teamUser.api.get(apiUrl(`/api/v1/projects/${projectA}`));
    expect(stillThere.status()).toBe(200);
    expect((await stillThere.json()).description ?? null).not.toBe('axi2322-must-not-change');
    // ... his team role in B still works where B is the real target (NFR2)
    expect(onB.ok(), `PATCH B: ${onB.status()} ${await messageOf(onB)}`).toBe(true);
    expect(createB.status(), `create in B: ${await messageOf(createB)}`).toBe(201);
    // ... and POST /projects now authorizes the body workspace for everyone (pre-existing IDOR closed)
    expect(strangerInB.status()).toBe(403);
    expect(await messageOf(strangerInB)).toBe('You are not a member of the target workspace');

    // Cleanup — his own project in B (team target), the team user's project in A
    await steered.delete(apiUrl(`/api/v1/projects/${(await createB.json()).id}`));
    await teamUser.api.delete(apiUrl(`/api/v1/projects/${projectA}`));
    await steered.dispose();
  });
});

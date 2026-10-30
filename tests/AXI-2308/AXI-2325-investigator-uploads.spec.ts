import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { APIResponse, Page, expect, request as apiRequest, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld, uploadCsvDataset } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from './harness/new-analysis';

/**
 * AXI-2325 (epic AXI-2308 — Platform Opening: Human Guided) — the Investigator's uploads:
 * the upload screen, his project's uploads table with inline icon actions, and the delete
 * button driving the Headless soft-delete (AXI-2314). The four routes it opens for the
 * Investigator each carry their own server-side check — proven here by direct calls as
 * well as through the page (FR11, FR12, FR18, AC10, EC6, NFR1).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2325
 * (.3–.8). Self-provisioned: a fresh fixture workspace with a team Admin, a team Editor
 * and one Investigator (all throwaway self-registered users); the platform admin creates
 * the workspace and the memberships, then leaves it. A second fixture workspace holds the
 * IDOR targets. Fresh storage state per test — the Investigator signs in through the UI.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const NOT_OWN_UPLOAD = 'Only your own uploads can be changed or deleted';
const INVESTIGATOR_LINK_REFUSED = 'An Investigator can only add his own upload to a project of the same workspace';
const PASSWORD = 'AXI2325-e2e-pw!';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLSX = readFileSync(path.join(process.cwd(), 'tests', 'AXI-2308', 'fixtures', 'investigator-upload-paul.xlsx'));
/** Upload → ingestion on the shared bio-compute; a cold ingest can take a while. */
const READY_MS = 180_000;

interface Person extends Actor {
  email: string;
  accessToken: string;
}

let world: PrivateProjectsWorld;
let worldB: PrivateProjectsWorld;
let investigator: Person;
let teamAdmin: Actor;
let editor: Actor;
let adminB: Actor;
let projectId: string;
let projectB: string;

const datasets = (ws: string, suffix = '') => apiUrl(`/api/v1/workspaces/${ws}/datasets${suffix}`);

function unique(label: string): string {
  return `axi2325-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `${unique(label)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2325', lastName: label },
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
  return { email, accessToken, userId: me.id, api };
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

async function newProject(a: Actor, ws: string, name: string): Promise<string> {
  const res = await a.api.post(apiUrl('/api/v1/projects'), { data: { name: `E2E AXI-2325 ${name} ${Date.now()}`, workspaceId: ws } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

/** The Investigator's own upload through the API — the page's exact sequence. */
async function investigatorUpload(name: string): Promise<string> {
  const ws = world.workspaceId;
  const init = await investigator.api.post(datasets(ws), {
    data: { organizationId: world.orgId, originalFilename: name, contentType: XLSX_TYPE, performedBy: investigator.userId },
  });
  expect(init.status(), `initiate: ${await init.text()}`).toBe(201);
  const { dataset, presignedUrl } = await init.json();
  const put = await fetch(presignedUrl, { method: 'PUT', headers: { 'content-type': XLSX_TYPE }, body: XLSX });
  expect(put.ok, `presigned PUT ${put.status}`).toBe(true);
  const fin = await investigator.api.patch(datasets(ws, `/${dataset.id}/finalize`), { data: { performedBy: investigator.userId } });
  expect(fin.ok(), `finalize: ${fin.status()} ${await fin.text()}`).toBe(true);
  const link = await investigator.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), {
    data: { datasetId: dataset.id, linkedBy: investigator.userId },
  });
  expect(link.status(), `link: ${await link.text()}`).toBe(201);
  return dataset.id;
}

async function linkedIds(a: Actor, project: string): Promise<string[]> {
  const res = await a.api.get(apiUrl(`/api/v1/projects/${project}/datasets`));
  expect(res.ok(), `project datasets: ${res.status()}`).toBe(true);
  return ((await res.json()) as Array<{ datasetId: string }>).map((l) => l.datasetId);
}

async function signInToUploads(page: Page): Promise<void> {
  await page.addInitScript(
    ([org, ws, project]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-active-project', project);
    },
    [world.orgId, world.workspaceId, projectId] as const,
  );
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(investigator.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
  await gotoSettled(page, '/investigator/uploads');
  await expect(page.getByTestId('investigator-uploads')).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  teamAdmin = await world.actor('team-admin');
  editor = await world.actor('editor');
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  await world.addMember(teamAdmin, 'admin');
  await world.addMember(editor, 'editor');
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);
  projectId = await newProject(teamAdmin, world.workspaceId, 'study');

  worldB = await PrivateProjectsWorld.create();
  adminB = await worldB.actor('admin-b');
  await worldB.addMember(adminB, 'admin');
  await worldB.leaveWorkspace();
  projectB = await newProject(adminB, worldB.workspaceId, 'foreign');
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await worldB?.dispose();
  await world?.dispose();
});

test.describe('AXI-2325 Investigator uploads — the page @SI-066 @SI-010 @SI-013', () => {
  test('AC10 — §3 an uploaded xlsx appears in the uploads table with inline icon actions @SI-066 @SI-010 @SI-013', async ({ page }) => {
    // Arrange
    await signInToUploads(page);
    const name = `${unique('upload')}.xlsx`;

    // Act
    await page.getByTestId('upload-input').setInputFiles({ name, mimeType: XLSX_TYPE, buffer: XLSX });

    // Assert — the row is the server's answer, and it settles to Ready without a reload
    const row = page.locator(`[data-upload-name="${name}"]`);
    await expect(row).toBeVisible({ timeout: 60_000 });
    const id = (await row.getAttribute('data-testid'))!.replace('upload-row-', '');
    await expect(page.getByTestId(`upload-status-${id}`)).toHaveText('Ready', { timeout: READY_MS });
    await expect(row).toContainText('You');
    await expect(page.getByTestId(`upload-analyse-${id}`)).toBeEnabled();
    await expect(page.getByTestId(`upload-delete-${id}`)).toBeVisible();
    await expect(page.getByRole('button', { name: /^back$/i })).toHaveCount(0);
    expect(await linkedIds(teamAdmin, projectId)).toContain(id);
    const read = await teamAdmin.api.get(datasets(world.workspaceId, `/${id}`));
    expect(read.status()).toBe(200);
    const body = await read.json();
    expect(body.uploadedBy).toBe(investigator.userId);
  });

  test('AC10 — §4 deleting his own uncited upload soft-deletes it through the Headless API @SI-066 @SI-010', async ({ page }) => {
    // Arrange
    const name = `${unique('own')}.xlsx`;
    const id = await investigatorUpload(name);
    await signInToUploads(page);
    await expect(page.getByTestId(`upload-row-${id}`)).toBeVisible({ timeout: 30_000 });
    const deleteCall = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes(`/datasets/${id}`));

    // Act
    await page.getByTestId(`upload-delete-${id}`).click();
    await page.getByTestId(`upload-delete-confirm-${id}`).click();

    // Assert
    expect((await deleteCall).status()).toBe(204);
    await expect(page.getByTestId(`upload-row-${id}`)).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('upload-delete-refusal')).toHaveCount(0);
    expect((await teamAdmin.api.get(datasets(world.workspaceId, `/${id}`))).status()).toBe(404);
  });

  test('AC10/EC6 — §5 a cited upload shows the refusal and its reason, and nothing is deleted @SI-066 @SI-010', async ({ page }) => {
    // Arrange — the team admin cites the Investigator's upload in a published report
    const id = await investigatorUpload(`${unique('cited')}.xlsx`);
    const va = await teamAdmin.api.post(apiUrl('/api/v1/view-analyses'), {
      data: { projectId, datasetId: id, name: `E2E AXI-2325 cited ${Date.now()}` },
    });
    expect(va.status(), await va.text()).toBe(201);
    const published = await teamAdmin.api.post(apiUrl('/api/v1/view-analyses/publish'), {
      data: { viewAnalysisId: (await va.json()).id, evidenceVersionIds: [] },
    });
    expect(published.status(), await published.text()).toBe(201);
    await signInToUploads(page);
    await expect(page.getByTestId(`upload-row-${id}`)).toBeVisible({ timeout: 30_000 });

    // Act
    await page.getByTestId(`upload-delete-${id}`).click();
    await page.getByTestId(`upload-delete-confirm-${id}`).click();

    // Assert
    const refusal = page.getByTestId('upload-delete-refusal');
    await expect(refusal).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('upload-delete-refusal-message')).toContainText(/Not deleted\. Cannot delete dataset: cited by 1 report/);
    await expect(page.getByTestId('upload-delete-refusal-reasons').locator('li')).not.toHaveCount(0);
    await expect(page.getByTestId(`upload-row-${id}`)).toBeVisible();
    expect((await teamAdmin.api.get(datasets(world.workspaceId, `/${id}`))).status()).toBe(200);
  });

  test("AC10 — §6 another user's upload offers no delete, and the server refuses it @SI-066 @SI-010", async ({ page }) => {
    // Arrange — the team editor's upload, in the same project
    const theirs = await uploadCsvDataset(world, editor);
    const link = await editor.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId: theirs, linkedBy: editor.userId } });
    expect(link.status(), await link.text()).toBe(201);
    await signInToUploads(page);

    // Act
    const row = page.getByTestId(`upload-row-${theirs}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    const del = await investigator.api.delete(datasets(world.workspaceId, `/${theirs}?performedBy=${investigator.userId}`));
    const fin = await investigator.api.patch(datasets(world.workspaceId, `/${theirs}/finalize`), { data: { performedBy: investigator.userId } });

    // Assert
    await expect(row).toContainText('Study team');
    await expect(page.getByTestId(`upload-analyse-${theirs}`)).toBeVisible();
    await expect(page.getByTestId(`upload-delete-${theirs}`)).toHaveCount(0);
    expect([del.status(), await messageOf(del)]).toEqual([403, NOT_OWN_UPLOAD]);
    expect([fin.status(), await messageOf(fin)]).toEqual([403, NOT_OWN_UPLOAD]);
    expect((await teamAdmin.api.get(datasets(world.workspaceId, `/${theirs}`))).status()).toBe(200);
  });
});

test.describe('AXI-2325 Investigator uploads — server-side scope @SI-010 @SI-013', () => {
  test('AC10 — §7 no reach outside his workspace and project (IDOR, FR18) @SI-010 @SI-013', async () => {
    // Arrange
    const foreign = await uploadCsvDataset(worldB, adminB);
    const mine = await investigatorUpload(`${unique('idor')}.xlsx`);
    const theirs = await uploadCsvDataset(world, editor);
    const headerB = await apiRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${investigator.accessToken}`, 'X-Workspace-Id': worldB.workspaceId },
    });

    // Act
    const viaOwnWs = await investigator.api.delete(datasets(world.workspaceId, `/${foreign}`));
    const viaForeignWs = await headerB.delete(datasets(worldB.workspaceId, `/${foreign}`));
    const linkTheirs = await investigator.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId: theirs } });
    const linkIntoB = await investigator.api.post(apiUrl(`/api/v1/projects/${projectB}/datasets`), { data: { datasetId: mine } });
    const linkForeign = await investigator.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId: foreign } });
    const forgedOrg = await investigator.api.post(datasets(world.workspaceId), {
      data: { organizationId: randomUUID(), originalFilename: `${unique('org')}.xlsx`, contentType: XLSX_TYPE },
    });

    // Assert
    expect(viaOwnWs.status()).toBe(404);
    // not a member of B: the workspace itself reads as absent
    expect(viaForeignWs.status()).toBe(404);
    expect((await adminB.api.get(datasets(worldB.workspaceId, `/${foreign}`))).status()).toBe(200);
    expect([linkTheirs.status(), await messageOf(linkTheirs)]).toEqual([403, INVESTIGATOR_LINK_REFUSED]);
    // a project of another workspace is refused before the link guard: it reads as absent
    expect(linkIntoB.status()).toBe(404);
    expect([linkForeign.status(), await messageOf(linkForeign)]).toEqual([403, INVESTIGATOR_LINK_REFUSED]);
    expect(await linkedIds(teamAdmin, projectId)).not.toContain(theirs);
    expect(await linkedIds(teamAdmin, projectId)).not.toContain(foreign);
    expect(await linkedIds(adminB, projectB)).not.toContain(mine);
    expect(forgedOrg.status(), await forgedOrg.text()).toBe(201);
    const created = (await forgedOrg.json()).dataset;
    expect(created.organizationId).toBe(world.orgId);
    await investigator.api.delete(datasets(world.workspaceId, `/${created.id}`));
    await headerB.dispose();
  });

  test('AC10 — §8 the team is unchanged: Editor uploads, finalizes and links; delete stays Admin-tier; no foreign link @SI-010 @SI-013', async () => {
    // Arrange
    const id = await uploadCsvDataset(world, editor);
    const foreign = await uploadCsvDataset(worldB, adminB);

    // Act
    const link = await editor.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId: id, linkedBy: editor.userId } });
    const linkForeign = await editor.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId: foreign } });
    const editorDelete = await editor.api.delete(datasets(world.workspaceId, `/${id}`));
    const adminDelete = await teamAdmin.api.delete(datasets(world.workspaceId, `/${id}`));

    // Assert
    expect(link.status(), await link.text()).toBe(201);
    // the pre-existing link IDOR is closed for the team too: another workspace's dataset reads as absent
    expect([linkForeign.status(), await messageOf(linkForeign)]).toEqual([404, 'Dataset not found']);
    expect(await linkedIds(teamAdmin, projectId)).not.toContain(foreign);
    expect(editorDelete.status()).toBe(403);
    expect(adminDelete.status(), await adminDelete.text()).toBe(204);
    expect((await teamAdmin.api.get(datasets(world.workspaceId, `/${id}`))).status()).toBe(404);
  });
});


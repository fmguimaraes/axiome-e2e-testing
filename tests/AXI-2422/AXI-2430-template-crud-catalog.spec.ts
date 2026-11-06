import { expect, test } from '@playwright/test';
import { Actor, NO_WORKSPACE_HEADER, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { composition, withStep } from './harness/composition-api';
import { allVisible, catalogApi, CatalogApi, uniqueTemplateId } from './harness/catalog-api';

/**
 * AXI-2430 (epic AXI-2422 — Analysis Template Library, story B — FR9-FR14, FR40, NFR4, NFR7,
 * NFR10; AC3, AC4, AC9, AC15; EC11-EC13; SI-069, SI-010, SI-002). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2422-Analysis-Template-Library.md` § AXI-2430 (B1-B10).
 *
 * The template CRUD, the scoped catalog and the governed publish, over the gateway:
 *   GET    /analysis-templates                         paged catalog: system ∪ org ∪ workspace
 *   GET    /analysis-templates/:id                     detail (404 across tenants)
 *   POST   /analysis-templates                         header (tenancy from X-Workspace-Id only)
 *   PATCH  /analysis-templates/:id                     label / description
 *   DELETE /analysis-templates/:id                     soft delete (EC12)
 *   POST   /analysis-templates/:id/versions            draft: composition or carry-forward
 *   PATCH  /analysis-templates/:id/versions/:vid       draft edit (published = 409, EC13)
 *   POST   /analysis-templates/:id/versions/:vid/publish   server validator PASS + approver ≠ author
 *   POST   /analysis-templates/:id/versions/:vid/archive
 *
 * Self-provisioned: two fresh fixture workspaces (the platform admin leaves each), so every write
 * is a WORKSPACE template written by a non-admin member holding `template:write` (workspace
 * Admin, AXI-2429) — no system row is ever written, nothing seeded is touched. Templates the run
 * created are soft-deleted in `afterAll`. Needs the AXI-2430 backend: against a stack serving
 * main, the write routes do not exist and the catalog is the legacy array (red by construction).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

let home: PrivateProjectsWorld;
let other: PrivateProjectsWorld;
let author: Actor;
let approver: Actor;
let viewer: Actor;
let stranger: Actor;
let asAuthor: CatalogApi;
let asApprover: CatalogApi;
let asViewer: CatalogApi;
let asStranger: CatalogApi;
const created: { api: () => CatalogApi; id: string }[] = [];

async function newWorkspaceTemplate(api: CatalogApi, label: string, extra: Record<string, unknown> = {}) {
  const res = await api.create({ templateId: uniqueTemplateId(label), label: `E2E AXI-2430 ${label}`, scope: 'workspace', ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  created.push({ api: () => api, id: res.body.id });
  return res.body;
}

test.beforeAll(async () => {
  home = await PrivateProjectsWorld.create();
  author = await home.actor('axi2430-author');
  approver = await home.actor('axi2430-approver');
  viewer = await home.actor('axi2430-viewer');
  await home.addMember(author, 'admin');
  await home.addMember(approver, 'admin');
  await home.addMember(viewer, 'viewer');
  await home.leaveWorkspace();

  other = await PrivateProjectsWorld.create();
  stranger = await other.actor('axi2430-stranger');
  await other.addMember(stranger, 'admin');
  await other.leaveWorkspace();

  asAuthor = catalogApi(author.api);
  asApprover = catalogApi(approver.api);
  asViewer = catalogApi(viewer.api);
  asStranger = catalogApi(stranger.api);
});

test.afterAll(async () => {
  for (const { api, id } of created) await api().remove(id).catch(() => undefined);
  await home?.dispose();
  await other?.dispose();
});

test.describe('AXI-2430 — template CRUD, scoped catalog and publish', { tag: ['@SI-069', '@SI-010', '@SI-002'] }, () => {
  test('AC3 FR13 AXI-2430.B1 the catalog is system ∪ the caller workspace; another workspace sees none of it', async () => {
    // Arrange
    const mine = await newWorkspaceTemplate(asAuthor, 'b1');
    // Act
    const forMember = await allVisible(asViewer);
    const forStranger = await allVisible(asStranger);
    const noWorkspace = await allVisible(asViewer, NO_WORKSPACE_HEADER.headers);
    // Assert
    expect(forMember.map((e) => e.id)).toContain(mine.id);
    expect(forMember.map((e) => e.templateId)).toEqual(expect.arrayContaining(['T1', 'T2', 'T3', 'T4', 'T5']));
    expect(forStranger.map((e) => e.id)).not.toContain(mine.id);
    expect(forStranger.map((e) => e.templateId)).toEqual(expect.arrayContaining(['T1', 'T5']));
    expect(noWorkspace.map((e) => e.id)).not.toContain(mine.id);
    expect(noWorkspace.every((e) => e.scope === 'system')).toBe(true);
    const t1 = forMember.find((e) => e.templateId === 'T1');
    expect(t1.versions[0]).not.toHaveProperty('composition');
    expect(t1.versions[0]).not.toHaveProperty('validatorReport');
  });

  test('FR9 NFR4 EC11 AXI-2430.B2 create stamps the verified workspace; body tenancy ids are ignored', async () => {
    // Act
    const body = await newWorkspaceTemplate(asAuthor, 'b2', { workspaceId: other.workspaceId, organizationId: '00000000-0000-4000-8000-000000000000' });
    const edited = await asAuthor.update(body.id, { label: 'E2E AXI-2430 b2 renamed', description: 'edited' });
    // Assert
    expect(body).toMatchObject({ scope: 'workspace', workspaceId: home.workspaceId, organizationId: home.orgId, createdBy: author.userId, versions: [] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ id: body.id, label: 'E2E AXI-2430 b2 renamed', description: 'edited', workspaceId: home.workspaceId });
  });

  test('NFR4 AXI-2430.B3 a template of another workspace is 404 on every route — never 403', async () => {
    // Arrange
    const theirs = await newWorkspaceTemplate(asStranger, 'b3');
    // Act
    const replies = [
      await asAuthor.get(theirs.id),
      await asAuthor.update(theirs.id, { label: 'hijack' }),
      await asAuthor.remove(theirs.id),
      await asAuthor.createVersion(theirs.id, { templateVersion: '1.0', composition: composition() }),
    ];
    const still = await asStranger.get(theirs.id);
    // Assert
    for (const reply of replies) {
      expect(reply.status, JSON.stringify(reply.body)).toBe(404);
      expect(reply.body.code).toBe('TEMPLATE_NOT_FOUND');
    }
    expect(still.status).toBe(200);
    expect(still.body).toMatchObject({ label: 'E2E AXI-2430 b3', deletedAt: null, versions: [] });
  });

  test('FR12 EC13 AXI-2430.B4 a composition draft is editable until published, then refused 409', async () => {
    // Arrange
    const template = await newWorkspaceTemplate(asAuthor, 'b4');
    // Act
    const draft = await asAuthor.createVersion(template.id, { templateVersion: '1.0', composition: composition() });
    const versionId = draft.body?.versions?.[0]?.id;
    const edited = await asAuthor.updateVersion(template.id, versionId, { guidedOnly: true });
    const published = await asApprover.publish(template.id, versionId, 'AXI-2430 B4 second-person review');
    const refused = await asAuthor.updateVersion(template.id, versionId, { guidedOnly: false });
    // Assert
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.versions[0]).toMatchObject({ templateVersion: '1.0', kind: 'composition', status: 'draft', guidedOnly: false, recipeKey: null });
    expect(draft.body.versions[0].declaredOutputs).toEqual([{ name: 'group_size', role: 's2.n', shape: 'numeric', cardinality: 'one' }]);
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.versions[0]).toMatchObject({ guidedOnly: true, automaticEligible: false });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('VERSION_NOT_DRAFT');
  });

  test('FR11 FR40 AC9 AC15 AXI-2430.B5 the author cannot publish; a second person can, and the report is stored', async () => {
    // Arrange
    const template = await newWorkspaceTemplate(asAuthor, 'b5');
    const draft = await asAuthor.createVersion(template.id, { templateVersion: '1.0', composition: composition() });
    const versionId = draft.body.versions[0].id;
    // Act
    const byAuthor = await asAuthor.publish(template.id, versionId, 'self-approval attempt');
    const afterRefusal = await asAuthor.get(template.id);
    const bySecond = await asApprover.publish(template.id, versionId, 'AXI-2430 B5 second-person review');
    const listed = (await allVisible(asViewer)).find((e) => e.id === template.id);
    // Assert
    expect(byAuthor.status, JSON.stringify(byAuthor.body)).toBe(403);
    expect(byAuthor.body.code).toBe('APPROVER_IS_AUTHOR');
    expect(afterRefusal.body.versions[0].status).toBe('draft');
    expect(bySecond.status, JSON.stringify(bySecond.body)).toBe(201);
    const version = bySecond.body.versions[0];
    expect(version).toMatchObject({ status: 'published', publishedBy: approver.userId, validatorVerdict: 'PASS', validatorVersion: '1.0.0', invalid: false });
    expect(version.validatorReport.verdict).toBe('PASS');
    expect(version.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(version.referencedOperations.map((o: any) => o.operationId)).toEqual(['stats.mann_whitney_u', 'describe.grouped_aggregate']);
    expect(listed.versions[0]).toMatchObject({ status: 'published', validatorVerdict: 'PASS', automaticEligible: true });
    expect(listed.versions[0]).not.toHaveProperty('validatorReport');
  });

  test('FR11 NFR10 AXI-2430.B6 a draft the server validator BLOCKs is refused 422 with its findings', async () => {
    // Arrange
    const template = await newWorkspaceTemplate(asAuthor, 'b6');
    const blocked = withStep('s1', (s) => ({ ...s, roles: s.roles.filter((r: any) => r.role !== 'valueColumns') }));
    const draft = await asAuthor.createVersion(template.id, { templateVersion: '1.0', composition: blocked });
    const versionId = draft.body.versions[0].id;
    // Act
    const res = await asApprover.publish(template.id, versionId, 'AXI-2430 B6 review');
    const after = await asAuthor.get(template.id);
    // Assert
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('VALIDATOR_NOT_PASS');
    expect(Array.isArray(res.body.errors) && res.body.errors.length).toBeTruthy();
    expect(after.body.versions[0]).toMatchObject({ status: 'draft', validatorVerdict: null });
  });

  test('FR12 AC4 AXI-2430.B7 a new version carries a published composition forward; the published one is untouched', async () => {
    // Arrange
    const template = await newWorkspaceTemplate(asAuthor, 'b7');
    const v1 = await asAuthor.createVersion(template.id, { templateVersion: '1.0', composition: composition() });
    const v1Id = v1.body.versions[0].id;
    const published = await asApprover.publish(template.id, v1Id, 'AXI-2430 B7 review');
    // Act
    const v11 = await asAuthor.createVersion(template.id, { templateVersion: '1.1', fromVersionId: v1Id });
    const both = await asAuthor.createVersion(template.id, { templateVersion: '1.2', fromVersionId: v1Id, composition: composition() });
    const duplicate = await asAuthor.createVersion(template.id, { templateVersion: '1.0', composition: composition() });
    const detail = await asViewer.get(template.id);
    // Assert
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    expect(v11.status, JSON.stringify(v11.body)).toBe(201);
    const byKey = Object.fromEntries(detail.body.versions.map((v: any) => [v.templateVersion, v]));
    expect(byKey['1.1']).toMatchObject({ status: 'draft', kind: 'composition' });
    expect(byKey['1.1'].composition).toEqual(byKey['1.0'].composition);
    expect(byKey['1.0']).toMatchObject({ status: 'published', contentHash: published.body.versions[0].contentHash });
    expect(both.status).toBe(400);
    expect(duplicate.status).toBe(409);
  });

  test('FR5 EC12 AXI-2430.B8 a soft-deleted template is unlisted, still resolvable by id, and refuses writes', async () => {
    // Arrange
    const template = await newWorkspaceTemplate(asAuthor, 'b8');
    // Act
    const deleted = await asAuthor.remove(template.id);
    const listed = await allVisible(asViewer);
    const detail = await asViewer.get(template.id);
    const edit = await asAuthor.update(template.id, { label: 'after delete' });
    const again = await asAuthor.remove(template.id);
    // Assert
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.deletedAt).not.toBeNull();
    expect(listed.map((e) => e.id)).not.toContain(template.id);
    expect(detail.status).toBe(200);
    expect(detail.body.deletedAt).toBe(deleted.body.deletedAt);
    expect([edit.status, edit.body.code]).toEqual([409, 'TEMPLATE_DELETED']);
    expect([again.status, again.body.code]).toEqual([409, 'TEMPLATE_DELETED']);
  });

  test('FR38 NFR4 AXI-2430.B9 a member without template:write, or any caller writing a system template, is refused 403', async () => {
    // Arrange
    const template = await newWorkspaceTemplate(asAuthor, 'b9');
    // Act
    const viewerCreate = await asViewer.create({ templateId: uniqueTemplateId('b9-viewer'), label: 'nope', scope: 'workspace' });
    const viewerEdit = await asViewer.update(template.id, { label: 'nope' });
    const systemCreate = await asAuthor.create({ templateId: uniqueTemplateId('b9-system'), label: 'nope', scope: 'system' });
    const t1 = (await allVisible(asAuthor)).find((e) => e.templateId === 'T1');
    const systemEdit = await asAuthor.update(t1.id, { label: 'nope' });
    const reread = await asViewer.get(template.id);
    // Assert
    expect(viewerCreate.status).toBe(403);
    expect(viewerEdit.status).toBe(403);
    expect(systemCreate.status, JSON.stringify(systemCreate.body)).toBe(403);
    expect(systemEdit.status, JSON.stringify(systemEdit.body)).toBe(403);
    expect(reread.body.label).toBe('E2E AXI-2430 b9');
  });

  test('NFR7 AXI-2430.B10 the catalog page is bounded: limit above 100 or a non-numeric page is 400', async () => {
    // Act
    const page = await asViewer.list('limit=2&page=1');
    const tooBig = await asViewer.list('limit=101');
    const notANumber = await asViewer.list('page=abc');
    const zero = await asViewer.list('page=0');
    // Assert
    expect(page.status).toBe(200);
    expect(page.body.data.length).toBeLessThanOrEqual(2);
    expect(page.body.meta).toMatchObject({ page: 1, limit: 2 });
    expect(page.body.meta.total).toBeGreaterThanOrEqual(5);
    expect(tooBig.status).toBe(400);
    expect(notANumber.status).toBe(400);
    expect(zero.status).toBe(400);
  });

  test('FR40 AC9 EC9 AXI-2430.B11 (H2.2) a second member who edits the draft becomes an author and is refused too', async () => {
    // Arrange
    const template = await newWorkspaceTemplate(asAuthor, 'b11');
    const draft = await asAuthor.createVersion(template.id, { templateVersion: '1.0', composition: composition() });
    const versionId = draft.body.versions[0].id;
    // Act
    const edit = await asApprover.updateVersion(template.id, versionId, { guidedOnly: true });
    const byEditor = await asApprover.publish(template.id, versionId, 'editor self-approval attempt');
    const after = await asViewer.get(template.id);
    // Assert
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(byEditor.status, JSON.stringify(byEditor.body)).toBe(403);
    expect(byEditor.body.code).toBe('APPROVER_IS_AUTHOR');
    expect(after.body.versions[0]).toMatchObject({ status: 'draft', publishedBy: null });
  });

  test('FR1 AC13 EC8 AXI-2430.B12 (H3) a copy of a system template sits alongside; a shadowing key or name is refused 409', async () => {
    // Arrange
    const t1 = (await allVisible(asAuthor)).find((e) => e.templateId === 'T1');
    // Act
    const copy = await newWorkspaceTemplate(asAuthor, 'b12', { derivedFromId: t1.id });
    const sameKey = await asAuthor.create({ templateId: 'T1', label: `E2E AXI-2430 b12 key ${Date.now()}`, scope: 'workspace' });
    const sameName = await asAuthor.create({ templateId: uniqueTemplateId('b12-name'), label: t1.label.toUpperCase(), scope: 'workspace' });
    const t1After = await asAuthor.get(t1.id);
    // Assert
    expect(copy.derivedFrom).toEqual({ id: t1.id, templateId: 'T1', label: t1.label });
    expect([sameKey.status, sameKey.body.code]).toEqual([409, 'SHADOW_REFUSED']);
    expect([sameName.status, sameName.body.code]).toEqual([409, 'SHADOW_REFUSED']);
    expect(t1After.body).toMatchObject({ scope: 'system', label: t1.label, updatedAt: t1.updatedAt });
  });
});

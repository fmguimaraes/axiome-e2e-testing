import { test, expect } from '@playwright/test';
import { RuleFamilyWorld, RULE_FAMILY_CAPABILITY, send, orgHeader } from './harness/world';

/**
 * AXI-2005 (epic AXI-1991 — AC10, AC11; §16a Q7, Q9, Q10).
 *
 * RBAC + organization-tenancy scenarios from
 * `axiome-docs/manual-e2e/AXI-1991-Rule-Families.md` §2.2. API-level only.
 *
 * AUTHORED, NOT RUN — no stack was started for this story. Each test
 * provisions its own org/workspace/role/actor/family and asserts a specific
 * outcome; none depends on another test's state.
 */

let world: RuleFamilyWorld;

test.beforeAll(async () => {
  world = await RuleFamilyWorld.create();
});

test.afterAll(async () => {
  await world.dispose();
});

test.describe('AXI-2005 — rule family RBAC and per-organization tenancy', () => {
  // AC10 — rule_family:read
  test('AC10: a holder of rule_family:read may list families; a non-holder is refused @SI-001 @SI-010 @SI-017', async () => {
    const orgId = await world.organization('read-cap');
    const readerRole = await world.role('reader', [RULE_FAMILY_CAPABILITY.READ]);
    const reader = await world.actor('reader', readerRole, orgId);
    const noneRole = await world.role('none', []);
    const none = await world.actor('none-holder', noneRole, orgId);

    const ok = await send(reader.api, 'get', '/api/v1/rule-families', undefined, orgHeader(orgId));
    expect(ok.status).toBeLessThan(300);

    const refused = await send(none.api, 'get', '/api/v1/rule-families', undefined, orgHeader(orgId));
    expect(refused.status).toBe(403);
  });

  // AC10 — rule_family:manage, create + delete
  test('AC10: rule_family:manage allows create/delete; its absence is refused @SI-001 @SI-010 @SI-017', async () => {
    const orgId = await world.organization('manage-cap');
    const managerRole = await world.role('manager', [RULE_FAMILY_CAPABILITY.MANAGE, RULE_FAMILY_CAPABILITY.READ]);
    const manager = await world.actor('manager', managerRole, orgId);
    const readerRole = await world.role('reader-only', [RULE_FAMILY_CAPABILITY.READ]);
    const reader = await world.actor('reader-only', readerRole, orgId);

    const created = await world.createFamily(manager, orgId, 'organization', 'AC10 Manage Family');
    expect(created.status).toBeLessThan(300);

    const refusedCreate = await world.createFamily(reader, orgId, 'organization', 'AC10 Refused Family');
    expect(refusedCreate.status).toBe(403);

    const deleted = await send(manager.api, 'delete', `/api/v1/rule-families/${created.id}`, undefined, orgHeader(orgId));
    expect(deleted.status).toBeLessThan(300);
  });

  // AC10 — rule_family:assign (exercised through the rule form's familyIds)
  test('AC10: rule_family:assign gates filing a rule into a family from the rule form @SI-001 @SI-010 @SI-017', async () => {
    const orgId = await world.organization('assign-cap');
    const wsId = await world.workspace('assign-cap', orgId);
    const assignerRole = await world.role('assigner', [
      RULE_FAMILY_CAPABILITY.ASSIGN,
      RULE_FAMILY_CAPABILITY.MANAGE,
      RULE_FAMILY_CAPABILITY.READ,
    ]);
    const assigner = await world.actor('assigner', assignerRole, orgId);
    await world.addWorkspaceMember(wsId, assigner);
    const family = await world.createFamily(assigner, orgId, 'organization', 'AC10 Assign Family');
    expect(family.id).toBeTruthy();

    const ruleId = await world.rule(assigner, wsId, `AXI2005ASSIGN-${Date.now()}`, [family.id!]);
    const families = await send(assigner.api, 'get', `/api/v1/rule-family-membership/rules/${ruleId}`, undefined, orgHeader(orgId));
    expect(families.status).toBeLessThan(300);
    const ids: string[] = (families.json.families ?? []).map((f: any) => f.id);
    expect(ids).toContain(family.id);
  });

  // AC10 — a caller without rule_family:assign cannot file a rule into a family
  test('AC10: without rule_family:assign, familyIds sent on a rule write are refused, not silently dropped @SI-001 @SI-010 @SI-017', async () => {
    const orgId = await world.organization('no-assign-cap');
    const wsId = await world.workspace('no-assign-cap', orgId);
    const managerRole = await world.role('manager-no-assign', [RULE_FAMILY_CAPABILITY.MANAGE, RULE_FAMILY_CAPABILITY.READ]);
    const manager = await world.actor('manager-no-assign', managerRole, orgId);
    const family = await world.createFamily(manager, orgId, 'organization', 'AC10 No-Assign Family');
    expect(family.id).toBeTruthy();

    const authorRole = await world.role('author-no-assign', []);
    const author = await world.actor('author-no-assign', authorRole, orgId);
    await world.addWorkspaceMember(wsId, author);

    const res = await send(author.api, 'post', '/api/v1/rules', {
      code: `AXI2005NOASSIGN-${Date.now()}`,
      title: 'AXI-2005 no-assign fixture rule',
      category: 'qc_guard',
      protocolType: 'QC_RULE',
      scope: 'workspace',
      workspaceId: wsId,
      familyIds: [family.id],
    });
    expect(res.status).toBe(403);
  });

  // AC10 — rule_family:configure_defaults
  test('AC10: rule_family:configure_defaults toggles the organization default set; its absence is refused @SI-001 @SI-010 @SI-017', async () => {
    const orgId = await world.organization('defaults-cap');
    const configRole = await world.role('configurer', [RULE_FAMILY_CAPABILITY.CONFIGURE_DEFAULTS, RULE_FAMILY_CAPABILITY.MANAGE]);
    const configurer = await world.actor('configurer', configRole, orgId);
    const noConfigRole = await world.role('no-configurer', [RULE_FAMILY_CAPABILITY.MANAGE]);
    const noConfigurer = await world.actor('no-configurer', noConfigRole, orgId);
    const family = await world.createFamily(configurer, orgId, 'organization', 'AC10 Defaults Family');
    expect(family.id).toBeTruthy();

    const toggled = await world.toggleDefault(configurer, orgId, family.id!, true);
    expect(toggled.status).toBeLessThan(300);

    const refused = await world.toggleDefault(noConfigurer, orgId, family.id!, false);
    expect(refused.status).toBe(403);
  });

  // AC10 — rule_family:project_select
  test('AC10: rule_family:project_select adds/removes a project family; its absence is refused @SI-001 @SI-010 @SI-017', async () => {
    const orgId = await world.organization('project-select-cap');
    const wsId = await world.workspace('project-select-cap', orgId);
    const projectId = await world.project('project-select-cap', wsId);
    const selectorRole = await world.role('selector', [RULE_FAMILY_CAPABILITY.PROJECT_SELECT, RULE_FAMILY_CAPABILITY.MANAGE]);
    const selector = await world.actor('selector', selectorRole, orgId);
    const noSelectRole = await world.role('no-selector', [RULE_FAMILY_CAPABILITY.MANAGE]);
    const noSelector = await world.actor('no-selector', noSelectRole, orgId);
    const family = await world.createFamily(selector, orgId, 'organization', 'AC10 Project Select Family');
    expect(family.id).toBeTruthy();

    const added = await world.addProjectFamily(selector, orgId, projectId, family.id!);
    expect(added.status).toBeLessThan(300);

    const refusedAdd = await world.addProjectFamily(noSelector, orgId, projectId, family.id!);
    expect(refusedAdd.status).toBe(403);

    const removed = await world.removeProjectFamily(selector, orgId, projectId, family.id!);
    expect(removed.status).toBeLessThan(300);
  });

  // AC10 — a client cannot self-grant: holding no capability, every route 403s
  test('AC10: a caller with no rule_family:* grant is refused on every route, never self-granted @SI-001 @SI-010', async () => {
    const orgId = await world.organization('no-grant');
    const noneRole = await world.role('bystander', []);
    const bystander = await world.actor('bystander', noneRole, orgId);

    const list = await send(bystander.api, 'get', '/api/v1/rule-families', undefined, orgHeader(orgId));
    expect(list.status).toBe(403);

    const create = await send(
      bystander.api,
      'post',
      '/api/v1/rule-families',
      { name: 'should-not-exist', scope: 'organization' },
      orgHeader(orgId),
    );
    expect(create.status).toBe(403);
  });

  // AC11 / EC19 — system-scope family membership is platform-admin only
  test('AC11/EC19: an organization capability holder cannot create or configure a SYSTEM-scope family, even with rule_family:manage AND rule_family:configure_defaults @SI-017 @SI-010', async () => {
    const orgId = await world.organization('system-family');
    // A1 fix: the manager holds CONFIGURE_DEFAULTS too, so the toggle's 403
    // cannot be the gateway's OrgCapabilityGuard refusing for a missing
    // capability — the refusal under test is FR16/EC19's "a system-scope
    // family is platform-admin authority only", not a capability gap.
    const managerRole = await world.role('org-manager', [
      RULE_FAMILY_CAPABILITY.MANAGE,
      RULE_FAMILY_CAPABILITY.READ,
      RULE_FAMILY_CAPABILITY.CONFIGURE_DEFAULTS,
    ]);
    const manager = await world.actor('org-manager', managerRole, orgId);

    // `assertCreateAuthority` (rule-family-authority.ts): no target row
    // exists yet, so CREATE answers Forbidden (403), not NotFound.
    const refusedCreate = await send(
      manager.api,
      'post',
      '/api/v1/rule-families',
      { name: `AXI-2005 system attempt ${Date.now()}`, scope: 'system' },
      orgHeader(orgId),
    );
    expect(refusedCreate.status).toBe(403);

    const adminCreate = await send(
      world.admin,
      'post',
      '/api/v1/rule-families',
      { name: `AXI-2005 system family ${Date.now()}`, scope: 'system' },
      orgHeader(orgId),
    );
    expect(adminCreate.status).toBeLessThan(300);
    const systemFamilyId = adminCreate.json.id;

    // FR16 reserves the system default set for platform-admin authority,
    // never an organization capability — even one holding both `manage` AND
    // `configure_defaults`. `assertFamilyAuthority` (rule-family-authority.ts)
    // answers an EXISTING system-scope family's authority gap as NotFound
    // (404, EC18/EC19's not-found-over-forbidden), never 403.
    const refusedToggle = await world.toggleDefault(manager, orgId, systemFamilyId, true);
    expect(refusedToggle.status).toBe(404);

    const adminToggle = await world.toggleDefault({ userId: world.adminUserId, api: world.admin }, orgId, systemFamilyId, true);
    expect(adminToggle.status).toBeLessThan(300);

    await send(world.admin, 'delete', `/api/v1/rule-families/${systemFamilyId}`, undefined, orgHeader(orgId));
  });

  // AC11 / EC17, EC18 — organization scoping is server-derived, never the body
  test("AC11/EC17/EC18: a caller cannot see or edit another organization's family; a widened header on an edit is ignored @SI-017 @SI-010", async () => {
    const orgA = await world.organization('tenant-a');
    const orgB = await world.organization('tenant-b');
    const managerRoleA = await world.role('manager-a', [RULE_FAMILY_CAPABILITY.MANAGE, RULE_FAMILY_CAPABILITY.READ]);
    const managerA = await world.actor('manager-a', managerRoleA, orgA);
    const managerRoleB = await world.role('manager-b', [RULE_FAMILY_CAPABILITY.MANAGE, RULE_FAMILY_CAPABILITY.READ]);
    const managerB = await world.actor('manager-b', managerRoleB, orgB);

    const familyA = await world.createFamily(managerA, orgA, 'organization', 'Org A Family');
    expect(familyA.id).toBeTruthy();

    // B cannot read/edit A's family, even sending its OWN X-Organization-Id
    // header (EC18) — not-found, indistinguishable from a missing object.
    const readAsB = await send(managerB.api, 'get', `/api/v1/rule-families/${familyA.id}`, undefined, orgHeader(orgB));
    expect(readAsB.status).toBe(404);

    const editAsB = await send(
      managerB.api,
      'patch',
      `/api/v1/rule-families/${familyA.id}`,
      { name: 'hijacked' },
      orgHeader(orgB),
    );
    expect(editAsB.status).toBe(404);

    // A client cannot widen its organization by sending another org's header
    // on an edit of its OWN family — every route but `create` authorizes
    // against the TARGET's own organization, never the header (EC17).
    const editWithWrongHeader = await send(
      managerA.api,
      'patch',
      `/api/v1/rule-families/${familyA.id}`,
      { name: 'still org A' },
      orgHeader(orgB),
    );
    expect(editWithWrongHeader.status).toBeLessThan(300);
  });

  // AC11 / FR44 — a two-organization user operates per organization
  test("AC11/FR44: a user permitted in two organizations sees/edits each organization's own families, never crossed @SI-017 @SI-010", async () => {
    const orgA = await world.organization('two-org-a');
    const orgB = await world.organization('two-org-b');
    const managerRole = await world.role('two-org-manager', [RULE_FAMILY_CAPABILITY.MANAGE, RULE_FAMILY_CAPABILITY.READ]);
    const manager = await world.actor('two-org-manager');
    await send(world.admin, 'post', `/api/v1/users/${manager.userId}/roles`, { roleId: managerRole, organizationId: orgA });
    await send(world.admin, 'post', `/api/v1/users/${manager.userId}/roles`, { roleId: managerRole, organizationId: orgB });

    const familyA = await world.createFamily(manager, orgA, 'organization', 'Two-Org Family A');
    const familyB = await world.createFamily(manager, orgB, 'organization', 'Two-Org Family B');
    expect(familyA.id).toBeTruthy();
    expect(familyB.id).toBeTruthy();

    const listA = await send(manager.api, 'get', '/api/v1/rule-families?scope=organization', undefined, orgHeader(orgA));
    const idsA: string[] = (listA.json.data ?? listA.json ?? []).map((f: any) => f.id);
    expect(idsA).toContain(familyA.id);
    expect(idsA).not.toContain(familyB.id);

    const listB = await send(manager.api, 'get', '/api/v1/rule-families?scope=organization', undefined, orgHeader(orgB));
    const idsB: string[] = (listB.json.data ?? listB.json ?? []).map((f: any) => f.id);
    expect(idsB).toContain(familyB.id);
    expect(idsB).not.toContain(familyA.id);
  });
});

import { test, expect } from '@playwright/test';
import { anonymousRegistryApi, registryApiAs, type RegistryApi } from './harness/registry-api';

/**
 * AXI-2424 (epic AXI-2422 — Analysis Template Library, Registry v0 R2 — FR45, FR49, FR50;
 * AC20, AC21; EC16-EC18, EC20). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2422-Analysis-Template-Library.md` § AXI-2424 (scenarios 5-11;
 * 12 is unit-only — no HTTP route compiles through the registry yet, UT-TMPL-075..078).
 *
 * `POST /api/v1/analysis-templates` (platform admin only) creates a recipe variant;
 * the read routes serve any authenticated caller. Every test runs as BOTH roles where the AC
 * names one: `admin` (the platform-admin E2E identity) and `user` (self-registered, not admin).
 *
 * WRITES: version rows are create-only (DB trigger), so each run leaves one header
 * `e2e-axi2424-<run>` with versions 1.0 and 1.1 on the target stack. Refused writes leave
 * nothing (asserted). Run against a stack serving the branch:
 *   `API_BASE_URL=<gateway> npx playwright test tests/AXI-2422/AXI-2424-*`
 */

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const TEMPLATE_ID = `e2e-axi2424-${RUN}`;
const LABEL = `E2E AXI-2424 Kruskal-Wallis, no post-hoc (${RUN})`;
const VARIANT = {
  templateId: TEMPLATE_ID,
  templateVersion: '1.0',
  label: LABEL,
  recipeKey: 'T2',
  fixedValues: { posthoc: 'never' },
};
const POSTHOC_OPTIONS = ['always', 'if_significant', 'never'];

let admin: RegistryApi;
let user: RegistryApi;
let created10: any;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  admin = await registryApiAs('admin');
  user = await registryApiAs('user');
});
test.afterAll(async () => {
  await admin?.dispose();
  await user?.dispose();
});

const posthocOf = (resolved: any) => resolved.parameters.find((p: any) => p.key === 'posthoc');

test.describe('AXI-2424 — recipe-variant endpoint + read routes', { tag: ['@SI-010', '@SI-069', '@SI-002'] }, () => {
  test('AXI-2424.5 an admin creates a T2 variant as a new system template; it resolves and lists (AC20, AC21)', async () => {
    // Act
    const created = await admin.create(VARIANT);
    const resolved = await admin.resolve(TEMPLATE_ID, '1.0');
    const list = await admin.list();
    // Assert
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ templateId: TEMPLATE_ID, templateVersion: '1.0', recipeKey: 'T2', guidedOnly: false });
    expect(posthocOf(created.body)).toEqual({
      key: 'posthoc',
      type: 'choice',
      required: false,
      fixed: true,
      default: 'never',
      options: POSTHOC_OPTIONS,
    });
    expect(created.body.signature.outputs).toEqual(['stats.kruskal_wallis', 'stats.dunn_posthoc']);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual(created.body);
    expect(list.body.find((e: any) => e.templateId === TEMPLATE_ID)).toEqual({
      templateId: TEMPLATE_ID,
      label: LABEL,
      versions: ['1.0'],
    });
    created10 = created.body;
  });

  test('AXI-2424.6 a new version of the variant is stored beside 1.0, which stays resolvable unchanged (FR45, AC20)', async () => {
    // Act
    const v11 = await admin.create({
      templateId: TEMPLATE_ID,
      templateVersion: '1.1',
      recipeKey: 'T2',
      defaults: { posthoc: 'if_significant' },
    });
    const r10 = await admin.resolve(TEMPLATE_ID, '1.0');
    const r11 = await admin.resolve(TEMPLATE_ID, '1.1');
    const otherRecipe = await admin.create({ templateId: TEMPLATE_ID, templateVersion: '2.0', recipeKey: 'T1' });
    const r20 = await admin.resolve(TEMPLATE_ID, '2.0');
    // Assert
    expect(v11.status, JSON.stringify(v11.body)).toBe(201);
    expect(posthocOf(r11.body)).toEqual({
      key: 'posthoc',
      type: 'choice',
      required: false,
      fixed: false,
      default: 'if_significant',
      options: POSTHOC_OPTIONS,
    });
    expect(r10.body).toEqual(created10);
    expect(otherRecipe.status).toBe(409);
    expect(otherRecipe.body.errorCode).toBe('ANALYSIS_TEMPLATE_RECIPE_MISMATCH');
    expect(r20.status).toBe(404);
  });

  test('AXI-2424.7 an existing {templateId, templateVersion} is a 409 and the stored row is unchanged (EC20)', async () => {
    // Act
    const again = await admin.create({ ...VARIANT, fixedValues: { posthoc: 'always' } });
    const r10 = await admin.resolve(TEMPLATE_ID, '1.0');
    const seededBefore = await admin.resolve('T1', '0.2');
    const seeded = await admin.create({ templateId: 'T1', templateVersion: '0.2', recipeKey: 'T1' });
    const seededAfter = await admin.resolve('T1', '0.2');
    // Assert
    expect(again.status).toBe(409);
    expect(again.body.errorCode).toBe('ANALYSIS_TEMPLATE_VERSION_EXISTS');
    expect(r10.body).toEqual(created10);
    expect(seeded.status).toBe(409);
    expect(seededAfter.body).toEqual(seededBefore.body);
  });

  test('AXI-2424.8 a caller who is not a platform admin is refused 403 and nothing is written (EC16)', async () => {
    // Arrange
    const body = { ...VARIANT, templateId: `${TEMPLATE_ID}-user` };
    // Act
    const plain = await user.create(body);
    const claimed = await user.create({ ...body, caller: { userId: 'x', isPlatformAdmin: true } });
    const after = await admin.resolve(body.templateId, '1.0');
    // Assert
    expect(plain.status).toBe(403);
    expect(claimed.status).toBe(403);
    expect(after.status).toBe(404);
  });

  test('AXI-2424.9 an unknown recipe, a step graph or a new operation is a 400 and nothing is written (EC17)', async () => {
    // Arrange
    const id = `${TEMPLATE_ID}-ec17`;
    const base = { ...VARIANT, templateId: id };
    // Act
    const unknown = await admin.create({ ...base, recipeKey: 'T9', fixedValues: {} });
    const proto = await admin.create({ ...base, recipeKey: 'constructor', fixedValues: {} });
    const steps = await admin.create({ ...base, steps: [{ operationId: 'stats.t_test' }] });
    const operations = await admin.create({ ...base, operations: ['stats.new_operation'] });
    const nested = await admin.create({ ...base, fixedValues: { steps: [{ operationId: 'stats.t_test' }] } });
    const after = await admin.resolve(id, '1.0');
    // Assert
    expect(unknown.status).toBe(400);
    expect(unknown.body.errorCode).toBe('ANALYSIS_TEMPLATE_UNKNOWN_RECIPE');
    expect(proto.body.errorCode).toBe('ANALYSIS_TEMPLATE_UNKNOWN_RECIPE');
    expect(steps.status).toBe(400);
    expect(operations.status).toBe(400);
    expect(nested.status).toBe(400);
    expect(nested.body.errorCode).toBe('ANALYSIS_TEMPLATE_INVALID_PARAMETER');
    expect(after.status).toBe(404);
  });

  test('AXI-2424.10 values breaking the recipe schema (enum, type, range, undeclared) are a 400 naming the key (EC18)', async () => {
    // Arrange
    const id = `${TEMPLATE_ID}-ec18`;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ posthoc: 'sometimes' }, 'posthoc'],
      [{ outcome: 42 }, 'outcome'],
      [{ groups: ['A', 'B'] }, 'groups'],
      [{ adjustFor: 'age' }, 'adjustFor'],
    ];
    for (const [fixedValues, key] of cases) {
      // Act
      const res = await admin.create({ ...VARIANT, templateId: id, fixedValues });
      // Assert
      expect(res.status, key).toBe(400);
      expect(res.body.errorCode).toBe('ANALYSIS_TEMPLATE_INVALID_PARAMETER');
      expect(String(res.body.message)).toContain(`fixedValues.${key}`);
    }
    expect((await admin.resolve(id, '1.0')).status).toBe(404);
  });

  test('AXI-2424.11 any authenticated caller reads the catalogue; no token is refused (AC21)', async () => {
    // Arrange
    const anonymous = await anonymousRegistryApi();
    // Act
    const list = await user.list();
    const t1 = await user.resolve('T1', '0.2');
    const variant = await user.resolve(TEMPLATE_ID, '1.0');
    const malformed = await user.resolve('T1', 'latest');
    const noToken = await anonymous.list();
    await anonymous.dispose();
    // Assert
    expect(list.status).toBe(200);
    expect(list.body.map((e: any) => e.templateId)).toEqual(expect.arrayContaining(['T1', 'T2', 'T3', 'T4', 'T5', TEMPLATE_ID]));
    expect(t1.status).toBe(200);
    expect(t1.body.recipeKey).toBe('T1');
    expect(variant.body).toEqual(created10);
    expect(malformed.status).toBe(400);
    expect(noToken.status).toBe(401);
  });
});

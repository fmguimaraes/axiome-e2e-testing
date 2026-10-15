import { test, expect, APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';

/**
 * AXI-2009 (epic AXI-2006 — FR1, FR2, FR3, EC6, C1; SI-002, SI-013, SI-017):
 * Feature Rule output scope, output name, output shape and binding target.
 *
 * Scenario doc: manual-e2e/AXI-2006-Reasoning-Branch-Executors.md "AXI-2009".
 * EC8 (the hash stays byte-identical for a rule with no declaration) is
 * unit-only — UT-RULES-2009-036/037 pin it; it has no observable UI/API surface
 * beyond the hash itself.
 *
 * Self-contained: one throwaway organization + workspace per run, every rule a
 * draft workspace rule created as the platform-admin bootstrap context
 * (`adminApiContext`, the AXI-1236 cross-dir convention), deleted afterwards.
 *
 * AUTHORED, NOT RUN: there is no stack serving this story's axiome-back branch
 * (the shared demo stack serves `main`, and its database must not be migrated
 * from a worktree). Do not report `e2e-pass` for this spec until it has run
 * green against a stack carrying migration
 * `20261015170000_add_rule_feature_declaration`.
 */

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function send(
  api: APIRequestContext,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await (api as any)[method](apiUrl(path), body === undefined ? {} : { data: body });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status(), json };
}

/** The feature doc's worked example: IgG4 above 1.35 g/L (exclusive) is `high`. */
function igg4Declaration(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    outputScope: 'node',
    outputName: 'igg4_level',
    bindingTarget: {
      entity: 'IgG4',
      measure: 'concentration',
      unit: 'g/L',
      context: { assay: 'nephelometry', matrix: 'serum', population: 'adult' },
    },
    output: {
      shape: 'categorical',
      cutoff: {
        kind: 'numeric',
        groups: [
          { id: 'high', min: 1.35, min_inclusive: false },
          { id: 'normal', max: 1.35, max_inclusive: true },
        ],
      },
    },
    ...over,
  };
}

/** The refusal text, wherever the gateway put it (`message` may be a string or a list). */
function refusalText(json: any): string {
  const message = json?.message ?? json?.error ?? json?.raw ?? '';
  return Array.isArray(message) ? message.join(' ') : String(message);
}

test.describe.serial('AXI-2009 — Feature declaration: scope, name, shape, binding target (FR1, FR2, FR3, EC6, C1)', () => {
  let admin: APIRequestContext;
  let workspaceId: string;
  const ruleIds: string[] = [];

  function ruleBody(label: string, protocolType: string, extra: Record<string, unknown> = {}) {
    return {
      code: unique(`E2E-2009-${label}`).toUpperCase().slice(0, 60),
      title: `AXI-2009 fixture ${label}`,
      category: 'phenotype_detection',
      protocolType,
      scope: 'workspace',
      workspaceId,
      ...extra,
    };
  }

  async function createRule(label: string, protocolType: string, extra: Record<string, unknown> = {}) {
    const res = await send(admin, 'post', '/api/v1/rules', ruleBody(label, protocolType, extra));
    if (res.status < 300 && res.json?.id) ruleIds.push(res.json.id);
    return res;
  }

  async function readRule(id: string) {
    const res = await send(admin, 'get', `/api/v1/rules/${id}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  }

  test.beforeAll(async () => {
    admin = await adminApiContext();
    const org = await send(admin, 'post', '/api/v1/organizations', { name: unique('AXI-2009 Org'), type: 'biotech' });
    expect(org.status, JSON.stringify(org.json)).toBeLessThan(300);
    const ws = await send(admin, 'post', '/api/v1/workspaces', {
      name: unique('AXI-2009 WS'),
      description: 'AXI-2009 feature declaration E2E fixture',
      type: 'internal',
      ownerOrganizationId: org.json.id,
    });
    expect(ws.status, JSON.stringify(ws.json)).toBeLessThan(300);
    workspaceId = ws.json.id;
  });

  test.afterAll(async () => {
    for (const id of ruleIds) await send(admin, 'delete', `/api/v1/rules/${id}`);
    await admin?.dispose();
  });

  test('FR1/FR2/FR3/C1 (Scenario 1): a node-scope categorical IgG4 rule round-trips and its tenancy scope is untouched @SI-002 @SI-013', async () => {
    const created = await createRule('igg4', 'FEATURE_RULE', { featureDeclaration: igg4Declaration() });
    expect(created.status, JSON.stringify(created.json)).toBeLessThan(300);

    const rule = await readRule(created.json.id);
    expect(rule.featureDeclaration).toEqual(igg4Declaration());
    expect(rule.scope).toBe('workspace');
  });

  test('FR1 (Scenario 2): an omitted output scope is stored as `row` @SI-002', async () => {
    const { outputScope: _omitted, ...withoutScope } = igg4Declaration();
    const created = await createRule('default-scope', 'FEATURE_RULE', { featureDeclaration: withoutScope });
    expect(created.status, JSON.stringify(created.json)).toBeLessThan(300);

    const rule = await readRule(created.json.id);
    expect(rule.featureDeclaration.outputScope).toBe('row');
  });

  test('FR2/O1 (Scenario 3): a legacy rule with no declaration and a numeric-shape rule are both accepted @SI-002', async () => {
    const legacy = await createRule('legacy', 'FEATURE_RULE');
    expect(legacy.status, JSON.stringify(legacy.json)).toBeLessThan(300);
    expect((await readRule(legacy.json.id)).featureDeclaration ?? null).toBeNull();

    const numeric = await createRule('numeric', 'FEATURE_RULE', {
      featureDeclaration: igg4Declaration({ output: { shape: 'numeric' } }),
    });
    expect(numeric.status, JSON.stringify(numeric.json)).toBeLessThan(300);
    expect((await readRule(numeric.json.id)).featureDeclaration.output).toEqual({ shape: 'numeric' });
  });

  test('EC6 (Scenario 4): a boundary with no inclusive side is refused with a 400 naming the field @SI-002', async () => {
    const declaration = igg4Declaration();
    delete declaration.output.cutoff.groups[0].min_inclusive;

    const res = await createRule('ec6', 'FEATURE_RULE', { featureDeclaration: declaration });

    expect(res.status, JSON.stringify(res.json)).toBe(400);
    const text = refusalText(res.json);
    expect(text).toContain('FEATURE_DECLARATION_INVALID');
    expect(text).toContain('featureDeclaration.output.cutoff.groups[0].min_inclusive');
  });

  test('FR3 (Scenario 5): a binding target without a unit, or naming a dataset column, is refused @SI-002', async () => {
    const noUnit = igg4Declaration();
    delete noUnit.bindingTarget.unit;
    const missing = await createRule('no-unit', 'FEATURE_RULE', { featureDeclaration: noUnit });
    expect(missing.status, JSON.stringify(missing.json)).toBe(400);
    expect(refusalText(missing.json)).toContain('featureDeclaration.bindingTarget.unit');

    const withColumn = igg4Declaration();
    withColumn.bindingTarget.column = 'IGG4_G_L';
    const column = await createRule('column', 'FEATURE_RULE', { featureDeclaration: withColumn });
    expect(column.status, JSON.stringify(column.json)).toBe(400);
    expect(refusalText(column.json)).toContain('featureDeclaration.bindingTarget.column');
  });

  test('C1 (Scenario 6): a declaration on a QC rule is refused, and a declared Feature rule cannot become a QC rule @SI-002 @SI-017', async () => {
    const qc = await createRule('qc', 'QC_RULE', { featureDeclaration: igg4Declaration() });
    expect(qc.status, JSON.stringify(qc.json)).toBe(400);
    expect(refusalText(qc.json)).toContain('FEATURE_DECLARATION_INVALID');

    const feature = await createRule('retype', 'FEATURE_RULE', { featureDeclaration: igg4Declaration() });
    expect(feature.status, JSON.stringify(feature.json)).toBeLessThan(300);
    const retype = await send(admin, 'patch', `/api/v1/rules/${feature.json.id}`, { protocolType: 'QC_RULE' });
    expect(retype.status, JSON.stringify(retype.json)).toBe(400);
    expect(refusalText(retype.json)).toContain('FEATURE_DECLARATION_INVALID');
    expect((await readRule(feature.json.id)).protocolType).toBe('FEATURE_RULE');
  });

  test('FR2 (Scenario 7): protocol compliance names the missing categorical outputs, and passes once they exist @SI-002 @SI-017', async () => {
    const created = await createRule('compliance', 'FEATURE_RULE', { featureDeclaration: igg4Declaration() });
    expect(created.status, JSON.stringify(created.json)).toBeLessThan(300);

    const before = await readRule(created.json.id);
    const failing = (before.checks ?? []).find((c: any) => c.id === 'protocol_compliance');
    expect(failing?.passed, JSON.stringify(before.checks)).toBe(false);
    expect(failing.message).toContain('igg4_level_category');
    expect(failing.message).toContain('igg4_level_status');

    const patched = await send(admin, 'patch', `/api/v1/rules/${created.json.id}`, {
      outputFields: [
        { key: 'igg4_level_category', type: 'string', description: 'IgG4 level category' },
        { key: 'igg4_level_status', type: 'string', description: 'applied | not_applicable | unit_mismatch | missing' },
      ],
    });
    expect(patched.status, JSON.stringify(patched.json)).toBeLessThan(300);

    const after = await readRule(created.json.id);
    const compliance = (after.checks ?? []).find((c: any) => c.id === 'protocol_compliance');
    expect(compliance?.passed ?? true, JSON.stringify(after.checks)).toBe(true);
  });
});

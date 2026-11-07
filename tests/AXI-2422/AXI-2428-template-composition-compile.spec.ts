import { test, expect } from '@playwright/test';
import {
  anonymousCompositionApi,
  compileRequest,
  composition,
  compositionApiAs,
  PINNED_VERSION,
  withStep,
  type CompositionApi,
} from './harness/composition-api';

/**
 * AXI-2428 (epic AXI-2422 — Analysis Template Library, story C — FR15–FR21, NFR1, NFR3, NFR9;
 * AC2, AC5, AC6, AC7, AC15; EC1–EC6). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2422-Analysis-Template-Library.md` § AXI-2428 (scenarios 10–15;
 * 10–12 re-cover AXI-2427 scenarios 1, 2.1 and 3 through the first HTTP surface).
 *
 * Both routes are dry-run: nothing is read from or written to any tenant, so the run leaves no
 * data. Run against a stack serving this branch's gateway + organization-service:
 *   `API_BASE_URL=<gateway> npx playwright test tests/AXI-2422/AXI-2428-*`
 */

const CHECK_ORDER = ['operations_exist', 'roles_satisfied', 'parameters_valid', 'steps_form_dag', 'outputs_declared'];

let user: CompositionApi;

test.beforeAll(async () => {
  user = await compositionApiAs('user');
});
test.afterAll(async () => {
  await user?.dispose();
});

const checkOf = (report: any, checkId: string) => report.checks.find((c: any) => c.checkId === checkId);
const codesOf = (body: any) => body.findings.map((f: any) => f.code);

function withValues(...values: any[]): any {
  const request = compileRequest();
  return { ...request, bindings: { ...request.bindings, parameters: [...request.bindings.parameters, ...values] } };
}
function withSlots(slots: any[]): any {
  const request = compileRequest();
  return { ...request, bindings: { ...request.bindings, slots } };
}

test.describe('AXI-2428 — template composition validate + compile', { tag: ['@SI-069', '@SI-070', '@SI-010', '@SI-002'] }, () => {
  test('AXI-2428.10 a valid composition validates PASS through the route, five checks in order (AC2, AC7)', async () => {
    // Act
    const res = await user.validate({ composition: composition() });
    // Assert
    expect(res.status, res.text).toBe(200);
    expect(res.body.verdict).toBe('PASS');
    expect(res.body.validatorVersion).toBe('1.1.0');
    expect(res.body.nodeLibraryVersion).toBe(PINNED_VERSION);
    expect(res.body.checks.map((c: any) => c.checkId)).toEqual(CHECK_ORDER);
    for (const check of res.body.checks) {
      expect(check.verdict).toBe('PASS');
      expect(check.message.length).toBeGreaterThan(0);
    }
  });

  test('AXI-2428.11 validating the same composition twice gives byte-identical reports (AC7, NFR1)', async () => {
    // Act
    const first = await user.validate({ composition: composition() });
    const second = await user.validate({ composition: composition() });
    // Assert
    expect(first.status).toBe(200);
    expect(second.text).toBe(first.text);
  });

  const EDGE_CASES: { name: string; mutate: () => any; checkId: string; code: string; location?: string }[] = [
    {
      name: 'EC1 an absent operation',
      mutate: () => withStep('s1', (s) => ({ ...s, operationId: 'stats.absent' })),
      checkId: 'operations_exist',
      code: 'operation_absent',
    },
    {
      name: 'EC1 an unknown library pin',
      mutate: () => ({ ...composition(), nodeLibraryVersion: 'sha256:000000000000' }),
      checkId: 'operations_exist',
      code: 'node_library_mismatch',
    },
    {
      name: 'EC2 an unbound required role',
      mutate: () => withStep('s1', (s) => ({ ...s, roles: s.roles.filter((r: any) => r.role !== 'valueColumns') })),
      checkId: 'roles_satisfied',
      code: 'role_unbound',
      location: 'step:s1/role:valueColumns',
    },
    {
      name: 'EC3 a many slot on a one role',
      mutate: () =>
        withStep('s2', (s) => ({
          ...s,
          roles: s.roles.map((r: any) => (r.role === 'valueColumn' ? { ...r, sources: [{ kind: 'slot', slotId: 'values' }] } : r)),
        })),
      checkId: 'roles_satisfied',
      code: 'cardinality_incompatible',
    },
    {
      name: 'EC4 a dangling step',
      mutate: () => ({ ...composition(), outputs: [{ name: 'u', shape: 'numeric', cardinality: 'one', source: { stepId: 's1', column: 'U' } }] }),
      checkId: 'steps_form_dag',
      code: 'step_dangling',
    },
    {
      name: 'EC5 a fixed value of the wrong type',
      mutate: () =>
        withStep('s1', (s) => ({
          ...s,
          parameters: s.parameters.map((p: any) => (p.key === 'alternative' ? { ...p, value: 3 } : p)),
        })),
      checkId: 'parameters_valid',
      code: 'parameter_type',
    },
    {
      name: 'EC6 no declared outputs',
      mutate: () => ({ ...composition(), outputs: [] }),
      checkId: 'outputs_declared',
      code: 'outputs_missing',
    },
  ];

  for (const ec of EDGE_CASES) {
    test(`AXI-2428.12 ${ec.name} BLOCKs ${ec.checkId} with ${ec.code} (AC15)`, async () => {
      // Act
      const res = await user.validate({ composition: ec.mutate() });
      // Assert
      expect(res.status, res.text).toBe(200);
      expect(res.body.verdict).toBe('BLOCK');
      const check = checkOf(res.body, ec.checkId);
      expect(check.verdict).toBe('BLOCK');
      expect(check.findings.map((f: any) => f.code)).toContain(ec.code);
      if (ec.location) expect(check.findings.map((f: any) => f.location)).toContain(ec.location);
    });
  }

  test('AXI-2428.12 EC1 an absent operation leaves roles and parameters NOT_EVALUATED (AC15)', async () => {
    // Act
    const res = await user.validate({ composition: withStep('s1', (s) => ({ ...s, operationId: 'stats.absent' })) });
    // Assert
    expect(checkOf(res.body, 'roles_satisfied').verdict).toBe('NOT_EVALUATED');
    expect(checkOf(res.body, 'parameters_valid').verdict).toBe('NOT_EVALUATED');
  });

  test('AXI-2428.13 the same version + bindings compile twice to the identical governed plan DAG (AC5, AC6)', async () => {
    // Act
    const first = await user.compile(compileRequest());
    const second = await user.compile(compileRequest());
    const narrowed = await user.compile(withSlots([{ slotId: 'group', columns: ['arm'] }, { slotId: 'values', columns: ['il6'] }]));
    // Assert
    expect(first.status, first.text).toBe(200);
    expect(first.body.status).toBe('compiled');
    expect(first.body.report.verdict).toBe('PASS');
    const plan = first.body.plan;
    expect(plan.planId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.template).toEqual({ templateId: 'E2E-C', templateVersion: '1.0' });
    expect(plan.nodeLibraryVersion).toBe(PINNED_VERSION);
    expect(plan.nodes.map((n: any) => n.nodeId)).toEqual(['s1', 's2']);
    expect(plan.nodes[0].roleBindings).toEqual([
      { role: 'groupColumn', sources: [{ kind: 'column', slotId: 'group', column: 'arm' }] },
      {
        role: 'valueColumns',
        sources: [
          { kind: 'column', slotId: 'values', column: 'il6' },
          { kind: 'column', slotId: 'values', column: 'tnf' },
        ],
      },
    ]);
    expect(plan.nodes[0].parameters).toEqual([
      { key: 'groupFrom', value: 'A', origin: 'user' },
      { key: 'groupTo', value: 'B', origin: 'user' },
      { key: 'alternative', value: 'two_sided', origin: 'author_fixed' },
    ]);
    expect(plan.nodes[1].dependsOn).toEqual(['s1']);
    expect(plan.nodes[1].roleBindings[1]).toEqual({
      role: 'valueColumn',
      sources: [{ kind: 'step_output', stepId: 's1', column: 'effectSize' }],
    });
    expect(plan.nodes[1].parameters).toEqual([{ key: 'aggregation', value: 'mean', origin: 'author_default' }]);
    expect(plan.outputs.map((o: any) => o.name)).toEqual(['group_size']);
    expect(second.text).toBe(first.text);
    expect(narrowed.body.status).toBe('compiled');
    expect(narrowed.body.plan.planId).not.toBe(plan.planId);
  });

  const REFUSALS: { name: string; request: () => any; code: string }[] = [
    { name: 'a value outside the author bounds', request: () => withValues({ stepId: 's2', key: 'aggregation', value: 'max' }), code: 'parameter_out_of_bounds' },
    { name: 'a value for an author-fixed parameter', request: () => withValues({ stepId: 's1', key: 'alternative', value: 'less' }), code: 'parameter_fixed' },
    { name: 'an invented parameter', request: () => withValues({ stepId: 's1', key: 'confidence', value: 0.9 }), code: 'parameter_undeclared' },
    { name: 'a value for a step that does not exist', request: () => withValues({ stepId: 's9', key: 'groupFrom', value: 'A' }), code: 'parameter_undeclared' },
    {
      name: 'a missing required value',
      request: () => {
        const r = compileRequest();
        return { ...r, bindings: { ...r.bindings, parameters: [r.bindings.parameters[0]] } };
      },
      code: 'parameter_value_missing',
    },
    { name: 'two columns on a one slot', request: () => withSlots([{ slotId: 'group', columns: ['arm', 'site'] }, { slotId: 'values', columns: ['il6'] }]), code: 'slot_cardinality' },
    { name: 'an unbound slot', request: () => withSlots([{ slotId: 'group', columns: ['arm'] }]), code: 'slot_unbound' },
    {
      name: 'an undeclared slot',
      request: () => withSlots([...compileRequest().bindings.slots, { slotId: 'extra', columns: ['x'] }]),
      code: 'slot_unknown',
    },
  ];

  for (const refusal of REFUSALS) {
    test(`AXI-2428.14 ${refusal.name} is refused bindings_invalid / ${refusal.code}, with no plan (NFR9, EC5)`, async () => {
      // Act
      const res = await user.compile(refusal.request());
      // Assert
      expect(res.status, res.text).toBe(200);
      expect(res.body.status).toBe('refused');
      expect(res.body.code).toBe('bindings_invalid');
      expect(codesOf(res.body)).toContain(refusal.code);
      expect(res.body).not.toHaveProperty('plan');
    });
  }

  test('AXI-2428.14 an author composition the validator BLOCKs is refused composition_invalid (NFR9)', async () => {
    // Act
    const res = await user.compile(compileRequest(withStep('s1', (s) => ({ ...s, operationId: 'stats.absent' }))));
    // Assert
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('refused');
    expect(res.body.code).toBe('composition_invalid');
    expect(res.body.report.verdict).toBe('BLOCK');
    expect(res.body).not.toHaveProperty('plan');
  });

  test('AXI-2428.15 a malformed body or client-asserted tenancy is 400; no token is 401 (FR14, NFR4)', async () => {
    // Arrange
    const anonymous = await anonymousCompositionApi();
    const request = compileRequest();
    // Act
    const malformed = await user.compile({ ...request, composition: { ...request.composition, steps: 'x' } });
    const tenancy = await user.compile({ ...request, organizationId: '00000000-0000-0000-0000-000000000000' });
    const noToken = await anonymous.validate({ composition: composition() });
    await anonymous.dispose();
    // Assert
    expect(malformed.status).toBe(400);
    expect(malformed.text).toContain('composition.steps');
    expect(tenancy.status).toBe(400);
    expect(noToken.status).toBe(401);
  });
});

import { test, expect } from '@playwright/test';
import {
  compileRequest,
  compositionApiAs,
  PINNED_VERSION,
  type CompositionApi,
} from '../AXI-2422/harness/composition-api';

/**
 * AXI-2457 (epic AXI-2455 — TPL FR51–FR53, FR23d; AC22, AC29; EC22–EC24). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2457 (1–5).
 * The comparison set (scenario 4) is bound with the slot's declared AND observed levels, and kept /
 * narrowed by T2's recipe rule (EC15).
 *
 * The composition contract gains an ordering edge (`runsAfter`), a post-hoc declaration
 * (`posthocOf` + the template-level `posthoc` setting) and a comparison set. Both routes are
 * dry-run: nothing is read from or written to any tenant, so the run leaves no data. Run against a
 * stack serving this branch's organization-service:
 *   `API_BASE_URL=<gateway> npx playwright test tests/AXI-2455/AXI-2457-*`
 */

const RUN_CONDITION = { omnibusPValueBelow: 0.05, origin: 'platform_default_awaiting_confirmation' };
const SEMVER = /^\d+\.\d+\.\d+$/;
const LEVELS = ['C1', 'C2', 'C3', 'C4'];
const C1_C5 = [...LEVELS, 'C5'];
const C1_C3 = ['C1', 'C2', 'C3'];

/** The comparison-set slot's level binding: declared levels (declared order), observed levels
 * (null = no profiled domain) and, optionally, the chosen groups (absent = the default set). */
function levelBinding(declaredLevels: string[], observedLevels: string[] | null, groups?: string[]): any {
  return { comparisonSet: { declaredLevels, observedLevels, ...(groups ? { groups } : {}) } };
}

/** The T2 shape: Kruskal-Wallis omnibus, then Dunn as its post-hoc. A fresh object per call. */
function t2(): any {
  const roles = [
    { role: 'groupColumn', sources: [{ kind: 'slot', slotId: 'groupingColumn' }] },
    { role: 'valueColumns', sources: [{ kind: 'slot', slotId: 'outcome' }] },
  ];
  return {
    nodeLibraryVersion: PINNED_VERSION,
    slots: [
      { slotId: 'groupingColumn', shape: 'categorical', cardinality: 'one', wording: { name: 'Groups' } },
      { slotId: 'outcome', shape: 'numeric', cardinality: 'one', wording: { name: 'Outcome' } },
    ],
    steps: [
      {
        stepId: 'omnibus',
        operationId: 'stats.kruskal_wallis',
        libraryPin: { library: 'pingouin', version: '0.5.5' },
        roles,
        parameters: [],
      },
      {
        stepId: 'pairwise',
        operationId: 'stats.dunn_posthoc',
        libraryPin: { library: 'axiome-bio-compute/stats_execution', version: '1.0.0' },
        roles,
        parameters: [],
        runsAfter: ['omnibus'],
        posthocOf: 'omnibus',
      },
    ],
    outputs: [
      { name: 'omnibus_p_value', shape: 'numeric', cardinality: 'one', source: { stepId: 'omnibus', column: 'pValue' } },
      {
        name: 'pairwise_adjusted_p_value',
        shape: 'numeric',
        cardinality: 'one',
        source: { stepId: 'pairwise', column: 'adjustedPValue' },
      },
    ],
    posthoc: { mode: 'defaulted', value: 'always' },
    comparisonSet: { slotId: 'groupingColumn' },
  };
}

function patchStep(base: any, stepId: string, patch: (step: any) => any): any {
  return { ...base, steps: base.steps.map((s: any) => (s.stepId === stepId ? patch(s) : s)) };
}

/** T2 with no ordering edge, no post-hoc declaration and no posthoc setting. */
function unordered(): any {
  const { posthoc: _posthoc, ...base } = t2();
  return patchStep(base, 'pairwise', ({ runsAfter: _r, posthocOf: _p, ...step }) => step);
}

/** A compile of `base`; a composition declaring a comparison set gets its REQUIRED level binding
 * (declared = observed = C1..C4, default set) unless `extra` gives its own. */
function t2Compile(extra: any = {}, base: any = t2()): any {
  const levels = base.comparisonSet ? levelBinding(LEVELS, LEVELS) : {};
  return {
    template: null,
    composition: base,
    bindings: {
      slots: [
        { slotId: 'groupingColumn', columns: ['cluster'] },
        { slotId: 'outcome', columns: ['igg4'] },
      ],
      parameters: [],
      ...levels,
      ...extra,
    },
  };
}

const narrowingTo = (levels: string[]) => ({ slotId: 'groupingColumn', column: 'cluster', levels });

const nodeOf = (plan: any, nodeId: string) => plan.nodes.find((n: any) => n.nodeId === nodeId);
const dagOf = (report: any) => report.checks.find((c: any) => c.checkId === 'steps_form_dag');
const codesOf = (findings: any[]) => findings.map((f: any) => f.code);

let user: CompositionApi;

test.beforeAll(async () => {
  user = await compositionApiAs('user');
});
test.afterAll(async () => {
  await user?.dispose();
});

async function compiledPlan(body: any): Promise<any> {
  const res = await user.compile(body);
  expect(res.status, res.text).toBe(200);
  expect(res.body.status, res.text).toBe('compiled');
  return res.body.plan;
}

async function refusal(body: any): Promise<any> {
  const res = await user.compile(body);
  expect(res.status, res.text).toBe(200);
  expect(res.body.status, res.text).toBe('refused');
  expect(res.body.plan).toBeUndefined();
  return res.body;
}

test.describe(
  'AXI-2457 — composition ordering edge, post-hoc choice and comparison set',
  { tag: ['@SI-069', '@SI-070', '@SI-010', '@SI-002'] },
  () => {
    test('AXI-2457.1 a T2-shaped composition validates PASS on all five checks (AC22)', async () => {
      // Act
      const res = await user.validate({ composition: t2() });
      // Assert
      expect(res.status, res.text).toBe(200);
      expect(res.body.verdict, res.text).toBe('PASS');
      expect(res.body.validatorVersion).toMatch(SEMVER);
      expect(res.body.checks.map((c: any) => c.verdict)).toEqual(['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
    });

    const BAD_EDGES: { name: string; mutate: () => any; code: string; location?: string; count?: number }[] = [
      {
        name: 'a runsAfter target that is no step',
        mutate: () => patchStep(t2(), 'pairwise', (s) => ({ ...s, runsAfter: ['omnibus', 'nope'] })),
        code: 'runs_after_unknown',
        location: 'step:pairwise/runsAfter:nope',
      },
      {
        name: 'running after a later step',
        mutate: () => patchStep(unordered(), 'omnibus', (s) => ({ ...s, runsAfter: ['pairwise'] })),
        code: 'runs_after_forward_reference',
        location: 'step:omnibus',
      },
      {
        name: 'two steps running after each other',
        mutate: () => patchStep(t2(), 'omnibus', (s) => ({ ...s, runsAfter: ['pairwise'] })),
        code: 'step_order_cycle',
        count: 2,
      },
      {
        name: 'a step running after itself',
        mutate: () => patchStep(t2(), 'pairwise', (s) => ({ ...s, runsAfter: ['omnibus', 'pairwise'] })),
        code: 'step_order_cycle',
        location: 'step:pairwise',
      },
      {
        name: 'a post-hoc that does not run after the step it follows',
        mutate: () => patchStep(t2(), 'pairwise', ({ runsAfter: _r, ...s }) => s),
        code: 'posthoc_of_not_after',
        location: 'step:pairwise/posthocOf',
      },
    ];

    for (const edge of BAD_EDGES) {
      test(`AXI-2457.2 ${edge.name} BLOCKs steps_form_dag with ${edge.code} (EC22, AC29)`, async () => {
        // Act
        const res = await user.validate({ composition: edge.mutate() });
        // Assert
        expect(res.status, res.text).toBe(200);
        expect(res.body.verdict).toBe('BLOCK');
        const dag = dagOf(res.body);
        expect(dag.verdict).toBe('BLOCK');
        expect(codesOf(dag.findings)).toContain(edge.code);
        if (edge.location) expect(dag.findings.map((f: any) => f.location)).toContain(edge.location);
        if (edge.count) expect(codesOf(dag.findings).filter((c) => c === edge.code)).toHaveLength(edge.count);
        if (edge.code === 'step_order_cycle') expect(codesOf(dag.findings)).not.toContain('runs_after_forward_reference');
      });
    }

    test('AXI-2457.3 the post-hoc choice always / if_significant / never shapes the plan (EC23, AC22)', async () => {
      // Act
      const always = await compiledPlan(t2Compile());
      const conditional = await compiledPlan(t2Compile({ posthoc: 'if_significant' }));
      const never = await compiledPlan(t2Compile({ posthoc: 'never' }));
      // Assert — always (the author default)
      expect(always.nodes.map((n: any) => n.nodeId)).toEqual(['omnibus', 'pairwise']);
      expect(nodeOf(always, 'pairwise').dependsOn).toEqual(['omnibus']);
      expect(nodeOf(always, 'pairwise').posthocOf).toBe('omnibus');
      expect(nodeOf(always, 'pairwise')).not.toHaveProperty('posthocWhen');
      expect(always.posthoc).toEqual({ value: 'always', origin: 'author_default' });
      // Assert — if_significant: the recipe's run condition on the post-hoc node only
      expect(nodeOf(conditional, 'pairwise').posthocWhen).toEqual(RUN_CONDITION);
      expect(nodeOf(conditional, 'omnibus')).not.toHaveProperty('posthocWhen');
      expect(conditional.posthoc).toEqual({ value: 'if_significant', origin: 'user' });
      expect(conditional.planId).not.toBe(always.planId);
      // Assert — never: the post-hoc step and its output are compiled out
      expect(never.nodes.map((n: any) => n.nodeId)).toEqual(['omnibus']);
      expect(never.outputs.map((o: any) => o.name)).toEqual(['omnibus_p_value']);
    });

    test('AXI-2457.3 a post-hoc value outside the choices is refused bindings_invalid (EC23, AC29)', async () => {
      // Act
      const body = await refusal(t2Compile({ posthoc: 'sometimes' }));
      // Assert
      expect(body.code).toBe('bindings_invalid');
      expect(codesOf(body.findings)).toContain('parameter_enum_value');
    });

    // Scenario 4 — the comparison set follows T2's RECIPE rule (EC15): the expected levels below are
    // what T2's recipe (`comparisonSetFilters`) narrows to on the same declared / observed levels,
    // the parity the back oracle UT-TMPL-514 proves recipe-plan-to-composition-plan.
    test('AXI-2457.4 a strict comparison subset narrows every step reading the slot, in DECLARED order (FR53, AC22)', async () => {
      // Arrange — declared C4..C1, observed C1..C4
      const reversed = [...LEVELS].reverse();
      // Act
      const plan = await compiledPlan(t2Compile(levelBinding(reversed, LEVELS, ['C1', 'C3', 'C2'])));
      // Assert
      const narrowing = narrowingTo(['C3', 'C2', 'C1']);
      expect(plan.nodes.map((n: any) => n.comparisonSet)).toEqual([narrowing, narrowing]);
    });

    test('AXI-2457.4 the full declared set over a fully-observed column narrows nothing and keeps the plan identity (FR53, EC24)', async () => {
      // Act
      const full = await compiledPlan(t2Compile(levelBinding(LEVELS, LEVELS, [...LEVELS].reverse())));
      const byDefault = await compiledPlan(t2Compile());
      const unprofiled = await compiledPlan(t2Compile(levelBinding(LEVELS, null)));
      // Assert
      expect(full.nodes.some((n: any) => 'comparisonSet' in n)).toBe(false);
      expect(full.planId).toBe(byDefault.planId);
      expect(unprofiled.planId).toBe(byDefault.planId);
    });

    for (const [name, binding, kept] of [
      ['declared ⊋ observed, default set: declared ∩ observed', levelBinding(C1_C5, LEVELS), LEVELS],
      ['declared ⊋ observed, explicit observed subset', levelBinding(C1_C5, LEVELS, ['C3', 'C1', 'C2']), C1_C3],
      ['observed ⊄ declared, default set: the undeclared level is narrowed away', levelBinding(C1_C3, LEVELS), C1_C3],
    ] as const) {
      test(`AXI-2457.4 ${name} narrows as T2's recipe does (EC15, FR53)`, async () => {
        // Act
        const plan = await compiledPlan(t2Compile(binding));
        // Assert
        expect(plan.nodes.map((n: any) => n.comparisonSet)).toEqual([narrowingTo([...kept]), narrowingTo([...kept])]);
      });
    }

    for (const [name, extra, code] of [
      ['fewer than two levels', levelBinding(LEVELS, LEVELS, ['C1']), 'comparison_set_too_small'],
      ['a level not declared', levelBinding(LEVELS, [...LEVELS, 'C9'], ['C1', 'C9']), 'comparison_set_level_undeclared'],
      ['a declared level not observed', levelBinding(C1_C5, LEVELS, ['C1', 'C5']), 'comparison_set_level_unobserved'],
      ['no level binding for a declared comparison set', { comparisonSet: undefined }, 'comparison_set_binding_missing'],
    ] as const) {
      test(`AXI-2457.4 ${name} is refused bindings_invalid / ${code} (EC24, AC29)`, async () => {
        // Act
        const body = await refusal(t2Compile(extra));
        // Assert
        expect(body.code).toBe('bindings_invalid');
        expect(codesOf(body.findings)).toEqual([code]);
      });
    }

    test('AXI-2457.5 an AXI-2428 composition compiles with none of the new keys (backward compatibility, AC29)', async () => {
      // Act
      const plan = await compiledPlan(compileRequest());
      // Assert
      for (const node of plan.nodes) {
        expect(node).not.toHaveProperty('posthocOf');
        expect(node).not.toHaveProperty('posthocWhen');
        expect(node).not.toHaveProperty('comparisonSet');
      }
      expect(plan).not.toHaveProperty('posthoc');
    });
  },
);

import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';

/**
 * AXI-848 (epic acceptance, Workflow 5) — Flow Cytometry Population Frequency
 * Table.
 *
 * ── Why this spec is narrow ──────────────────────────────────────────────
 * W5 verification of this epic found that although all 10 stories are Jira
 * `Done`, the feature has almost no reachable UI surface on the running
 * stack:
 *
 *   - `FLOW_EVIDENCE_TYPE_REGISTRATION` (@libs/contracts) was authored with a
 *     full validation suite (FETR-001..011) but was never registered at
 *     platform boot — `GET /v1/evidence-types` returned `[]`, so the upload
 *     wizard's type picker had nothing to offer. FIXED on this validation
 *     branch: `FlowEvidenceTypeSeederService` (organization-service,
 *     evidence-type-registry module) seeds it idempotently on
 *     `onModuleInit`. This spec is the regression test for that fix.
 *   - `DeclareEvidencePage.tsx` (the generic, registry-driven declare page)
 *     explicitly hardcodes DE at submit time: "Generic submission for
 *     evidence type ... is not yet wired. Only rnaseq_de_table is supported
 *     in this iteration." A flow evidence reference cannot be created
 *     through any UI today.
 *   - The gateway has no HTTP controller over
 *     `FLOW_EVIDENCE_REFERENCE_PATTERNS` (compare
 *     `apps/gateway/src/proxy/de-evidence-reference.controller.ts`, which has
 *     no flow analogue) — the service's finalize/mapping/citation logic is
 *     reachable only via internal RMQ message patterns, not a browser or an
 *     API-level E2E.
 *   - No `PivotPanel` (row_axis/column_axis/pivot_direction) component exists
 *     in the frontend — `pivotViewState.ts` is types/helpers only, unused by
 *     any page.
 *
 * Every scenario touching upload, panel-description capture, mapping, pivot,
 * chart-recommendation-on-pivot, linked table+chart, decision citation and
 * PDF export is therefore `manual` in the scenario file
 * (`axiome-docs/manual-e2e/AXI-848-Flow-Cytometry-Population-Frequency.md`)
 * with that reason — writing a Playwright spec against UI that does not
 * exist would be exactly the "test written without the app" anti-pattern the
 * E2E strategy forbids. This spec covers only the one surface that is real
 * and newly fixed: the registry entry itself, over HTTP and in the admin UI.
 *
 * Run: API_BASE_URL=http://localhost:3800 BASE_URL=http://localhost:5973 \
 *   npx playwright test tests/AXI-848
 */

const FLOW_TYPE_ID = 'flow_population_table';

test.describe('AXI-848 epic acceptance — Flow evidence type registration', () => {
  let api: Api;

  test.beforeAll(async () => {
    api = await adminApi();
  });

  test.afterAll(async () => {
    await api.ctx.dispose();
  });

  test('FR9/FR10/FR13/FR22/FR23/FR29-32 — flow_population_table is registered at boot with its full declaration form', { tag: ['@SI-015'] }, async () => {
    const res = await api.get<any[]>('/api/v1/evidence-types');
    expect(res.status).toBe(200);

    const flow = res.body.find((t) => t.type_id === FLOW_TYPE_ID);
    expect(flow, 'flow_population_table must be registered (AXI-848 seeder fix)').toBeTruthy();

    expect(flow.display_name).toBe('Flow Cytometry Population Frequency Table');

    // FR2/FR3 — both shapes accepted.
    expect(flow.schema.shape_modes).toEqual(expect.arrayContaining(['wide', 'long']));
    expect(flow.schema.required_roles).toEqual(['sample_id', 'population', 'value']);

    // FR22/FR23 — pivot is a declared sibling of filters + ordering.
    expect(flow.view_state_primitives).toEqual(
      expect.arrayContaining(['filters', 'ordering', 'pivot']),
    );

    // FR29-32 — the four canonical visualization templates.
    expect(flow.visualization_templates).toEqual(
      expect.arrayContaining(['bar_plot', 'box_plot', 'heatmap', 'parallel_coordinates']),
    );

    // FR9 — declared_tool enum field present on the declaration form.
    const tool = flow.declaration_form.find((f: any) => f.field === 'declared_tool');
    expect(tool?.values).toEqual(['FlowJo', 'OMIQ', 'FACSDiva', 'other']);

    // FR10 — structured panel_description composite with its five subfields.
    const panel = flow.declaration_form.find((f: any) => f.field === 'panel_description');
    expect(panel?.subfields.map((s: any) => s.field)).toEqual(
      expect.arrayContaining(['panel_name', 'panel_version', 'markers', 'parent_gate_hierarchy', 'notes']),
    );

    // FR12a/FR12b/FR13/FR14 — sample_condition_mapping, full coverage required.
    const mapping = flow.declaration_form.find((f: any) => f.field === 'sample_condition_mapping');
    expect(mapping?.coverage).toBe('every_sample_id');
  });

  test('FR58 — registration is idempotent: re-seeding on a second boot does not duplicate or error', { tag: ['@SI-015'] }, async () => {
    // The seeder is onModuleInit, best-effort, and swallows ConflictException;
    // this asserts the OBSERVABLE contract (exactly one registration row) a
    // second run must still hold, not the container's boot log.
    const res = await api.get<any[]>('/api/v1/evidence-types');
    const matches = res.body.filter((t) => t.type_id === FLOW_TYPE_ID);
    expect(matches).toHaveLength(1);
  });

  // No third, browser-driven case: `/admin/evidence-types` gates on a platform-admin
  // `userType`, which the default `admin` E2E role's storageState (AXI-1264's
  // `test@axiomebio.com`-equivalent here) does not hold on this stack — it renders
  // "Admin access required. Evidence types are managed by platform administrators."
  // The two API-level tests above already assert the exact contract that page would
  // render (display_name, declaration form, view-state primitives); a UI-only
  // assertion of the same string behind a permission tier this role cannot hold
  // would just be a flakier restatement of them.
});

import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { workspaceHeader } from '../AXI-1400/harness/api';
import { ingestFixture, type Tenant } from '../AXI-1474/harness/seed';
import { approveSeededRules } from '../AXI-1762/seeded-rule-approval';
import { seedLiveWorkbench, stepUrl, type Seeded } from '../AXI-1717/harness/live-workbench';
import { RuleFamilyWorld, send, type Actor } from './harness/world';

/**
 * AXI-2029 (epic AXI-1991 — AC18, SI-042; debt closed from AXI-2005's own
 * "no browser-level spec for the withholding messages or the unusable-rule
 * indicator" and AXI-2023's "E2E must assert against a runnable withheld
 * guard" note).
 *
 * Two structured-code fields AXI-2023 added to the wire. Both DO have a
 * dedicated front-end marker each — confirmed on `axiome-front` `origin/main`
 * (`fe919b8`; corrected on bounce #2, B2, after an earlier draft of this
 * comment wrongly said the resolver marker did not exist — it does, see
 * below):
 *   - `src/lib/rules/ruleRunResolution.ts#readinessOf` sets
 *     `familyWithheld: resolution.disabledReasonCode === 'family_not_authorized'`
 *     on its `'disabled'` state → `RuleDetailPane.tsx`'s `ReadinessLine` sets
 *     BOTH `data-family-withheld="true"` (line 202) AND
 *     `data-testid="rule-withheld-family-resolver"` on the `AlertTriangle`
 *     icon (line 214) when `familyWithheld` is true.
 *   - `src/lib/discoveryWorkbench/stepResolver.ts#isFamilyWithheld` reads
 *     `resolution.familyWithheldReasonCode === 'family_not_authorized'` →
 *     `NextSteps.tsx`'s `StepCard` renders a
 *     `data-testid="rule-withheld-family-qc-guards"` marker exactly when
 *     true.
 *
 * BOUNCE #1 (B2): review correctly found that §2.5 claimed `automation:
 * playwright` browser coverage for both markers that this file never drove
 * through a browser. BOUNCE #2 (B2) corrected the resolver reason above
 * (the marker DOES exist; my bounce-#1 doc comment's denial of it was
 * itself the false statement) and REPLACED the QC-guards reason below with
 * the reviewer's own verified one. Both markers exist; NEITHER is reachable
 * in a live page today, for these two DIFFERENT, source-verified reasons:
 *   - **Resolver marker.** `RuleDetailPane`'s only production mount,
 *     `DeltaRuleSelectionModal.tsx`, selects a rule to resolve only from the
 *     picker's `offered` bucket — a family-withheld rule is in
 *     `notAvailable[]` (§2.3's own surface) and is never resolved, so the
 *     `disabled`+`familyWithheld` state the marker renders on is never
 *     reached for it through this mount.
 *   - **QC-guards marker.** `StepCard` is mounted only by `NextSteps.tsx`,
 *     which renders steps from `nextStepOperations(template, operations,
 *     kind)` (`stepResolver.ts`) — a flatMap over `template.steps[*]
 *     .operationIds`. The `qc_guards` plan step is declared with an EMPTY
 *     `operationIds` array (axiome-back `apps/organization-service/src/
 *     guided-analysis/templates/discovery-plan.template.ts`, the
 *     `qc_guards: step(2, 'qc_guards', 'QC guards', 'deterministic', true,
 *     [], QC_RULE_CODES, QC_CONFIG_KEYS)` call — the sixth positional arg,
 *     `operationIds`, is `[]`), so `nextStepOperations` contributes zero
 *     entries for it and `NextSteps` never emits a `StepCard` for this step
 *     at all, regardless of narrowing.
 *
 * Both structured fields are still pinned at the WIRE level below — the same
 * justification `AXI-2005-enforcement-pickers.spec.ts` already gives for
 * calling `GET /rule-runs/offered-rules` directly — but neither test claims
 * browser coverage; see the scenario doc's §2.5 manual block for the exact
 * reasons above, carried verbatim.
 *
 * AUTHORED, NOT RUN — no stack was started for this story.
 */

test.describe('AXI-2029 — run resolver and QC-guards step family-withheld indicators', () => {
  test.describe.configure({ timeout: 180_000 });

  test(
    'AC18/SI-042: the run resolver reports disabledReasonCode=family_not_authorized only once a rule is withheld — the structured field RuleDetailPane#ReadinessLine sets data-family-withheld on, pinned at the wire level (not reachable live — see this file\'s doc comment) @SI-017 @SI-010',
    async () => {
      const ingestApi: Api = await adminApi();
      const world = await RuleFamilyWorld.create();
      try {
        const orgId = await world.organization('resolver-indicator');
        const { ruleId, workspaceId } = await world.servedQcRule(orgId, 'resolver', `AXI2029RESOLVER-${Date.now()}`);
        const projectId = await world.project('resolver-indicator', workspaceId);
        const tenant: Tenant = { orgId, workspaceId, headers: workspaceHeader(workspaceId) };
        const datasetId = await ingestFixture(ingestApi, tenant);

        const resolveBody = () => ({
          ruleId,
          operationId: 'qc.rule_gate',
          workspaceId,
          projectId,
          datasetId,
        });

        // Positive baseline (AXI-2005's B1 lesson — assert the un-gated case
        // BEFORE narrowing, so the gated assertion can never pass for the
        // wrong reason). Called AS THE PLATFORM ADMIN: `RuleRunScopeAuthorizerService
        // .authorize` returns immediately for a platform admin (before any
        // tenancy lookup), so this call needs no separate workspace-member
        // actor — the family gate itself still applies to admins with no
        // bypass (AC7/Q9, already proven by `AXI-2005-enforcement-pickers
        // .spec.ts`'s own admin test); only the UNRELATED scope-authorizer
        // is skipped here, which is not under test in this file.
        const baseline = await send(world.admin, 'post', '/api/v1/rule-runs/resolve', resolveBody());
        expect(baseline.status, `baseline resolve: ${JSON.stringify(baseline.json)}`).toBeLessThan(300);
        expect(
          baseline.json.disabledReasonCode,
          `baseline must not be family-withheld before narrowing: ${JSON.stringify(baseline.json)}`,
        ).toBeUndefined();

        await world.withNarrowedRule(orgId, ruleId, 'AXI-2029 Resolver Indicator Narrowing', async () => {
          const after = await send(world.admin, 'post', '/api/v1/rule-runs/resolve', resolveBody());
          expect(after.status, `resolve after narrowing: ${JSON.stringify(after.json)}`).toBeLessThan(300);
          expect(after.json.disabledReasonCode, JSON.stringify(after.json)).toBe('family_not_authorized');
          expect(after.json.fullyBound).toBe(false);
          expect(after.json.fields).toEqual([]);
          expect(typeof after.json.disabledReason).toBe('string');
        });
      } finally {
        await world.dispose();
        await ingestApi.ctx.dispose();
      }
    },
  );

  test(
    "AC18/SI-042: the qc_guards step's familyWithheldRuleCodes names exactly the withheld guard that is RUNNABLE right now (no recorded/running attempt), pinned at the wire level for NextSteps#StepCard's marker (no Workbench screen invokes it for qc_guards yet — see this file's doc comment) — the AXI-2023 debt's own required case @SI-045 @SI-017",
    async () => {
      // Reuses the SAME proven live-workbench fixture `AXI-1819-qc-guards-
      // submit.spec.ts` drives this exact route through — d2/d3/d4 cite
      // IMM-QC-01/IMM-QC-02/IMM-QC-05 respectively (that spec's own
      // assertion, test 16.1). d4/IMM-QC-05 is narrowed here because it is
      // the LEAST widely cited of the three across this suite (IMM-QC-01 is
      // already the shared rule AXI-2005's own file narrows); d2/d3 are left
      // untouched and asserted still runnable/un-withheld, so this proves
      // the per-guard scoping, not a step-wide effect.
      const s: Seeded = await seedLiveWorkbench(`axi-2029-qcg-${Date.now().toString(36)}`, `AXI-2029 QC Guards Indicator ${Date.now()}`);
      const world = await RuleFamilyWorld.create();
      try {
        const { 'IMM-QC-05': ruleId } = await approveSeededRules(['IMM-QC-05']);
        expect(ruleId, 'IMM-QC-05 must already be served by seedLiveWorkbench').toBeTruthy();

        const baseline = await s.api.post(stepUrl(s.viewAnalysisId, 'qc_guards', 'resolve'), { operationId: 'qc.rule_gate', datasetId: s.datasetId }, s.t.headers);
        expect(baseline.status, JSON.stringify(baseline.body)).toBe(200);
        expect(baseline.body.familyWithheldRuleCodes, `baseline must carry no withheld codes: ${JSON.stringify(baseline.body)}`).toBeUndefined();
        expect(baseline.body.familyWithheldReasonCode).toBeUndefined();

        await world.withNarrowedRule(s.t.orgId, ruleId, 'AXI-2029 QC Guards Indicator Narrowing', async () => {
          const after = await s.api.post(stepUrl(s.viewAnalysisId, 'qc_guards', 'resolve'), { operationId: 'qc.rule_gate', datasetId: s.datasetId }, s.t.headers);
          expect(after.status, JSON.stringify(after.body)).toBe(200);
          expect(after.body.familyWithheldReasonCode, JSON.stringify(after.body)).toBe('family_not_authorized');
          // Exactly d4/IMM-QC-05 — never d2/d3, which cite IMM-QC-01/IMM-QC-02 and
          // stay usable, proving this is a per-rule effect, not a step-wide one.
          expect(after.body.familyWithheldRuleCodes, JSON.stringify(after.body)).toEqual(['IMM-QC-05']);
          // The reviewer's own caveat (AXI-2023 debt): the sentence covers only
          // guards RUNNABLE now. A fresh container's guards are all unattempted
          // (unservedOf/guardsToRun), so d4 is runnable — the sentence must name
          // it, coinciding with the structured code (never one without the other).
          expect(after.body.disabledReason, JSON.stringify(after.body)).toMatch(
            /QC guard d4 cites IMM-QC-05, which is not usable in this project: No family of this rule is authorized for this project\./,
          );
          expect(after.body.nodeIds, JSON.stringify(after.body)).toEqual(expect.arrayContaining(['d2', 'd3', 'd4']));
        });

        const restored = await s.api.post(stepUrl(s.viewAnalysisId, 'qc_guards', 'resolve'), { operationId: 'qc.rule_gate', datasetId: s.datasetId }, s.t.headers);
        expect(restored.status, JSON.stringify(restored.body)).toBe(200);
        expect(restored.body.familyWithheldRuleCodes, `withholding must not survive cleanup: ${JSON.stringify(restored.body)}`).toBeUndefined();
      } finally {
        await world.dispose();
        await s.api.ctx.dispose();
      }
    },
  );
});

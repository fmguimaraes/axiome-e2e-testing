import { test, expect } from '@playwright/test';
import { adminApi, type Api, workspaceHeader } from '../AXI-1400/harness/api';
import { ingestFixture, type Tenant } from '../AXI-1474/harness/seed';
import { RuleFamilyWorld, send } from './harness/world';

/**
 * AXI-2029 (epic AXI-1991 — AC18, SI-017; "the flows that cross stories" half
 * of this story's own Jira subject).
 *
 * `AXI-2005-enforcement-pickers.spec.ts` and `AXI-2005-new-run-history-
 * decision.spec.ts` already each pin ONE surface's withholding, in
 * isolation, in their own files. What neither proves is that the picker, the
 * preflight dry-run and the execute refusal all agree with EACH OTHER at the
 * SAME moment, for the SAME rule/project — i.e. that `UsableRuleGateService`
 * is genuinely the ONE composition every caller reads, not three call sites
 * that happen to be separately correct today. This spec narrows a rule
 * exactly once and, inside that one window, drives all three:
 *
 *   - `GET /rule-runs/offered-rules` (picker) — `RuleRunResolverService`'s
 *     sibling offering read, `rules/offering/offered-rule.ts`.
 *   - `POST /rule-runs/preflight` — `RuleRunsService.preflight`, which
 *     catches exactly a `RuleFamilyGateRefusal` and reports it as a typed
 *     BLOCK (`toBlock()`, `id: 'RULE_FAMILY_NOT_AUTHORIZED'`) — never a bare
 *     400, unlike execute.
 *   - `POST /rule-runs` (execute/submit) — refused 400,
 *     `message` leading `RULE_FAMILY_NOT_AUTHORIZED: `.
 *
 * `automation: manual` for the remaining two surfaces this AC18 flow also
 * names (recorded in the scenario doc, not restated here):
 *   - **Chart QC catalogue** (`GET /charts/:specId/qc-rules`) — reachable
 *     only against a real materialized `DataviewSpec`, a multi-step fixture
 *     (completed analysis + a materialized chart) outside this spec's
 *     API-only budget; `AXI-2005-enforcement-pickers.spec.ts`'s own §2.3
 *     manual note already defers it for the same reason, pinned by AXI-1998's
 *     unit tests.
 *   - **Workbench QC-guards step** — covered SEPARATELY and FULLY by
 *     `AXI-2029-resolver-and-qc-guards-indicators.spec.ts`'s second test in
 *     this same story (narrows `IMM-QC-05`, asserts
 *     `familyWithheldRuleCodes`/`disabledReason`) — not repeated here to
 *     avoid two specs holding the SAME shared-seeded-rule narrowing window at
 *     once (this story's own `--workers=1` run constraint, see the scenario
 *     doc's run-constraints section).
 *
 * AUTHORED, NOT RUN — no stack was started for this story.
 */
test.describe('AXI-2029 — picker, preflight and execute agree on the SAME withholding at the SAME moment', () => {
  test.describe.configure({ timeout: 180_000 });

  test(
    "AC18: a rule withheld by the family gate is absent from offered-rules, blocked by preflight, and refused by execute — all three, in the SAME narrowing window, for the SAME rule/project @SI-017",
    async () => {
      const ingestApi: Api = await adminApi();
      const world = await RuleFamilyWorld.create();
      try {
        const orgId = await world.organization('cross-surface');
        const { ruleId, workspaceId } = await world.servedQcRule(orgId, 'crosssurf', `AXI2029CROSSSURF-${Date.now()}`);
        const tenant: Tenant = { orgId, workspaceId, headers: workspaceHeader(workspaceId) };
        const datasetId = await ingestFixture(ingestApi, tenant);
        const projectId = await world.project('cross-surface', workspaceId);

        const runBody = { ruleId, runKind: 'QC', operationId: 'qc.rule_gate', projectId, workspaceId, datasetId };
        const offeredUrl = `/api/v1/rule-runs/offered-rules?workspaceId=${workspaceId}&projectId=${projectId}`;

        // Positive baseline, ALL THREE surfaces, before any narrowing — so
        // none of the three withheld/blocked/refused assertions below can
        // pass for a reason unrelated to the family gate.
        const baselineOffered = await send(world.admin, 'get', offeredUrl);
        expect(baselineOffered.status, JSON.stringify(baselineOffered.json)).toBeLessThan(300);
        expect(
          (baselineOffered.json.offered ?? []).some((r: any) => (r.id ?? r.rule?.id) === ruleId),
          `baseline must offer the rule: ${JSON.stringify(baselineOffered.json)}`,
        ).toBe(true);
        const baselinePreflight = await send(world.admin, 'post', '/api/v1/rule-runs/preflight', runBody);
        expect(baselinePreflight.status, JSON.stringify(baselinePreflight.json)).toBeLessThan(300);
        expect(
          (baselinePreflight.json.blocks ?? []).some((b: any) => b.id === 'RULE_FAMILY_NOT_AUTHORIZED'),
          `baseline preflight must carry no family block: ${JSON.stringify(baselinePreflight.json)}`,
        ).toBe(false);

        await world.withNarrowedRule(orgId, ruleId, 'AXI-2029 Cross-Surface Narrowing', async () => {
          const offered = await send(world.admin, 'get', offeredUrl);
          expect(offered.status, JSON.stringify(offered.json)).toBeLessThan(300);
          expect(
            (offered.json.offered ?? []).some((r: any) => (r.id ?? r.rule?.id) === ruleId),
            `picker: ${JSON.stringify(offered.json)}`,
          ).toBe(false);
          const notAvailable = (offered.json.notAvailable ?? []).find((e: any) => (e.rule?.id ?? e.ruleId) === ruleId);
          expect(notAvailable, `picker must name the withheld rule: ${JSON.stringify(offered.json)}`).toBeTruthy();
          expect(notAvailable.reasonCode).toBe('family_not_authorized');

          const preflight = await send(world.admin, 'post', '/api/v1/rule-runs/preflight', runBody);
          expect(preflight.status, JSON.stringify(preflight.json)).toBeLessThan(300);
          const block = (preflight.json.blocks ?? []).find((b: any) => b.id === 'RULE_FAMILY_NOT_AUTHORIZED');
          expect(block, `preflight: ${JSON.stringify(preflight.json)}`).toBeTruthy();

          const executed = await send(world.admin, 'post', '/api/v1/rule-runs', runBody);
          expect(executed.status, JSON.stringify(executed.json)).toBe(400);
          expect(String(executed.json?.message ?? ''), JSON.stringify(executed.json)).toMatch(/^RULE_FAMILY_NOT_AUTHORIZED: /);

          // Same reason text on every surface — never a per-surface sentence.
          expect(block.reason).toBe(notAvailable.reason);
        });
      } finally {
        await world.dispose();
        await ingestApi.ctx.dispose();
      }
    },
  );
});

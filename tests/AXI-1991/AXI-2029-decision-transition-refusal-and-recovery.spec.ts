import { test, expect } from '@playwright/test';
import { adminApi, type Api, workspaceHeader } from '../AXI-1400/harness/api';
import { ingestFixture, pollRunTerminal, resolveMaterialisedRow, type Tenant } from '../AXI-1474/harness/seed';
import { RuleFamilyWorld, send, orgHeader } from './harness/world';

/**
 * AXI-2029 (epic AXI-1991 — AC14/AC18, SI-015, SI-017; distinct coverage from
 * `AXI-2005-new-run-history-decision.spec.ts`'s own AC14 test, which narrows
 * the rule BEFORE `POST .../decisions` and proves only
 * `DecisionDraftsService.create`'s gate call. This spec narrows AFTER a
 * `draft`-status Decision already exists, so the assertion is specifically
 * `applyStatusTransition`'s OWN gate call (`decision-drafts.service.ts`,
 * `DECISION_FAMILY_GATED_TARGET_STATUSES = {'reviewed','valid'}` — a
 * deliberately narrower set than `DECISION_IMMUTABLE_STATUSES`, per that
 * constant's doc comment) — judged at the moment `reviewed` is ENTERED, over
 * the FULL stored citation set, not a diff. It also drives the RECOVERY half
 * no existing spec covers: re-authorizing the family mid-flow lets the SAME
 * draft transition where it was refused a moment before.
 *
 * `POST /api/v1/workspaces/:workspaceId/decisions/:id/transition`
 * (`apps/gateway/src/proxy/decision-drafts.controller.ts#transitionStatus`)
 * requires `decision:review` for a `targetStatus: 'reviewed'` body — held by
 * the `admin` workspace role (`libs/common/src/permissions/permissions
 * .constants.ts`). `world.admin` is the workspace's own creator and is
 * auto-enrolled as an `admin` member (`workspaces.service.ts`, "Add creator
 * as admin member" — the same fact `world.servedQcRule`'s own doc comment
 * cites), so no additional actor/role wiring is needed.
 *
 * The refusal, thrown by `DecisionDraftFamilyGateService
 * .assertCitedRulesUsableOrRefuse` as a `RuleFamilyGateRefusal` (a 400
 * `BadRequestException` whose `message` is
 * `` `RULE_FAMILY_NOT_AUTHORIZED: ${reason}` ``), is the SAME refusal shape
 * `AXI-2005-new-run-history-decision.spec.ts` already asserts for the run
 * and create paths, confirmed here for the transition path specifically.
 *
 * AUTHORED, NOT RUN — no stack was started for this story.
 */
test.describe('AXI-2029 — Decision transition is gated at the moment reviewed/valid is entered, and recovers once re-authorized', () => {
  test.describe.configure({ timeout: 240_000 });

  test(
    "AC14/AC18: draft -> reviewed is refused once the draft's already-cited rule is narrowed out of its project's authorized families, and succeeds again once the family is restored @SI-015 @SI-017",
    async () => {
      const ingestApi: Api = await adminApi();
      const world = await RuleFamilyWorld.create();
      try {
        const orgId = await world.organization('decision-transition');
        const { ruleId, workspaceId } = await world.servedQcRule(orgId, 'dtrans', `AXI2029DTRANS-${Date.now()}`);
        const tenant: Tenant = { orgId, workspaceId, headers: workspaceHeader(workspaceId) };
        const datasetId = await ingestFixture(ingestApi, tenant);
        const projectId = await world.project('decision-transition', workspaceId);

        // Materialize a rule-derived snapshot the Decision will cite, while
        // the rule is still ordinarily authorized (AXI-1997's own default:
        // every family starts default-authorized for every project, FR24).
        const submitted = await send(
          world.admin,
          'post',
          '/api/v1/rule-runs',
          { ruleId, runKind: 'QC', operationId: 'qc.rule_gate', projectId, workspaceId, datasetId },
        );
        expect(submitted.status, `baseline QC run submit: ${JSON.stringify(submitted.json)}`).toBeLessThan(300);
        const polled = await pollRunTerminal(ingestApi, tenant, submitted.json.ruleRunId);
        const row = await resolveMaterialisedRow(ingestApi, tenant, polled);
        const analysisId: string = submitted.json?.existingViewAnalysisId;
        expect(analysisId, `baseline run must resolve an analysis id: ${JSON.stringify(submitted.json)}`).toBeTruthy();
        const snaps = await ingestApi.get(`/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=200`, tenant.headers);
        const list = Array.isArray(snaps.body) ? snaps.body : snaps.body?.data ?? snaps.body?._list ?? [];
        const derived = list.find((s: any) => s.origin === 'rule_derived' && s.ruleRunId === row.id);
        expect(derived, `no rule-derived snapshot found for run ${row.id}: ${JSON.stringify(list)}`).toBeTruthy();

        // Create the Decision in `draft` — the rule is still authorized, so
        // `DecisionDraftsService.create`'s OWN gate call (judging this same
        // citation) passes; this spec is about what happens to this SAME
        // draft's transition AFTER authorization changes, not about create.
        const created = await send(
          world.admin,
          'post',
          `/api/v1/workspaces/${workspaceId}/decisions`,
          {
            label: 'AXI-2029 decision transition refusal+recovery fixture',
            type: 'biomarker_threshold',
            projectId,
            context: { intendedUse: 'AXI-2029 E2E fixture' },
            evidenceLinks: [],
            evidenceValues: [{ metric: 'axi_2029_e2e', value: 1, unit: 'count', sourceSnapshotId: derived.id }],
          },
          tenant.headers,
        );
        expect(created.status, `creating the draft decision: ${JSON.stringify(created.json)}`).toBeLessThan(300);
        expect(created.json.status, JSON.stringify(created.json)).toBe('draft');
        const decisionId = created.json.id;

        // Narrow the cited rule out of the project's authorized families —
        // the draft already exists and already cites it; nothing about the
        // draft itself changes yet (FR33 — a read never re-judges).
        const family = await world.createFamily({ userId: world.adminUserId, api: world.admin }, orgId, 'organization', 'AXI-2029 Decision Transition Narrowing');
        expect(family.id, `family create: ${JSON.stringify(family)}`).toBeTruthy();
        const added = await send(world.admin, 'post', '/api/v1/rule-family-membership/add', { familyId: family.id, ruleId }, orgHeader(orgId));
        expect(added.status, `narrowing the rule: ${JSON.stringify(added.json)}`).toBeLessThan(300);

        try {
          // The refusal: entering `reviewed` re-judges the FULL stored
          // citation set, and the cited rule is no longer usable for this
          // draft's project.
          const refused = await send(
            world.admin,
            'post',
            `/api/v1/workspaces/${workspaceId}/decisions/${decisionId}/transition`,
            { targetStatus: 'reviewed' },
            tenant.headers,
          );
          expect(refused.status, `transition must be refused while narrowed: ${JSON.stringify(refused.json)}`).toBe(400);
          expect(String(refused.json?.message ?? ''), JSON.stringify(refused.json)).toMatch(/^RULE_FAMILY_NOT_AUTHORIZED: /);

          // The draft must still read as `draft` — a refused transition
          // writes nothing (the whole gate call sits ahead of the status
          // write inside `applyStatusTransition`'s own transaction).
          const stillDraft = await send(world.admin, 'get', `/api/v1/workspaces/${workspaceId}/decisions/${decisionId}`, undefined, tenant.headers);
          expect(stillDraft.json.status, JSON.stringify(stillDraft.json)).toBe('draft');
        } finally {
          // RECOVERY: remove the narrowing membership before this family is
          // deleted — restores ordinary (default-authorized) access to the
          // rule for every project on the stack, undoing the withholding
          // this test introduced regardless of which assertion above threw.
          const removed = await send(world.admin, 'post', '/api/v1/rule-family-membership/remove', { familyId: family.id, ruleId }, orgHeader(orgId));
          if (removed.status >= 300) {
            throw new Error(
              `AXI-2029 cleanup: removing rule ${ruleId} from the narrowing family failed (${JSON.stringify(removed.json)}) — ` +
                'the shared rule may now be withheld stack-wide; see the recovery note in manual-e2e/AXI-1991-Rule-Families.md §3',
            );
          }
          const deletedFamily = await send(world.admin, 'delete', `/api/v1/rule-families/${family.id}`, undefined, orgHeader(orgId));
          if (deletedFamily.status >= 300) {
            throw new Error(`AXI-2029 cleanup: deleting the narrowing family (${family.id}) failed: HTTP ${deletedFamily.status} ${JSON.stringify(deletedFamily.json)}`);
          }
        }

        // Recovery proper: the SAME draft, previously refused, now
        // transitions once its citation is usable again.
        const recovered = await send(
          world.admin,
          'post',
          `/api/v1/workspaces/${workspaceId}/decisions/${decisionId}/transition`,
          { targetStatus: 'reviewed' },
          tenant.headers,
        );
        expect(recovered.status, `transition must succeed once re-authorized: ${JSON.stringify(recovered.json)}`).toBeLessThan(300);
        expect(recovered.json.status, JSON.stringify(recovered.json)).toBe('reviewed');
      } finally {
        await world.dispose();
        await ingestApi.ctx.dispose();
      }
    },
  );
});

import { test, expect } from '@playwright/test';
import { adminApi, type Api, workspaceHeader } from '../AXI-1400/harness/api';
import { ingestFixture, type Tenant } from '../AXI-1474/harness/seed';
import { RuleFamilyWorld, send } from './harness/world';

/**
 * AXI-2029 (epic AXI-1991 — AC19, SI-017; closes AXI-2024's own debt note:
 * "the project id is validated against the workspace but not against the
 * dataset's project").
 *
 * `RuleRunsService.execute` (`apps/organization-service/src/rule-runs/
 * rule-runs.service.ts`), AFTER resolving the referent and BEFORE the
 * fingerprint/dispatch, calls the private
 * `assertProjectLinkedToReferentDatasetOrRefuse(request.projectId,
 * referent.datasetId)`:
 *   - a dataset with NO recorded `ProjectDatasetLink` row at all is left
 *     unchanged (ambiguous/unknown case, deliberately out of scope — this
 *     spec's baseline exercises the OTHER branch instead, see below);
 *   - a dataset with at least one recorded link is judged against that set:
 *     a claimed `projectId` absent from it throws exactly
 *     `BadRequestException(
 *       \`Project ${projectId} is not linked to this run's referent dataset — \` +
 *       'the submission must name a project the dataset actually belongs to, not merely one in ' +
 *       'the same workspace.')`
 *   (both quoted verbatim from that method's source, read on `origin/main`).
 * `POST /api/v1/rule-runs` (gateway `rule-runs.controller.ts#execute`, the
 * bare `@Post()`) is the one route that reaches it; the family gate
 * (`assertRuleFamilyUsableOrRefuse`) runs earlier in the same method and is
 * NOT what is under test here — both projects below share the rule's own
 * default-authorized family so the family gate passes for either, isolating
 * this assertion to the link check alone.
 *
 * Called as `world.admin` (platform admin): `authorizeRuleRunScope` returns
 * immediately for a platform admin (same bypass as the resolver spec in this
 * story — `rule-run-scope.authorizer.ts`), which is immaterial here since the
 * check under test runs deeper in the service, after that authorizer.
 *
 * AUTHORED, NOT RUN — no stack was started for this story.
 */
test.describe('AXI-2029 — a run must name a project the referent dataset is actually linked to', () => {
  test.describe.configure({ timeout: 180_000 });

  test(
    "AC19: executing a QC run against a project the dataset is NOT linked to is refused by name, once the dataset has at least one recorded link elsewhere @SI-017",
    async () => {
      const ingestApi: Api = await adminApi();
      const world = await RuleFamilyWorld.create();
      try {
        const orgId = await world.organization('dataset-link');
        const { ruleId, workspaceId } = await world.servedQcRule(orgId, 'dslink', `AXI2029DSLINK-${Date.now()}`);
        const tenant: Tenant = { orgId, workspaceId, headers: workspaceHeader(workspaceId) };
        const datasetId = await ingestFixture(ingestApi, tenant);

        const linkedProjectId = await world.project('dataset-link-linked', workspaceId);
        const unlinkedProjectId = await world.project('dataset-link-unlinked', workspaceId);

        // Record the ONE link this dataset has — the private method's "at
        // least one recorded link" precondition for judging the claim.
        const link = await send(world.admin, 'post', `/api/v1/projects/${linkedProjectId}/datasets`, { datasetId }, tenant.headers);
        expect(link.status, `linking dataset to the authorized project: ${JSON.stringify(link.json)}`).toBeLessThan(300);

        const runBody = (projectId: string) => ({
          ruleId,
          runKind: 'QC',
          operationId: 'qc.rule_gate',
          projectId,
          workspaceId,
          datasetId,
        });

        // Baseline: the LINKED project is accepted (queued, 2xx) — proves the
        // refusal below is about the unlinked claim, never about this rule/
        // dataset/project combination being unrunnable for some other reason.
        const accepted = await send(world.admin, 'post', '/api/v1/rule-runs', runBody(linkedProjectId));
        expect(accepted.status, `baseline run against the linked project must be accepted: ${JSON.stringify(accepted.json)}`).toBeLessThan(300);

        // The refusal: a project in the SAME workspace, holding the SAME
        // family authorization, but never linked to this dataset.
        const refused = await send(world.admin, 'post', '/api/v1/rule-runs', runBody(unlinkedProjectId));
        expect(refused.status, `unlinked project must be refused: ${JSON.stringify(refused.json)}`).toBe(400);
        expect(
          String(refused.json?.message ?? ''),
          JSON.stringify(refused.json),
        ).toContain("is not linked to this run's referent dataset");
        expect(
          String(refused.json?.message ?? ''),
          JSON.stringify(refused.json),
        ).toContain('the same workspace');
      } finally {
        await world.dispose();
        await ingestApi.ctx.dispose();
      }
    },
  );
});

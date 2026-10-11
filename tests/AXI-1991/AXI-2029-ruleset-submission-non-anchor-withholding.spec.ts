import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, type Api, workspaceHeader } from '../AXI-1400/harness/api';
import { ingestFixture, type Tenant } from '../AXI-1474/harness/seed';
import { RuleFamilyWorld, send } from './harness/world';

/**
 * AXI-2029 (epic AXI-1991 — AC7; bounce #1, B1) — closes AXI-2024's own debt
 * note, "a ruleset submission gates only its anchor rule".
 *
 * `RuleRunsService.resolveQcRulesetSubmission`
 * (`apps/organization-service/src/rule-runs/rule-runs.service.ts`), called
 * from `execute()` whenever a QC run cites `rulesetId` instead of a single
 * `ruleId`, resolves EVERY served `QC_RULE` member (never only the
 * deterministic anchor — the lowest `rulesetRuleKey`), collects the family
 * gate's input for each, and calls `UsableRuleGateService.partitionUsable`
 * ONCE over the whole batch (NFR3). Any withheld member refuses the WHOLE
 * ruleset citation before anything is written — `RuleFamilyGateRefusal`'s
 * additive `ruleIds` (AXI-2024) names every withheld member in the message
 * suffix ("Unusable rule(s): <id>, <id>.").
 *
 * The ruleset IS stageable through the public API inside this harness —
 * `admin/rulesets/import` (multipart JSON) + `admin/rulesets/:id/activate`,
 * the SAME contract `AXI-1808-ruleset-approval-gate.spec.ts` already drives
 * for a different story. A freshly-activated ruleset materializes its
 * members at the FR9 verdict (`checked`/`draft`), never `published`
 * (AXI-1808's own pinned claim) — `resolveQcRulesetSubmission` only accepts
 * SERVED members, so each complete member is walked submit-for-review +
 * approve (mirroring AXI-1808's own §16.3.3 fork test) before this spec's
 * assertions run.
 *
 * ⚠️ GLOBAL SIDE EFFECT, same caveat `AXI-1808-ruleset-approval-gate.spec.ts`
 * already records for this surface (and `AXI-1149`'s before it):
 * `admin/rulesets/:id/activate` replaces the ONE stack-wide active ruleset.
 * Never run this file against the shared demo stack, and never run it
 * concurrently with another suite that depends on a particular ruleset
 * being active — see the scenario doc's run-constraints section (§3).
 *
 * AUTHORED, NOT RUN — no stack was started for this story.
 */

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** Two complete (FR9-passing) QC_RULE members — `rule_id`'s lexical order
 *  decides the deterministic anchor (lowest `rulesetRuleKey`): `a-anchor`
 *  sorts before `b-member`, so the anchor stays usable throughout and only
 *  the SECOND member is ever narrowed. */
function rulesetPayload(labelPrefix: string) {
  const anchorKey = `a-anchor-${unique(labelPrefix)}`.slice(0, 40);
  const memberKey = `b-member-${unique(labelPrefix)}`.slice(0, 40);
  const complete = (ruleId: string, name: string) => ({
    rule_id: ruleId,
    name,
    category: 'phenotype_detection',
    question: 'Is CD4 count elevated?',
    logic: { type: 'comparison', operator: '>', field: 'cd4_count', value: 500 },
    scoring: { outputFields: [{ key: 'value', type: 'number', description: 'Computed value.' }] },
  });
  return {
    name: unique(`AXI-2029 ${labelPrefix}`),
    version: '1.0.0',
    rules: [
      complete(anchorKey, 'AXI-2029 ruleset anchor'),
      complete(memberKey, 'AXI-2029 ruleset non-anchor member'),
    ],
  };
}

async function importAndActivate(admin: import('@playwright/test').APIRequestContext, labelPrefix: string): Promise<string[]> {
  const payload = rulesetPayload(labelPrefix);
  const importRes = await admin.post(apiUrl('/api/v1/admin/rulesets/import'), {
    multipart: {
      file: { name: 'ruleset.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) },
    },
  });
  expect(importRes.status(), await importRes.text()).toBe(201);
  const imported = await importRes.json();
  expect(imported.success, JSON.stringify(imported.validationReport)).toBe(true);
  const rulesetId = imported.ruleset.id as string;

  const activateRes = await admin.post(apiUrl(`/api/v1/admin/rulesets/${rulesetId}/activate`));
  expect(activateRes.status(), await activateRes.text()).toBe(200);

  const rulesRes = await send(admin, 'get', `/api/v1/admin/rulesets/${rulesetId}/rules?limit=50`);
  const ruleIds: string[] = (rulesRes.json.data as Array<{ ruleId: string }>).map((r) => r.ruleId);
  expect(ruleIds.length, `ruleset must materialize both members: ${JSON.stringify(rulesRes.json)}`).toBe(2);
  return [rulesetId, ...ruleIds] as unknown as string[];
}

/** Walks a freshly-activated member to `published` the same way AXI-1808's
 *  own §16.3.3 fork test does (submit-for-review + approve, same caller). */
async function publishMember(admin: import('@playwright/test').APIRequestContext, ruleId: string): Promise<void> {
  const detail = await send(admin, 'get', `/api/v1/rules/${ruleId}`);
  if (detail.json.status === 'draft') {
    // A draft member fails FR9 and can never reach review — this spec's own
    // fixture is complete, so this branch should never execute; guarded
    // loudly rather than silently skipped.
    throw new Error(`AXI-2029 ruleset fixture: member ${ruleId} is draft, not checked: ${JSON.stringify(detail.json)}`);
  }
  const submitted = await send(admin, 'post', `/api/v1/rules/${ruleId}/submit-for-review`);
  expect(submitted.status, `submit-for-review for ${ruleId}: ${JSON.stringify(submitted.json)}`).toBeLessThan(300);
  const inReview = await send(admin, 'get', `/api/v1/rules/${ruleId}`);
  const approved = await send(admin, 'post', `/api/v1/rules/${ruleId}/approve`, {
    justification: 'AXI-2029 e2e — serve this ruleset member for a multi-rule citation.',
    expectedContentHash: inReview.json.review.contentHash,
  });
  expect(approved.status, `approve for ${ruleId}: ${JSON.stringify(approved.json)}`).toBeLessThan(300);
  const published = await send(admin, 'get', `/api/v1/rules/${ruleId}`);
  expect(published.json.status, `member ${ruleId} must be published to be served: ${JSON.stringify(published.json)}`).toBe('published');
}

test.describe('AXI-2029 — a ruleset submission gates EVERY served member, not only its anchor', () => {
  test.describe.configure({ timeout: 180_000 });

  test(
    'AC7: a ruleset with a usable anchor and one family-withheld non-anchor member refuses the WHOLE submission, naming exactly that member @SI-017',
    async () => {
      const ingestApi: Api = await adminApi();
      const world = await RuleFamilyWorld.create();
      try {
        const [rulesetId, anchorId, memberId] = await importAndActivate(world.admin, 'nonanchor');
        await publishMember(world.admin, anchorId);
        await publishMember(world.admin, memberId);

        const orgId = await world.organization('ruleset-nonanchor');
        const workspaceId = await world.workspace('ruleset-nonanchor', orgId);
        const projectId = await world.project('ruleset-nonanchor', workspaceId);
        const tenant: Tenant = { orgId, workspaceId, headers: workspaceHeader(workspaceId) };
        const datasetId = await ingestFixture(ingestApi, tenant);

        const submitBody = () => ({
          rulesetId,
          runKind: 'QC',
          operationId: 'qc.rule_gate',
          workspaceId,
          projectId,
          datasetId,
        });

        // Baseline (AXI-2005's B1 lesson): both members unfamilied, the
        // whole ruleset citation is accepted BEFORE either is narrowed.
        const baseline = await send(world.admin, 'post', '/api/v1/rule-runs', submitBody());
        expect(baseline.status, `baseline ruleset submission must be accepted: ${JSON.stringify(baseline.json)}`).toBeLessThan(300);

        await world.withNarrowedRule(orgId, memberId, 'AXI-2029 Ruleset Non-Anchor Narrowing', async () => {
          const refused = await send(world.admin, 'post', '/api/v1/rule-runs', submitBody());
          expect(refused.status, JSON.stringify(refused.json)).toBe(400);
          const message = String(refused.json?.message ?? '');
          expect(message, JSON.stringify(refused.json)).toMatch(/^RULE_FAMILY_NOT_AUTHORIZED: /);
          // The anchor is NOT withheld (it was never narrowed) — only the
          // member is named; the refusal is total (the WHOLE citation is
          // refused) but the NAMING is precise to the actually-unusable one.
          expect(message, JSON.stringify(refused.json)).toContain(memberId);
          expect(message, JSON.stringify(refused.json)).not.toContain(anchorId);
        });

        // Restored: the SAME ruleset citation is accepted again once the
        // member's throwaway narrowing family is cleaned up.
        const restored = await send(world.admin, 'post', '/api/v1/rule-runs', submitBody());
        expect(restored.status, `restored ruleset submission must be accepted again: ${JSON.stringify(restored.json)}`).toBeLessThan(300);
      } finally {
        await world.dispose();
        await ingestApi.ctx.dispose();
      }
    },
  );
});

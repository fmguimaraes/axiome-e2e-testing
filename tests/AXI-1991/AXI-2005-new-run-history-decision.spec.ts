import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, ensureProject, findQcRuleId, ingestFixture, ensureDefaultAnalysis, pollRunTerminal, resolveMaterialisedRow } from '../AXI-1474/harness/seed';
import { RuleFamilyWorld, send, orgHeader, type Actor } from './harness/world';

/**
 * AXI-2005 (epic AXI-1991 — AC14; FR33-FR36; EC10, EC11, EC21).
 *
 * "New run / history / Decision" scenarios from
 * `axiome-docs/manual-e2e/AXI-1991-Rule-Families.md` §2.4.
 *
 * Reuses the KNOWN-GOOD seeded-rule + ingested-dataset pipeline from
 * `tests/AXI-1474/harness/seed.ts` (a cross-story-dir import, the established
 * convention this suite already uses — e.g. AXI-1482 imports it the same
 * way) rather than constructing a fresh ad-hoc QC rule whose runnability
 * this story has no way to verify without a live run. `IMM-QC-01` is a
 * boot-seeded SYSTEM rule exercised by several epics' specs.
 *
 * **Bounce #1 (B2) fix.** Filing `IMM-QC-01` into a family and only
 * soft-deleting the FAMILY does not undo the membership: `listFamilyIdsByRuleIds`
 * deliberately returns memberships pointing at soft-deleted families, and
 * `resolveAuthorizedFamilyIdsForProject` excludes soft-deleted families from
 * what is authorized — so the rule is left withheld in EVERY project on the
 * stack, not just this test's own, breaking every other suite that cites
 * `IMM-QC-01`. Both tests below now `removeMember` BEFORE `delete`-ing the
 * family, in a `finally` that runs even when the test body throws, and assert
 * the removal's own status — never swallowed. The two tests that mutate
 * `IMM-QC-01`'s membership (`'...a completed run stays readable...'` and
 * `'...a new Decision citing...'`) are pinned to the file's default serial
 * order (Playwright runs one file's tests in declaration order within a
 * worker) rather than marked `test.describe.configure({ mode: 'parallel' })`,
 * so the shared rule's membership is never touched by two tests at once.
 *
 * **A2 fix.** `citedRuleUsability` is asserted UNCONDITIONALLY now (the
 * field must be present once the cited rule is withheld — its absence would
 * itself be a defect, never a reason to skip the assertion).
 *
 * **Bounce #2 (B2a) fix.** A2's replacement "control" test submitted a QC run
 * against `datasetId` (ingested into `t.workspaceId`/its own project) but
 * targeted a DIFFERENT, freshly-minted private workspace/project from
 * `servedQcRule` that the dataset was never linked to — `execute()` refuses
 * for lack of a container analysis in THAT project (AXI-1482), a reason that
 * has nothing to do with rule families. Lead decision: deleted outright
 * rather than repaired, because its claim — "an unfamilied, served rule's
 * run is accepted" — is already covered twice without it: EC2 in
 * `AXI-2005-enforcement-pickers.spec.ts` (`offered[]` contains an unfamilied
 * served rule) and the FIRST submit below, step 1, made explicit as the
 * "unfamilied rule accepted" claim it always was.
 *
 * AUTHORED, NOT RUN — no stack was started for this story. The dataset
 * ingestion + run-to-terminal polling below is UNVERIFIED on a live stack by
 * this story; see the handback report's "first live run should watch for"
 * list.
 *
 * **Concurrency note (advisory, bounce #2).** While a test below holds
 * `IMM-QC-01` in its throwaway narrowing family, the rule is withheld in
 * EVERY project on the stack (B2's own finding) — this file must never run
 * concurrently with any OTHER suite citing `IMM-QC-01` as usable. Run with
 * `--workers=1` for the whole invocation, or run `tests/AXI-1991` on its own
 * (see the scenario doc's §3 "How to repeat the run").
 */
test.describe.configure({ timeout: 300_000, mode: 'serial' });

let api: Api;
let t: Awaited<ReturnType<typeof ensureTenant>>;
let ruleId: string;
let datasetId: string;
let world: RuleFamilyWorld;
let admin: Actor;

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  ruleId = await findQcRuleId(api, t);
  datasetId = await ingestFixture(api, t);
  world = await RuleFamilyWorld.create();
  admin = { userId: world.adminUserId, api: world.admin };
});

test.afterAll(async () => {
  await api?.ctx.dispose();
  await world.dispose();
});

function qcRunBody(projectId: string) {
  return { ruleId, runKind: 'QC', operationId: 'qc.rule_gate', projectId, workspaceId: t.workspaceId, datasetId };
}

/**
 * B2: narrow `IMM-QC-01` into a fresh, uniquely-named family for the
 * duration of `body`, then ALWAYS remove the membership (asserted) before
 * deleting the family — regardless of whether `body` throws.
 */
async function withNarrowedSharedRule<T>(label: string, body: (familyId: string) => Promise<T>): Promise<T> {
  const family = await world.createFamily(admin, t.orgId, 'organization', label);
  expect(family.id, `family create: ${JSON.stringify(family)}`).toBeTruthy();
  const added = await world.addMember(admin, t.orgId, family.id!, ruleId);
  expect(added.status, `add member: ${JSON.stringify(added.json)}`).toBeLessThan(300);
  try {
    return await body(family.id!);
  } finally {
    const removed = await world.removeMember(admin, t.orgId, family.id!, ruleId);
    expect(removed.status, `AXI-2005 cleanup: removing IMM-QC-01 from ${label} failed (${JSON.stringify(removed.json)}) — the shared rule may now be withheld stack-wide; see the recovery note in manual-e2e/AXI-1991-Rule-Families.md §3`).toBeLessThan(300);
    await send(admin.api, 'delete', `/api/v1/rule-families/${family.id}`, undefined, orgHeader(t.orgId));
  }
}

test(
  'AC14/FR33/FR34/FR35: a completed run stays readable after its rule becomes unusable, a new run is refused, history shows the indicator @SI-017 @SI-002',
  async () => {
    const projectId = await ensureProject(api, t, `AXI-2005 History ${Date.now()}`);
    const analysisId = await ensureDefaultAnalysis(api, t, projectId, datasetId);

    // 1. FR24 — IMM-QC-01 is still unfamilied here: the submit is accepted
    //    because there is no family for ANY gate to refuse it over (this IS
    //    the suite's "unfamilied rule is accepted" positive claim — B2a
    //    deleted the separate test that tried to assert this same thing
    //    through a differently-broken fixture; EC2 in
    //    AXI-2005-enforcement-pickers.spec.ts covers the picker-offering half).
    const firstSubmit = await api.post('/api/v1/rule-runs', qcRunBody(projectId), t.headers);
    expect(firstSubmit.status, `[step 1: unfamilied IMM-QC-01 submit must be accepted, FR24] ${JSON.stringify(firstSubmit.body)}`).toBeLessThan(300);
    const polled = await pollRunTerminal(api, t, firstSubmit.body.ruleRunId);
    expect(polled.status, `first QC run status: ${JSON.stringify(polled)}`).toMatch(/SUCCEEDED|DEDUPED/);
    const row = await resolveMaterialisedRow(api, t, polled);

    await withNarrowedSharedRule('AXI-2005 History Narrowing Family', async () => {
      // 2. FR33 — the existing run and its snapshot still open and reproduce.
      const historicalRun = await api.get(`/api/v1/rule-runs/${row.id}`, t.headers);
      expect(historicalRun.status).toBeLessThan(300);

      const snapshotAnalysisId: string = firstSubmit.body?.existingViewAnalysisId ?? analysisId;
      const snaps = await api.get(`/api/v1/view-analyses/${snapshotAnalysisId}/snapshots?page=1&limit=200`, t.headers);
      const list = Array.isArray(snaps.body) ? snaps.body : snaps.body.data ?? snaps.body._list ?? [];
      const derived = list.find((s: any) => s.origin === 'rule_derived' && s.ruleRunId === row.id);
      expect(derived, `no rule-derived snapshot found for run ${row.id}: ${JSON.stringify(list)}`).toBeTruthy();

      // FR36 — the snapshot additively marks its cited rule unusable here now,
      // with the FR30 reason, read by `RuleUnusableIndicator` on the front end
      // (`src/components/rules/RuleUnusableIndicator.tsx`, AXI-2019). Asserted
      // UNCONDITIONALLY (A2): once the cited rule is withheld, the field's
      // presence is the claim under test, not an optional extra.
      expect(derived.citedRuleUsability, `citedRuleUsability must be present on a snapshot whose rule is now withheld: ${JSON.stringify(derived)}`).toBeTruthy();
      expect(derived.citedRuleUsability.usable).toBe(false);
      expect(derived.citedRuleUsability.reasonCode).toBe('family_not_authorized');

      // 3. FR34 — a NEW run citing the now-unusable rule is refused.
      const secondSubmit = await api.post('/api/v1/rule-runs', qcRunBody(projectId), t.headers);
      expect(secondSubmit.status).toBe(400);
      expect(String(secondSubmit.body?.message ?? '')).toMatch(/^RULE_FAMILY_NOT_AUTHORIZED: /);

      // 4. FR35 — preflight refuses the same way, reported as a typed BLOCK.
      const preflight = await api.post('/api/v1/rule-runs/preflight', qcRunBody(projectId), t.headers);
      expect(preflight.status).toBeLessThan(300);
      const blocks = preflight.body?.blocks ?? [];
      expect(blocks.some((b: any) => b.id === 'RULE_FAMILY_NOT_AUTHORIZED')).toBe(true);
    });
  },
);

test(
  'AC14: creating a new Decision citing a now-unusable rule\'s snapshot is refused with the same reason @SI-017',
  async () => {
    const projectId = await ensureProject(api, t, `AXI-2005 Decision ${Date.now()}`);
    const analysisId = await ensureDefaultAnalysis(api, t, projectId, datasetId);
    const submit = await api.post('/api/v1/rule-runs', qcRunBody(projectId), t.headers);
    expect(submit.status).toBeLessThan(300);
    const polled = await pollRunTerminal(api, t, submit.body.ruleRunId);
    const row = await resolveMaterialisedRow(api, t, polled);
    const snapshotAnalysisId: string = submit.body?.existingViewAnalysisId ?? analysisId;
    const snaps = await api.get(`/api/v1/view-analyses/${snapshotAnalysisId}/snapshots?page=1&limit=200`, t.headers);
    const list = Array.isArray(snaps.body) ? snaps.body : snaps.body.data ?? snaps.body._list ?? [];
    const derived = list.find((s: any) => s.origin === 'rule_derived' && s.ruleRunId === row.id);
    expect(derived).toBeTruthy();

    await withNarrowedSharedRule('AXI-2005 Decision Narrowing Family', async () => {
      const createDraft = await api.post(
        `/api/v1/workspaces/${t.workspaceId}/decisions`,
        {
          label: 'AXI-2005 decision refusal fixture',
          type: 'biomarker_threshold',
          projectId,
          context: { intendedUse: 'AXI-2005 E2E fixture' },
          evidenceLinks: [],
          evidenceValues: [{ metric: 'axi_2005_e2e', value: 1, unit: 'count', sourceSnapshotId: derived.id }],
        },
        t.headers,
      );
      expect(createDraft.status).toBe(400);
      expect(String(createDraft.body?.message ?? '')).toMatch(/^RULE_FAMILY_NOT_AUTHORIZED: /);
    });
  },
);

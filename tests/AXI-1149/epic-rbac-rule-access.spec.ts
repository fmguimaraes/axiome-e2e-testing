import { test, expect } from './harness/rbac';
import { expectIndistinguishableFromMiss, expectStatus } from './harness/assertions';
import { API, randomUuid, type Topology } from './harness/tenancy';
import type { Principal } from './harness/tenancy';
import type { Rbac } from './harness/rbac';

/**
 * AXI-1149 — Workflow 5 API-level probes, rule-access RBAC side (AXI-1290):
 * §5.19 AC21 AC22 AC23 AC24 AC25 (AC26 is left manual — see the note below).
 *
 * One user per role state (none / rules / shared) because the gateway caches a
 * caller's resolved rule permissions for 60s with no invalidation. The dedicated
 * org `ORG_R` is toggled ALL/NONE; the describe is serial and every toggle is
 * restored in `finally`, so no test leaves the org revoked.
 *
 * AC26 (ruleset-materialized system rule is gated like any system rule) stays
 * manual: the demo library holds NO ruleset-materialized system rule
 * (`GET /admin/rulesets` is empty), and minting one means importing AND
 * activating a platform-wide ruleset on the shared demo DB — a global side
 * effect that this suite must not have and that cannot be undone over the API.
 */
test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

type Rule = { id: string; scope?: string };
const listRules = async (rbac: Rbac, who: Principal, qs = 'limit=100'): Promise<{ rows: Rule[]; total: number }> => {
  const body = await expectStatus(await who.ctx.get(`${API}/rules?${qs}`, { headers: rbac.h }), 200);
  return { rows: body.data as Rule[], total: body.meta.total as number };
};
const runIds = async (rbac: Rbac, who: Principal, ruleId: string): Promise<string[]> => {
  const body = await expectStatus(await who.ctx.get(`${API}/rule-runs?ruleId=${ruleId}&limit=100`, { headers: rbac.h }), 200);
  return (body.ruleRuns as { id: string }[]).map((r) => r.id);
};
const execProbe = (rbac: Rbac, who: Principal) => (ruleId: string) => rbac.execQc(who, ruleId);

test.describe('AXI-1149 rule-access RBAC (AXI-1290)', () => {
  test('AC21 §5.19 — a caller whose role carries no rule:* permission is denied workspace/project rules despite membership', async ({ rbac }) => {
    const { uNone, RULE_WS } = rbac;
    // control: the rule exists, is published, and IS visible to a role that carries rule:read
    const seen = await listRules(rbac, rbac.uRules, `limit=100&search=${encodeURIComponent('IMM-QC-01')}`);
    expect(seen.rows.some((r) => r.id === RULE_WS), 'control: role-rules sees the project rule').toBe(true);

    const all = await listRules(rbac, uNone);
    expect(all.rows.filter((r) => r.scope !== 'system'), 'no non-system rule listed').toEqual([]);
    expect(all.rows.some((r) => r.id === RULE_WS)).toBe(false);
    expect(all.total, 'deny-by-default lists nothing at all (empty visibility where)').toBe(0);

    // execute is a 404 byte-identical to a genuine miss, even though uNone is a workspace member
    await expectIndistinguishableFromMiss(RULE_WS, execProbe(rbac, uNone));
  });

  test('AC22 §5.19 — rule:read + rule:evaluate together with membership list AND execute the project rule', async ({ rbac }) => {
    const { uRules, RULE_WS } = rbac;
    const all = await listRules(rbac, uRules);
    expect(all.rows.some((r) => r.id === RULE_WS), 'project rule appears in the list').toBe(true);
    const res = await rbac.execQc(uRules, RULE_WS);
    const body = await expectStatus(res, 201);
    expect(body.status).toBe('QUEUED');
    expect(body.ruleRunId).toBeTruthy();
    // and the run is readable by its caller
    await expectStatus(await uRules.ctx.get(`${API}/rule-runs/${body.ruleRunId}`, { headers: rbac.h }), 200);
  });

  test('AC23 §5.19 — without rule:view_shared a system rule is denied on list and execute although the org is entitled ALL', async ({ rbac }) => {
    const { uRules, uShared, RULE_SYS } = rbac;
    await rbac.setMode('ALL');
    const sys = await listRules(rbac, uRules, 'scope=system&limit=100');
    expect(sys.rows.some((r) => r.id === RULE_SYS)).toBe(false);
    expect(sys.total, 'not one system rule visible without rule:view_shared').toBe(0);
    await expectIndistinguishableFromMiss(RULE_SYS, execProbe(rbac, uRules));
    // positive control: the same org + the same rule IS reachable for role-shared
    const ctl = await listRules(rbac, uShared, 'scope=system&search=IMM-QC-01&limit=100');
    expect(ctl.rows.some((r) => r.id === RULE_SYS), 'control: role-shared sees it').toBe(true);
  });

  test('AC24 §5.19 — an org whose OrgRuleAccess is NONE is denied listing and execution, derived from server-side membership', async ({ rbac, topo }: { rbac: Rbac; topo: Topology }) => {
    const { uShared, RULE_SYS } = rbac;
    try {
      await rbac.setMode('NONE');
      // no organizationId in the caller's own request; then a client-supplied one naming an ENTITLED org must not matter
      for (const qs of ['scope=system&limit=100', `scope=system&limit=100&organizationId=${topo.ORG_B}`, `scope=system&limit=100&organizationId=${randomUuid()}`]) {
        const sys = await listRules(rbac, uShared, qs);
        expect(sys.rows.some((r) => r.id === RULE_SYS), `omitted for ${qs}`).toBe(false);
        expect(sys.total, `no system rule at all for ${qs}`).toBe(0);
      }
      await expectIndistinguishableFromMiss(RULE_SYS, execProbe(rbac, uShared));
      const spoof = await rbac.execQc(uShared, RULE_SYS, { organizationId: topo.ORG_B });
      // the gateway may refuse the foreign organizationId outright (403) before the rule lookup (404); either way it is DENIED
      expect([403, 404], `a client-supplied organizationId is not an entitlement: ${await spoof.text()}`).toContain(spoof.status());
    } finally {
      await rbac.setMode('ALL');
    }
    // entitlement restored => visible again (the toggle, not some other state, was the cause)
    const back = await listRules(rbac, uShared, 'scope=system&search=IMM-QC-01&limit=100');
    expect(back.rows.some((r) => r.id === RULE_SYS)).toBe(true);
  });

  test('AC25 §5.19 — revoking the grant retains prior runs but hides them on list/get/results/table and denies future executions', async ({ rbac }) => {
    const { uShared, radm, RULE_SYS } = rbac;
    await rbac.setMode('ALL');
    const submit = await expectStatus(await rbac.execQc(uShared, RULE_SYS), 201);
    const RUN = submit.ruleRunId as string;
    expect(submit.status, 'first run of this rule over this dataset is queued, not deduped').toBe('QUEUED');

    // visible while entitled
    expect(await runIds(rbac, uShared, RULE_SYS)).toContain(RUN);
    await expectStatus(await uShared.ctx.get(`${API}/rule-runs/${RUN}`, { headers: rbac.h }), 200);
    await expectStatus(await uShared.ctx.get(`${API}/rule-runs/${RUN}/results`, { headers: rbac.h }), 200);

    try {
      await rbac.setMode('NONE');
      expect(await runIds(rbac, uShared, RULE_SYS), 'list omits the prior run').not.toContain(RUN);
      await expectIndistinguishableFromMiss(RUN, (id) => uShared.ctx.get(`${API}/rule-runs/${id}`, { headers: rbac.h }));
      await expectIndistinguishableFromMiss(RUN, (id) => uShared.ctx.get(`${API}/rule-runs/${id}/results`, { headers: rbac.h }));
      await expectIndistinguishableFromMiss(RUN, (id) => uShared.ctx.get(`${API}/rule-runs/${id}/table`, { headers: rbac.h }));
      // future executions denied
      await expectIndistinguishableFromMiss(RULE_SYS, execProbe(rbac, uShared));
      // append-only: the row is retained — a platform ADMIN is never subject to the hiding filter
      const kept = await expectStatus(await radm.ctx.get(`${API}/rule-runs/${RUN}`), 200);
      expect(kept.id).toBe(RUN);
    } finally {
      await rbac.setMode('ALL');
    }
    // and the hiding was purely a function of entitlement: restored => visible again
    await expectStatus(await uShared.ctx.get(`${API}/rule-runs/${RUN}`, { headers: rbac.h }), 200);
  });
});

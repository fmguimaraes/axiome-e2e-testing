import { test, expect } from '../AXI-1149/harness/fixtures';
import { API, wsHeader, randomUuid } from '../AXI-1149/harness/tenancy';
import { expectStatus } from '../AXI-1149/harness/assertions';

/**
 * AXI-2051 (epic AXI-1913) — `POST /v1/rule-runs/:id/re-execute`'s `projectId`
 * now carries its OWN caller-workspace-membership check
 * (`RuleRunScopeAuthorizerService.authorizeProjectMembership`), closing the
 * AXI-2044 review's advisory finding that it was validated only against the
 * referent dataset (`assertProjectLinkedToReferentDatasetOrRefuse`), never
 * against the CALLER's own membership.
 *
 * Source of truth: axiome-docs/manual-e2e/AXI-1913-Bioinformatics-Method-Validation.md
 * (AXI-2051 section). Reuses the AXI-1149 two-tenant API harness rather than
 * duplicating it — this story is a narrower instance of the same
 * cross-tenant-probe shape that epic already automates.
 *
 * `authorizeProjectMembership` runs BEFORE the controller ever looks at the
 * `:id` path parameter or dispatches to the organization service, so these
 * probes deliberately use run ids that do not need to resolve to a real
 * SUCCEEDED STATISTICAL run — a random uuid is enough to prove the ORDER
 * of the checks: a project-scope denial must come back as `Project not
 * found` (never reaching the run lookup), while a legitimate project must
 * progress past that check to the run-lookup 404 (`RuleRun ... not found`),
 * never `Project not found`.
 *
 * The AXI-2044 cross-tenant-REPLAY regression (the snapshot/workspaceId half
 * of this route) is covered by the gateway unit suite
 * (`UT-GW-RR-2044-001/002`, `UT-GW-RR-2051-004`), not repeated here — it
 * needs no live rule run either, and a real one would require a full
 * bio-compute round trip this narrow follow-up does not warrant.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('AXI-2051 re-execute projectId caller-workspace scope', () => {
  test('AC1 — a projectId outside the caller\'s workspace membership is refused before the run is even looked up', async ({
    topo,
  }) => {
    const { alice, WS_A, PROJ_B } = topo;
    const runId = randomUuid(); // never resolves — the project check must fire first
    const res = await alice.ctx.post(`${API}/rule-runs/${runId}/re-execute`, {
      data: { projectId: PROJ_B },
      headers: wsHeader(WS_A),
    });
    const body = await expectStatus(res, 404);
    const message = Array.isArray(body.message) ? body.message.join(' ') : String(body.message);
    expect(message).toContain('Project not found');
    expect(message).not.toContain('RuleRun');
  });

  test('AC2 — the caller\'s OWN project is accepted and the request reaches the run lookup (regression)', async ({
    topo,
  }) => {
    const { alice, WS_A, PROJ_A } = topo;
    const runId = randomUuid(); // a genuine miss once the project check passes
    const res = await alice.ctx.post(`${API}/rule-runs/${runId}/re-execute`, {
      data: { projectId: PROJ_A },
      headers: wsHeader(WS_A),
    });
    const body = await expectStatus(res, 404);
    const message = Array.isArray(body.message) ? body.message.join(' ') : String(body.message);
    expect(message).not.toContain('Project not found');
    expect(message).toContain('RuleRun');
  });
});

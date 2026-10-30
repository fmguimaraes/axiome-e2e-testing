import type { Api } from '../../AXI-1400/harness/api';
import type { Tenant } from '../../AXI-1400/harness/seed';

/**
 * AXI-2330 (epic AXI-2308 — FR31/AC24/EC16/NFR8; RO13). Thin wrapper over the
 * one new route this story adds — `PATCH /dataviews/:specId/chart-style` —
 * kept out of the `.spec.ts` file only because every other harness file in
 * this directory does the same for its own route (`actor-api.ts`), not
 * because of anything the spec-linter forbids here.
 */
export function setChartStyle(
  api: Api,
  t: Tenant,
  specId: string,
  overrides: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return api.patch(`/api/v1/workspaces/${t.workspaceId}/dataviews/${specId}/chart-style`, overrides, t.headers);
}

/** Every rule-run id in the workspace — used to prove a style change creates no new run row (EC16). */
export async function ruleRunIdsOfWorkspace(api: Api, t: Tenant): Promise<string[]> {
  const res = await api.get(`/api/v1/rule-runs?workspaceId=${t.workspaceId}&limit=200`, t.headers);
  const rows: Array<{ id: string }> = res.body?.ruleRuns ?? [];
  return rows.map((r) => r.id);
}

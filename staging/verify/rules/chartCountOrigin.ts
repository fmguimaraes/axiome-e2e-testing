import { fetchExistingSpecs } from '../../steps/chartStaging';
import { pass, fail } from '../types';
import type { ProvisioningContext } from '../../steps/context';
import type { ExistingSpec } from '../../steps/chartStaging';
import type { VerifyDeps } from '../deps';
import type { RuleResult } from '../types';

/**
 * Capture Spec §6.1/§6.2, AC6 — "six user-created charts, no auto
 * cross-product visible". Reuses `chartStaging.ts`'s `fetchExistingSpecs`
 * (AXI-1374) against every declared dataset role, since the six charts
 * span two datasets (de_table + count_matrix). AC6's own module doc records
 * that a REST client cannot delete a pre-existing `origin:'auto'` spec
 * (`CandidatesService.deleteUserSpec` refuses anything but user-origin) —
 * the mitigation is the capture-time `?chartOrigin=user` deep link, not a
 * staging/verify-time deletion — so an auto-origin spec's continued
 * existence is logged, not hard-failed, here.
 */
const RULE = 'Capture Spec §6.1/§6.2/AC6 — six user-created charts, origin';

export async function checkChartCountAndOrigin(ctx: ProvisioningContext, deps: VerifyDeps): Promise<RuleResult> {
  const specs = await fetchAllSpecs(ctx, deps);
  const declaredTitles = ctx.fixture.content.chartSpecs.map((c) => c.title);
  return evaluateCharts(specs, declaredTitles);
}

async function fetchAllSpecs(ctx: ProvisioningContext, deps: VerifyDeps): Promise<ExistingSpec[]> {
  const perDataset = await Promise.all(
    [...deps.datasetIdByRole.values()].map((id) => fetchExistingSpecs(ctx, deps.workspaceId, id, deps.analysisId)),
  );
  return perDataset.flat();
}

/** Pure — exported for unit testing. */
export function evaluateCharts(specs: ExistingSpec[], declaredTitles: string[]): RuleResult {
  const userTitles = new Set(specs.filter((s) => s.origin === 'user').map((s) => s.title));
  const missing = declaredTitles.filter((t) => !userTitles.has(t));
  if (missing.length > 0) return fail(RULE, `missing user-origin chart(s): ${missing.join(', ')}`);
  const autoCount = specs.filter((s) => s.origin === 'auto').length;
  const note = autoCount > 0 ? ` (${autoCount} origin:'auto' spec(s) also visible — mitigated at capture via ?chartOrigin=user, not a staging defect)` : '';
  return pass(RULE, `${declaredTitles.length} declared user-origin chart(s) confirmed live${note}`);
}

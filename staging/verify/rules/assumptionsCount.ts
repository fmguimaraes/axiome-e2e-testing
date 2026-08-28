import { SERVICE_HANDLE } from '../../steps/context';
import { projectHeaders } from '../../steps/projectProvisioning';
import { pass, fail } from '../types';
import type { ProvisioningContext } from '../../steps/context';
import type { VerifyDeps } from '../deps';
import type { RuleResult } from '../types';

/**
 * Capture Spec §5/AC8 — "Chip should read 4 after staging" amended by FR9's
 * truth guard: the 4th (threshold-provenance) assumption is correctly
 * withheld while `THRESHOLD_DECLARED_BEFORE_CONTRAST` is false
 * (`analysisFraming.ts`), so the live, correct chip count for THIS demo is
 * exactly 3, not 4 — asserting 3 is what makes this a truth check rather
 * than a spec-literalism check that would fail an honest tenant.
 */
const RULE = 'Capture Spec §5/AC8 — assumptions chip reads exactly 3';

interface AssumptionResponse {
  status: string;
}

interface FramingPayload {
  assumptions: AssumptionResponse[];
}

export async function checkAssumptionsCount(ctx: ProvisioningContext, deps: VerifyDeps): Promise<RuleResult> {
  const res = await ctx.client.as<FramingPayload>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/${deps.analysisId}/framing`, undefined, projectHeaders(deps.workspaceId));
  if (!res.ok || !res.body) return fail(RULE, `GET framing failed (status ${res.status})`);
  return evaluateAssumptions(res.body.assumptions);
}

/** Pure — exported for unit testing. */
export function evaluateAssumptions(assumptions: AssumptionResponse[]): RuleResult {
  const active = assumptions.filter((a) => a.status === 'active').length;
  if (active !== 3) return fail(RULE, `${active} active assumption(s) live, expected exactly 3`);
  return pass(RULE, '3 active assumptions confirmed (4th correctly withheld per FR9)');
}

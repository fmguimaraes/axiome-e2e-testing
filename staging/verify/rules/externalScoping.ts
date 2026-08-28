import { buildScopingProbes, evaluateProbe, summarizeScoping } from '../../steps/externalScopingVerification';
import { pass, fail } from '../types';
import type { ScopingProbe, ScopingProbeResult } from '../../steps/externalScopingVerification';
import type { ProvisioningContext } from '../../steps/context';
import type { VerifyDeps } from '../deps';
import type { RuleResult } from '../types';

/**
 * Capture Spec §21/AC12/EC5/EC6 — external-scope isolation. Reuses
 * `externalScopingVerification.ts`'s exported, pure probe-construction and
 * classification (`buildScopingProbes`/`evaluateProbe`/`summarizeScoping`,
 * AXI-1378) rather than re-deriving the probe list — that module's own doc
 * says AXI-1380/1381 should reuse these probes. This wraps them as a
 * RuleResult instead of the step's own `assertScopingCorrect` (which
 * throws), so a scoping leak reports alongside every other rule instead of
 * aborting the whole `verify` run before later rules get a chance to run.
 */
const RULE = 'Capture Spec §21/AC12/EC5/EC6 — external-scope isolation';
const EXTERNAL_HANDLE = 'external-stakeholder';

export async function checkExternalScoping(ctx: ProvisioningContext, deps: VerifyDeps): Promise<RuleResult> {
  const probes = buildScopingProbes(deps.workspaceId, deps.projectId, deps.analysisId);
  const results = await runProbes(ctx, probes);
  const finding = summarizeScoping(results);
  if (!finding.genuineScoping) return fail(RULE, describeFailure(finding.leaks, finding.blockedFromPublished, finding.errors));
  return pass(RULE, `${results.length} probe(s): genuine scoping confirmed (hiding, not disabling)`);
}

async function runProbes(ctx: ProvisioningContext, probes: ScopingProbe[]): Promise<ScopingProbeResult[]> {
  const results: ScopingProbeResult[] = [];
  for (const probe of probes) {
    const res = await ctx.client.as(EXTERNAL_HANDLE, 'GET', probe.path, undefined, probe.extraHeaders);
    results.push(evaluateProbe(probe, res.status));
  }
  return results;
}

/** Pure — exported for unit testing. */
export function describeFailure(leaks: ScopingProbeResult[], blocked: ScopingProbeResult[], errors: ScopingProbeResult[]): string {
  const parts = [
    leaks.length > 0 ? `LEAK: ${leaks.map((r) => r.label).join(', ')}` : '',
    blocked.length > 0 ? `blocked-from-published: ${blocked.map((r) => r.label).join(', ')}` : '',
    errors.length > 0 ? `errors: ${errors.map((r) => r.label).join(', ')}` : '',
  ];
  return parts.filter(Boolean).join('; ');
}

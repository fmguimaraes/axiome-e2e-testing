import { checkDatasetsShareCorpus } from '../../fixtures/validateFixture';
import { projectHeaders } from '../../steps/projectProvisioning';
import { SERVICE_HANDLE } from '../../steps/context';
import { pass, fail } from '../types';
import type { ProvisioningContext } from '../../steps/context';
import type { DatasetFixture } from '../../fixtures/types';
import type { VerifyDeps } from '../deps';
import type { RuleResult } from '../types';

/**
 * Capture Spec §2.2/AC5 — "one corpus, everywhere": every declared dataset
 * shares the same workspace/project (reuses `checkDatasetsShareCorpus`,
 * AXI-1371), every declared dataset role is actually live/ingested, and the
 * primary DE table's own rows carry real gene symbols, not `GENE00001`
 * placeholders — the exact defect Capture Spec §2.2 names.
 */
const RULE = 'Capture Spec §2.2/AC5 — one corpus, real gene symbols';
const PLACEHOLDER_GENE_RE = /^GENE\d+$/i;

export async function checkCorpusConsistency(ctx: ProvisioningContext, deps: VerifyDeps): Promise<RuleResult> {
  const shareViolations = checkDatasetsShareCorpus(ctx.fixture);
  if (shareViolations.length > 0) return fail(RULE, shareViolations.map((v) => v.detail).join('; '));
  const missing = findMissingLiveDatasets(ctx.fixture.content.datasets, deps.datasetIdByRole);
  if (missing.length > 0) return fail(RULE, `declared dataset role(s) not live/available: ${missing.join(', ')}`);
  const rows = await fetchSampleGeneRows(ctx, deps);
  const placeholder = findPlaceholderGene(rows);
  if (placeholder) return fail(RULE, `placeholder gene identifier found in the de_table dataset: "${placeholder}"`);
  return pass(RULE, `${ctx.fixture.content.datasets.length} dataset(s) share one corpus, all live, real gene symbols confirmed`);
}

/** Pure — exported for unit testing. */
export function findMissingLiveDatasets(datasets: DatasetFixture[], byRole: Map<string, string>): string[] {
  return datasets.filter((d) => !byRole.has(d.role)).map((d) => d.role);
}

/** Pure — exported for unit testing. Returns the first placeholder gene
 *  identifier found, or undefined if every row carries a real symbol. */
export function findPlaceholderGene(rows: { gene: unknown }[]): string | undefined {
  const hit = rows.find((r) => PLACEHOLDER_GENE_RE.test(String(r.gene)));
  return hit ? String(hit.gene) : undefined;
}

async function fetchSampleGeneRows(ctx: ProvisioningContext, deps: VerifyDeps): Promise<{ gene: unknown }[]> {
  const body = { filters: [], sort: { column: 'padj', direction: 'asc' }, limit: 5, offset: 0 };
  const res = await ctx.client.as<{ rows: { gene: unknown }[] }>(
    SERVICE_HANDLE,
    'POST',
    `/api/v1/workspaces/${deps.workspaceId}/datasets/${deps.deTableDatasetId}/query`,
    body,
    projectHeaders(deps.workspaceId),
  );
  if (!res.ok || !res.body) throw new Error(`querying de_table sample rows failed (status ${res.status})`);
  return res.body.rows;
}

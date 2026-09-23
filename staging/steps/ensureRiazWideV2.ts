import { ensureIdentities } from '../identities/ensureIdentities';
import { RestClient } from '../client/RestClient';
import { SERVICE_HANDLE } from './context';
import { ensureDatasetStep, findExistingDataset } from './datasetIngestion';
import { projectHeaders } from './projectProvisioning';
import { PROJECT, RIAZ_WIDE_V2_DATASET, WORKSPACE, riazFixture } from './stageRiaz';
import type { ProvisioningContext } from './context';

/**
 * AXI-1586 — idempotently ingests + links `RIAZ_WIDE_V2_DATASET` (see its
 * doc comment in `stageRiaz.ts`) into the Riaz 2017 project. This is what
 * `stage:riaz` runs (the dataset is folded into `riazFixture().content.
 * datasets`); `stage:riaz-publish` never calls it — it only resolves the
 * already-ingested dataset by filename (`resolveUserChartDatasetIds` in
 * `publishRiazEvidence.ts`) for any `userCharts[]` plan naming the `WIDE`
 * handle (`riazUserCharts.ts`'s `UserChartDatasetHandle`). Also runnable
 * standalone for a first ingest / verification. A second run reuses the
 * existing dataset (NFR1), same pattern as `stageRiazGuided.ensureDataset`.
 */
export async function ensureWideV2Dataset(client: RestClient, serviceUserId: string, workspaceId: string, organizationId: string | null): Promise<string> {
  const fixture = { ...riazFixture(), content: { ...riazFixture().content, datasets: [RIAZ_WIDE_V2_DATASET] } };
  const ctx: ProvisioningContext = { client, fixture, serviceUserId, orgId: organizationId ?? undefined, workspaceIdByFixtureName: new Map([[WORKSPACE, workspaceId]]), touched: [] };
  await ensureDatasetStep.run(ctx);
  const ds = await findExistingDataset(ctx, workspaceId, RIAZ_WIDE_V2_DATASET.originalFilename);
  if (!ds) throw new Error('WIDE v2 dataset vanished after ingestion');
  ctx.touched.forEach((t) => console.log(`[ensure-riaz-wide-v2] ${t.action} ${t.kind} "${t.name}" (${t.id})`));
  return ds.id;
}

async function main(): Promise<void> {
  const baseUrl = (process.env.STAGING_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  const client = new RestClient({ baseUrl });
  await ensureIdentities(client, process.env.STAGING_ADMIN_EMAIL?.trim() || 'admin@axiome.local', process.env.STAGING_ADMIN_PASSWORD?.trim() || 'admin');
  const serviceUserId = (await client.as<{ id: string }>(SERVICE_HANDLE, 'GET', '/api/v1/auth/me')).body!.id;
  // resolve workspace/org from an existing dataset in the project (WORKSPACE constant names it; org is stamped on any dataset row)
  const wsList = await client.as<{ data: Array<{ id: string; name: string }> }>(SERVICE_HANDLE, 'GET', '/api/v1/workspaces?limit=100');
  const ws = (wsList.body?.data ?? []).find((w) => w.name === WORKSPACE);
  if (!ws) throw new Error(`workspace "${WORKSPACE}" not found — run stage:riaz first`);
  const anyDataset = await client.as<{ data: Array<{ organizationId: string | null }> }>(SERVICE_HANDLE, 'GET', `/api/v1/workspaces/${ws.id}/datasets?limit=1`, undefined, projectHeaders(ws.id));
  const orgId = anyDataset.body?.data?.[0]?.organizationId ?? null;
  const datasetId = await ensureWideV2Dataset(client, serviceUserId, ws.id, orgId);
  console.log(`PASSED — WIDE v2 dataset ${datasetId} ready in project "${PROJECT}"`);
}

if (process.argv[1] && process.argv[1].endsWith('ensureRiazWideV2.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

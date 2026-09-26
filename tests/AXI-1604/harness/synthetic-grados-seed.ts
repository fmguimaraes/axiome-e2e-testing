import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api } from '../../AXI-1435/harness/api';
import { asList, workspaceHeader } from '../../AXI-1435/harness/api';
import { ensureTenant, ingestFixture, type Tenant } from '../../AXI-1435/harness/seed';
import { SYNTHETIC_GRADOS_CSV_FILENAME } from '../fixtures/synthetic-grados-schema';

/**
 * AXI-1677 (epic AXI-1604 — FR28/FR29/FR30, @SI-042). Seeds the synthetic
 * Grados-shaped dataset and hands back the tenant + dataset id a gate run needs.
 *
 * ═══ THE SEEDED DATA IS SYNTHETIC ═══ `synthetic-grados-cohort.csv` carries the
 * column schema FR29 declared (`GRADOS_DATASET`) and fixed-seed PRNG values. No
 * cohort-level Grados dataset exists anywhere; the paper published summary
 * tables only. It exists so the compiled planner can be MEASURED on questions
 * that have a matching column. It is not evidence about IgG4-RD. Full provenance
 * statement: `../fixtures/generate-synthetic-grados-cohort.ts`.
 *
 * WHY THIS IS A SHARED HARNESS AND NOT SPEC-LOCAL. The FR30 gate run
 * (`tests/AXI-1462/AXI-1614-compiled-planner-shadow-run.spec.ts`) needs exactly
 * this dataset in exactly this workspace, and AXI-1662's whole lesson is that a
 * second hand-synced copy of a resolution path is how a paid evaluation run gets
 * lost. One seeder, one import path.
 *
 * WHY `ensureTenant()` IS NOT ENOUGH ON ITS OWN (finding, 2026-09-25). On the
 * shared demo stack `ensureTenant()` resolves the long-lived workspace "AXI-1435
 * Statistical Trigger Surface", which the E2E admin (`admin@axiome.local`) is
 * NOT a member of — it was created by another user in an earlier run. Its DETAIL
 * route answers 200, but every workspace-SCOPED route
 * (`/workspaces/:id/datasets`, `/projects?workspaceId=`) answers
 * `404 Workspace not found`, so nothing can be seeded, listed or anchored there.
 * That is why the AXI-1614 spec has always skipped on its default path. It is a
 * pre-existing tenancy/membership condition in the AXI-1435 seed, NOT something
 * this story invented or fixed — see this story's hand-back. Setting
 * `SHADOW_RUN_WORKSPACE_ID` to a workspace the caller is a member of is the
 * supported way past it, and is what the 2026-09-25 run already did.
 */

/** The project this seeder creates (or reuses) when it is given only a workspace. */
export const SYNTHETIC_GRADOS_PROJECT_NAME = 'AXI-1604 Compiled Planner Gate';

export interface SyntheticGradosSeed {
  readonly tenant: Tenant;
  /** The ingested, project-linked synthetic dataset. Pass as `SHADOW_RUN_DATASET_ID`. */
  readonly datasetId: string;
}

/** `tests/AXI-1604/fixtures` — where the synthetic CSV and its generator live. */
export const SYNTHETIC_GRADOS_FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-1604', 'fixtures');

/**
 * Seed the synthetic dataset, idempotently, and return where it landed.
 *
 * The ingestion path is the ORDINARY one — presigned upload, finalize, wait for
 * `ready`, link to the project (`ingestFixture`). A seed that went in through a
 * side door would prove nothing about what the planner will be shown.
 */
export async function seedSyntheticGrados(api: Api): Promise<SyntheticGradosSeed> {
  const tenant = await resolveTenant(api);
  const { filename, dir } = stageableFixture();
  const datasetId = await ingestFixture(api, tenant, filename, dir);
  return { tenant, datasetId };
}

/**
 * AXI-1700 (epic AXI-1687 - FR57): the filename a re-stage uploads under is CONTENT-ADDRESSED
 * (`synthetic-grados-cohort-<first 12 hex of sha256>.csv`).
 *
 * `ingestFixture` reuses an existing dataset BY ORIGINAL FILENAME, so a regenerated CSV staged
 * under the fixed name would silently keep serving the OLD numbers (a stale dataset under the
 * new file's name) - the opposite of a re-stage. Naming the upload by its content makes changed
 * bytes a NEW dataset (a new version hash) and identical bytes idempotent, and never overwrites
 * or renames the dataset the demo narratives and screenshots already use.
 */
export function stagedFixtureFilename(bytes: Uint8Array): string {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  return SYNTHETIC_GRADOS_CSV_FILENAME.replace(/\.csv$/, `-${digest}.csv`);
}

function stageableFixture(): { filename: string; dir: string } {
  const source = join(SYNTHETIC_GRADOS_FIXTURES_DIR, SYNTHETIC_GRADOS_CSV_FILENAME);
  const filename = stagedFixtureFilename(readFileSync(source));
  const dir = mkdtempSync(join(tmpdir(), 'axi-1700-stage-'));
  copyFileSync(source, join(dir, filename));
  return { filename, dir };
}

/**
 * Where to seed. `SHADOW_RUN_WORKSPACE_ID` (and optionally
 * `SHADOW_RUN_PROJECT_ID`) — the overrides every other spec in this epic already
 * honours — win; otherwise `ensureTenant()`, unchanged.
 */
async function resolveTenant(api: Api): Promise<Tenant> {
  const workspaceId = process.env.SHADOW_RUN_WORKSPACE_ID;
  if (!workspaceId) return ensureTenant(api);
  const headers = workspaceHeader(workspaceId);
  const orgId = await ownerOrganizationId(api, workspaceId, headers);
  const projectId = process.env.SHADOW_RUN_PROJECT_ID
    ?? (await ensureGateProject(api, workspaceId, headers));
  return { orgId, workspaceId, projectId, ruleIds: {}, headers };
}

/** The workspace's owning organization — the dataset init call requires it. */
async function ownerOrganizationId(
  api: Api,
  workspaceId: string,
  headers: Record<string, string>,
): Promise<string> {
  const res = await api.get(`/api/v1/workspaces/${workspaceId}`, headers);
  const orgId = res.body?.ownerOrganizationId;
  if (res.status >= 300 || typeof orgId !== 'string') {
    throw new Error(
      `seedSyntheticGrados: workspace ${workspaceId} could not be read (${res.status}): ` +
        `${JSON.stringify(res.body).slice(0, 300)}`,
    );
  }
  return orgId;
}

/** Reuse-or-create this epic's own project in the target workspace. */
async function ensureGateProject(
  api: Api,
  workspaceId: string,
  headers: Record<string, string>,
): Promise<string> {
  const list = await api.get(`/api/v1/projects?workspaceId=${workspaceId}&limit=100`, headers);
  const found = asList(list.body).find((p: any) => p?.name === SYNTHETIC_GRADOS_PROJECT_NAME);
  if (found?.id) return found.id;
  const created = await api.post(
    '/api/v1/projects',
    { name: SYNTHETIC_GRADOS_PROJECT_NAME, workspaceId },
    headers,
  );
  if (created.status >= 300 || !created.body?.id) {
    throw new Error(
      `seedSyntheticGrados: could not create project "${SYNTHETIC_GRADOS_PROJECT_NAME}" in ` +
        `workspace ${workspaceId} (${created.status}): ${JSON.stringify(created.body).slice(0, 300)}`,
    );
  }
  return created.body.id;
}

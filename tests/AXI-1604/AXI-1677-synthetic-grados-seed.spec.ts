import { test, expect, request, type APIResponse } from '@playwright/test';
import { apiUrl, LIVE_LLM, LIVE_LLM_SKIP_REASON } from '../../config/env';
import { adminApi, workspaceHeader, type Api } from '../AXI-1435/harness/api';
import type { Tenant } from '../AXI-1435/harness/seed';
import { seedSyntheticGrados } from './harness/synthetic-grados-seed';
import { anchorDataset, AnchorDatasetError, SHA256_VERSION_HASH_RE } from './harness/anchor-dataset';
import { buildEnvelope } from '../AXI-1462/harness/governed';
import { loadGradosBank } from '../AXI-1462/harness/governed';
import {
  isRefusalPlan,
  runShadowBank,
  ShadowRunAuthError,
  type ShadowRunAuth,
} from '../AXI-1462/harness/shadow';
import { declaredCategories, SYNTHETIC_GRADOS_COLUMNS } from './fixtures/synthetic-grados-schema';

/**
 * AXI-1677 (epic AXI-1604 — FR28/FR29/FR30, SI-042). Gate readiness.
 *
 * Scenarios §4.3-§4.6 of
 * `axiome-docs/manual-e2e/AXI-1604-Compiled-Planner-Rollout.md`.
 *
 * WHAT THIS STORY IS FOR. AXI-1661 and AXI-1662 made a schema-less planner
 * envelope impossible to send silently. They did not make a valid FR30
 * measurement POSSIBLE: the bank's 46 questions are IgG4-RD immunology, and the
 * only real dataset in the tenant is Riaz 2017 melanoma, which shares no column
 * with them. This spec seeds a dataset the bank's questions can actually bind
 * to, proves it resolves with a real hash / real types / real category domains,
 * proves the planner plans on it, and proves that the two harness defects that
 * corrupted the 2026-09-25 run — untargeted dataset selection and a token that
 * expires mid-run — are gone.
 *
 * ═══ THE SEEDED DATA IS SYNTHETIC ═══
 * `synthetic-grados-cohort.csv` carries the COLUMN SCHEMA FR29 declared
 * (`GRADOS_DATASET`), and 320 rows of fixed-seed PRNG VALUES. No cohort-level
 * Grados dataset exists anywhere — the paper published summary tables only. It
 * exists so the compiled planner can be MEASURED; it is not evidence about
 * IgG4-RD. See the generator's header for the full provenance statement.
 *
 * Run against the demo stack:
 *     npx playwright test tests/AXI-1604/AXI-1677-synthetic-grados-seed
 * The last test makes ONE live planner call. The 46-question bank is NOT run
 * here — that run is the gate measurement itself (AXI-1670).
 */
test.describe.configure({ mode: 'serial', timeout: 10 * 60_000 });
// Real Anthropic spend: opt in with E2E_LIVE_LLM=1 (README § Environment targeting).
test.skip(!LIVE_LLM, LIVE_LLM_SKIP_REASON);

let api: Api;
let tenant: Tenant;
let syntheticDatasetId: string;

test.beforeAll(async () => {
  api = await adminApi();
  // The ordinary ingestion path — upload, finalize, wait for `ready`, link to
  // the project. Idempotent: an already-available dataset of this filename is
  // reused rather than duplicated. `SHADOW_RUN_WORKSPACE_ID` chooses where; see
  // the seeder's header for why `ensureTenant()`'s own workspace cannot be
  // seeded on the shared demo stack today.
  ({ tenant, datasetId: syntheticDatasetId } = await seedSyntheticGrados(api));
  // eslint-disable-next-line no-console
  console.log(
    `AXI-1677 synthetic dataset: id=${syntheticDatasetId} workspace=${tenant.workspaceId} project=${tenant.projectId}\n` +
      `  SHADOW_RUN_WORKSPACE_ID=${tenant.workspaceId} SHADOW_RUN_PROJECT_ID=${tenant.projectId} SHADOW_RUN_DATASET_ID=${syntheticDatasetId}`,
  );
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test(
  '4.3 FR28 FR29 FR30 — the synthetic Grados-shaped dataset resolves with a real hash, profiler types and the declared category domains',
  { tag: ['@SI-042'] },
  async () => {
    const anchor = await anchorDataset(api, tenant.workspaceId, tenant.projectId, {
      datasetId: syntheticDatasetId,
    });
    expect(anchor, 'the seeded synthetic dataset anchors').not.toBeNull();

    // eslint-disable-next-line no-console
    console.log(`resolved envelope:\n${JSON.stringify(anchor, null, 2)}`);

    // Real identity. The 2026-09-25 run sent the literal `sha256:unknown`.
    expect(anchor!.versionHash).not.toBe('sha256:unknown');
    expect(anchor!.versionHash).toMatch(SHA256_VERSION_HASH_RE);

    // Real schema: every column the FR29 fixture DECLARES is present and typed.
    const resolved = new Map(anchor!.columns.map((c) => [c.name, c]));
    const missing = SYNTHETIC_GRADOS_COLUMNS.filter((c) => !resolved.has(c.name)).map((c) => c.name);
    expect(missing, 'every declared GRADOS_DATASET column is present in the resolved envelope').toEqual([]);
    const untyped = anchor!.columns.filter((c) => !c.type).map((c) => c.name);
    expect(untyped, 'the profiler typed every column').toEqual([]);

    // Every declared categorical domain is OBSERVED, not merely declared. The
    // levels are text in the CSV precisely so the profiler agrees with the
    // declaration: it types a numerically-coded column `numeric`, with no
    // categories at all, which would contradict every golden intent that binds
    // that column as a grouping column.
    for (const [name, declared] of declaredCategories()) {
      const observed = resolved.get(name)?.categories ?? [];
      expect(
        [...observed].sort(),
        `${name}: observed category domain matches the declared one (type was '${resolved.get(name)?.type}')`,
      ).toEqual([...declared].sort());
    }
  },
);

test(
  '4.4 FR28 FR30 — SHADOW_RUN_DATASET_ID anchors exactly that dataset, reproducibly, and throws when it cannot',
  { tag: ['@SI-042'] },
  async () => {
    const first = await anchorDataset(api, tenant.workspaceId, tenant.projectId, {
      datasetId: syntheticDatasetId,
    });
    const second = await anchorDataset(api, tenant.workspaceId, tenant.projectId, {
      datasetId: syntheticDatasetId,
    });

    expect(first!.datasetId).toBe(syntheticDatasetId);
    expect(first!.displayName).toContain('synthetic-');
    // Reproducible: a gate measurement must be able to be re-run on the same input.
    expect(second).toEqual(first);

    // A targeted id that cannot be reached FAILS. It does not fall back to the
    // first dataset in the workspace, and it does not return `null` — `null`
    // means "this workspace holds nothing anchorable", which is a different fact.
    const absent = '00000000-0000-4000-8000-0000000000ff';
    await expect(
      anchorDataset(api, tenant.workspaceId, tenant.projectId, { datasetId: absent }),
    ).rejects.toThrow(AnchorDatasetError);
    await expect(
      anchorDataset(api, tenant.workspaceId, tenant.projectId, { datasetId: absent }),
    ).rejects.toThrow(absent);
  },
);

test(
  '4.5 FR28 FR30 — the planner PLANS a bank question against the synthetic dataset, on real columns, and refuses nothing for want of a schema',
  { tag: ['@SI-042', '@SI-045'] },
  async () => {
    const anchor = await anchorDataset(api, tenant.workspaceId, tenant.projectId, {
      datasetId: syntheticDatasetId,
    });
    // Bank Q4 — "Does IFNy release differ between IgG4-RD, HC and pSS?" — the
    // simplest single-measure, three-group question in the bank, and the one
    // FR29's golden fixture maps straight onto `compare_groups` (measureColumn
    // `ifng`, groupingColumn `disease_group`). ONE call: the 46-question run is
    // the gate measurement itself (AXI-1670) and is not spent here. Q1 was tried
    // first and returns a substantive `no_shape` — see this story's hand-back;
    // that is an EC18/S18.2 finding about the shape catalogue, not about the
    // seed, and it is not what this test is for.
    const question = loadGradosBank().find((q) => q.id === 4)!.question;
    const envelope = buildEnvelope(tenant.projectId, question, [anchor!]);

    const res = await api.post(
      '/api/v1/guided-analysis/plan',
      { projectId: tenant.projectId, envelope },
      workspaceHeader(tenant.workspaceId),
    );

    // eslint-disable-next-line no-console
    console.log(
      `plan response: status=${res.status} planner=${res.body?.planner} unsupported=${res.body?.intentUnsupported} ` +
        `fallback=${res.body?.plannerFallback} attempts=${res.body?.plan?.attemptCount} correlationId=${res.body?.correlationId}\n` +
        `${JSON.stringify(res.body?.plan, null, 2)}`,
    );

    expect(res.status, `plan request succeeded: ${JSON.stringify(res.body).slice(0, 600)}`).toBeLessThan(300);
    expect(res.body?.plan, 'the response carries a plan').toBeTruthy();

    // Whatever the planner decides, it cannot decide it for the 2026-09-25
    // reason. Those refusals all read "the dataset schema lists no columns at all".
    const stated = JSON.stringify(res.body?.plan?.unsupportedReason ?? res.body?.plan?.reasoning ?? '');
    expect(stated).not.toMatch(/no columns at all/i);
    expect(stated).not.toMatch(/sha256:unknown/);

    // A real plan, not a refusal in any of its three spellings. This is the
    // thing the 2026-09-25 run could not produce even once.
    expect(res.body?.intentUnsupported, `not unsupported: ${stated}`).toBeFalsy();
    expect(res.body?.plannerFallback, 'not a deterministic fallback').toBeFalsy();
    expect(
      isRefusalPlan(res.body?.plan),
      `the plan analyses something: datasetsUsed=${JSON.stringify(res.body?.plan?.datasetsUsed)} ` +
        `nodes=${JSON.stringify(res.body?.plan?.nodes?.map((n: { nodeType?: string }) => n.nodeType))}`,
    ).toBe(false);

    // And it planned over THIS dataset, on columns that exist in it.
    const planJson = JSON.stringify(res.body?.plan);
    expect(planJson, 'the plan names the seeded dataset').toContain(syntheticDatasetId);
    expect(planJson, 'the plan binds a real column from the synthetic schema').toMatch(
      /ifng|disease_group/,
    );
  },
);

test(
  '4.6 FR28 FR30 — an unrecoverable 401 fails the shadow run loudly instead of being recorded as an outcome',
  { tag: ['@SI-042'] },
  async () => {
    const anchor = await anchorDataset(api, tenant.workspaceId, tenant.projectId, {
      datasetId: syntheticDatasetId,
    });

    // A LIVE run whose token is genuinely rejected by the gateway: a real
    // request context carrying a syntactically valid but invalid bearer token,
    // and a `refresh()` that hands back the same broken client. This is the
    // 2026-09-25 failure mode reproduced against the real backend, not a stub.
    const broken = await brokenTokenApi();
    const neverRefreshes: ShadowRunAuth = {
      api: () => broken,
      refresh: async () => broken,
    };

    await expect(
      runShadowBank(neverRefreshes, tenant.workspaceId, tenant.projectId, 'compiled', [anchor!], {
        reauthEveryQuestions: 0,
      }),
    ).rejects.toThrow(ShadowRunAuthError);

    // The RECOVERY half — a 401 followed by a successful refresh is retried and
    // recorded normally — is UT-SHADOW-1677-14, offline. Proving it live would
    // mean holding a real token until it genuinely expires, which is an
    // hour-long test of the gateway's TTL rather than of this harness.
    await broken.ctx.dispose();
  },
);
/**
 * A real API client whose bearer token the gateway will reject with a 401 — the
 * 2026-09-25 failure state, reproduced deliberately. Not built on `adminApi()`:
 * that caches a real token for the process, and poisoning the cache would leak
 * into every other test in this serial file.
 */
async function brokenTokenApi(): Promise<Api> {
  const ctx = await request.newContext({
    extraHTTPHeaders: { Authorization: 'Bearer expired.e2e.token' },
  });
  const parse = async (res: APIResponse) => {
    const text = await res.text();
    let body: unknown;
    try {
      body = text.length ? JSON.parse(text) : undefined;
    } catch {
      body = { _raw: text };
    }
    return { status: res.status(), body: body as any };
  };
  return {
    ctx,
    get: async (path, headers) => parse(await ctx.get(apiUrl(path), { headers })),
    post: async (path, body, headers) => parse(await ctx.post(apiUrl(path), { data: body as any, headers })),
    patch: async (path, body, headers) => parse(await ctx.patch(apiUrl(path), { data: body as any, headers })),
  };
}

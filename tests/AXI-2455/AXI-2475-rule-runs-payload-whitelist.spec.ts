import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { apiUrl } from '../../config/env';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { carrierRuleId, ensureAnalysis, ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { ingestCsvFixture } from '../AXI-2308/harness/opening-templates';

/**
 * AXI-2475 (epic AXI-2455 — SAP NFR1, TPL NFR4; SI-010): the rule-run gateway routes
 * build their payload field by field from a whitelisted DTO, so a client can never
 * assert who the caller is (or set a server-only field) through the body.
 *
 * Before this story `POST /rule-runs`, `/preflight` and `/referent-pairing` took an
 * inline type, which the gateway ValidationPipe skips, and spread the raw body into
 * the RPC. A forged caller field was overwritten, but server-only fields such as
 * `deferSnapshot` and `replayOfRuleRunId` reached the organization-service. Now each
 * one is a 400, and the ordinary run is unchanged.
 *
 * Manual-E2E: axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md § AXI-2475.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ['@SI-010'] };
const MWU = 'stats.mann_whitney_u';
const FIXTURE = 'opening-templates-paul-header.csv';
const OUTCOME = 'microbiote_igg4_mag4_27';
const RULE_RUN_WAIT_MS = 120_000;
const SETUP_TIMEOUT_MS = 6 * 60_000;

/** A field a client may not send, each with the value a forging client would choose. */
const FORGED_FIELDS: Array<[string, unknown]> = [
  ['triggeredBy', randomUUID()],
  ['callerUserId', randomUUID()],
  ['userId', randomUUID()],
  ['callerIsPlatformAdmin', true],
  ['rulePermissions', { canRead: true, canEvaluate: true, canViewShared: true }],
  ['deferSnapshot', true],
  ['replayOfRuleRunId', randomUUID()],
  ['droppedStoredCensoringSubstitution', true],
];

let api: Api;
let t: Tenant;
let datasetId: string;
let world: PrivateProjectsWorld;
let outsider: Actor;

/** An ordinary, whitelisted STATISTICAL submission against the admin tenant's fixture. */
async function mwuBody(): Promise<Record<string, unknown>> {
  return {
    ruleId: await carrierRuleId(MWU),
    runKind: 'STATISTICAL',
    operationId: MWU,
    projectId: t.projectId,
    workspaceId: t.workspaceId,
    datasetId,
    roleBindings: { groupColumn: 'sexe' },
    pivot: { valueColumns: [OUTCOME] },
    operationParams: { groupFrom: 'F', groupTo: 'M' },
  };
}

async function ruleRunsTotal(): Promise<number> {
  const res = await api.get(`/api/v1/rule-runs?workspaceId=${t.workspaceId}&limit=1`, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.total;
}

/** A 400 from the whitelist, naming the refused property. */
function expectRefusedField(res: { status: number; body: any }, field: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(JSON.stringify(res.body)).toContain(`property ${field} should not exist`);
}

test.describe('AXI-2475 — rule-run payloads are built field by field', () => {
  // Serial: .1 and .3 count the tenant's runs while .4 creates one.
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    test.setTimeout(SETUP_TIMEOUT_MS); // hooks are governed by setTimeout, never describe.configure
    await approveCarriersFor([MWU]);
    api = await adminApi();
    t = await ensureTenant(api);
    datasetId = await ingestCsvFixture(api, t, FIXTURE);
    // A non-admin caller who belongs to a DIFFERENT workspace than the admin tenant's.
    world = await PrivateProjectsWorld.create();
    outsider = await world.actor('outsider');
    await world.addMember(outsider, 'editor');
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
    await world?.dispose();
  });

  test('NFR1 NFR4 — AXI-2475.1: POST /rule-runs refuses a body asserting the caller or a server-only field; no run is created', TAGS, async () => {
    // Arrange
    const before = await ruleRunsTotal();
    const body = await mwuBody();

    // Act + Assert — one forged field at a time, so each refusal names its own field
    for (const [field, value] of FORGED_FIELDS) {
      const res = await api.post('/api/v1/rule-runs', { ...body, [field]: value }, t.headers);
      expectRefusedField(res, field);
    }
    expect(await ruleRunsTotal()).toBe(before);
  });

  test('NFR1 NFR4 — AXI-2475.2: /rule-runs/preflight and /rule-runs/referent-pairing refuse a forged caller', TAGS, async () => {
    // Arrange
    const forgedCaller = randomUUID();
    const pairing = { projectId: t.projectId, workspaceId: t.workspaceId, datasetId };

    // Act
    const preflight = await api.post('/api/v1/rule-runs/preflight', { ...(await mwuBody()), callerUserId: forgedCaller }, t.headers);
    const referent = await api.post('/api/v1/rule-runs/referent-pairing', { ...pairing, callerUserId: forgedCaller }, t.headers);
    const honestReferent = await api.post('/api/v1/rule-runs/referent-pairing', pairing, t.headers);

    // Assert
    expectRefusedField(preflight, 'callerUserId');
    expectRefusedField(referent, 'callerUserId');
    expect(honestReferent.status, JSON.stringify(honestReferent.body)).toBe(200);
  });

  test("NFR4 EC11 — AXI-2475.3: a non-admin naming another tenant's workspace is refused 404 and creates no run there", TAGS, async () => {
    // Arrange
    const before = await ruleRunsTotal();
    const body = await mwuBody(); // names the ADMIN tenant's workspace, project and dataset

    // Act
    const execute = await outsider.api.post(apiUrl('/api/v1/rule-runs'), { data: body });
    const preflight = await outsider.api.post(apiUrl('/api/v1/rule-runs/preflight'), { data: body });
    const pairing = await outsider.api.post(apiUrl('/api/v1/rule-runs/referent-pairing'), {
      data: { projectId: t.projectId, workspaceId: t.workspaceId, datasetId },
    });

    // Assert
    for (const res of [execute, preflight, pairing]) {
      expect(res.status(), await res.text()).toBe(404);
    }
    expect(await ruleRunsTotal()).toBe(before);
  });

  test('NFR1 — AXI-2475.4: an ordinary whitelisted run still submits, preflights and is stamped with the verified caller', TAGS, async () => {
    // Arrange
    const me = await api.get('/api/v1/auth/me', t.headers);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    const analysis = await ensureAnalysis(api, t, 'AXI-2475 whitelisted run', datasetId);
    const body = {
      ...(await mwuBody()),
      snapshotId: analysis.snapshotId,
      viewAnalysisId: analysis.analysisId,
      scope: 'FILTERED',
    };

    // Act
    const preflight = await api.post('/api/v1/rule-runs/preflight', body, t.headers);
    const submitted = await api.post('/api/v1/rule-runs', body, t.headers);

    // Assert
    expect(preflight.status, JSON.stringify(preflight.body)).toBe(200);
    expect(submitted.status, JSON.stringify(submitted.body)).toBeLessThan(300);
    let run: any = null;
    await expect
      .poll(async () => {
        const res = await api.get(`/api/v1/rule-runs/${submitted.body.ruleRunId}`, t.headers);
        run = res.body;
        return res.status === 200 ? run?.status : `HTTP ${res.status}`;
      }, { timeout: RULE_RUN_WAIT_MS, intervals: [1_000, 2_000, 5_000] })
      .toMatch(/^(SUCCEEDED|DEDUPED)$/);
    expect(run.triggeredBy).toBe(me.body.id);
    expect(run.operationId).toBe(MWU);
    expect(run.workspaceId).toBe(t.workspaceId);
  });
});

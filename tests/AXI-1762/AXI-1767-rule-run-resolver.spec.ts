import { test, expect, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, asList, sleep, workspaceHeader, type Api } from '../AXI-1400/harness/api';

/**
 * AXI-1767 (epic AXI-1762 — FR22..FR27, FR24, FR33; EC4, EC8, EC12; NFR5, NFR6,
 * NFR10): the rule-run RESOLVER (`POST /rule-runs/resolve`), the value-origin
 * claim on `POST /rule-runs`, and the governed path's "rule awaiting approval".
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §12.
 *
 * API-level, LLM-free, against a REAL gateway → organization-service. The
 * referent is a dataset whose upload was initiated but never finalized, so it
 * has NO ready ingestion and no profile: EC4's referent exactly, and it needs no
 * compute plane. Every scenario that needs a PROFILED dataset (a dataset-role
 * fill, a suggestion, a level domain, a completed run's recorded origins) is in
 * the manual residue / unit-pinned — see §12.5.
 *
 * Since AXI-1768 nothing is offered without an approval record and the boot
 * seeder never publishes. The resolver needs an OFFERED rule, so `beforeAll`
 * walks the `DELTA-01` family carrier through review (guidance → checked →
 * in_review → bulk approve) when — and only when — it is not already offered.
 * `DELTA-01` is chosen because, on today's registry, no STATISTICAL carrier can
 * pass the checked gate (its operation's field help is not declared yet), while
 * the delta operations' help is. §12.3.7 uses exactly that: a STATISTICAL
 * carrier that has never been published is the EC12 "awaiting approval" case.
 *
 * Every scenario runs in DEDICATED workspaces created here, so authoring an
 * AnalysisPolicy never moves another spec's workspace.
 */

const CARRIER = 'DELTA-01';
const OPERATION = 'delta.difference';
const PROFILE_NOT_READY = 'profiling has not finished for this dataset';
const DELTA_GUIDANCE = {
  whatItDoes: 'Computes a per-subject, per-feature change between two chosen levels (timepoints).',
  whenToUse: 'Paired measurements of the same subjects at two timepoints.',
  whenNotToUse: 'Independent groups, or subjects measured only once.',
  example: 'Baseline to week 12 change in CD4 count per patient.',
  youWillGet: 'A delta table: one row per subject per feature.',
};

interface ResolvedField {
  name: string;
  slot: 'param' | 'role' | 'pivot' | 'ordering';
  required: boolean;
  value: unknown;
  origin: string | null;
  editable: boolean;
  reason?: string;
  pickRefused?: boolean;
  domain: { kind: string };
}

interface Resolution {
  ruleId: string;
  operationId: string;
  fields: ResolvedField[];
  fullyBound: boolean;
  disabledReason: string | null;
  unresolvedCount: number;
}

interface Scope {
  orgId: string;
  workspaceId: string;
  projectId: string;
  datasetId: string;
  headers: Record<string, string>;
}

interface LibraryRule {
  id: string;
  code: string;
  status: string;
  tags?: string[];
}

// One worker for the file: `beforeAll` approves the carrier on a fresh stack, and
// parallel workers would each run it and race the review walk.
test.describe.configure({ mode: 'default' });

let api: Api;
let home: Scope;
let foreign: Scope;
let ruleId: string;

const unique = (prefix: string) => `${prefix} ${Date.now()}-${Math.floor(Math.random() * 100000)}`;

async function ok<T = any>(res: Promise<{ status: number; body: T }>, label: string): Promise<T> {
  const r = await res;
  expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

async function makeScope(orgId: string, label: string): Promise<Scope> {
  const ws = await ok(api.post('/api/v1/workspaces', { name: unique(label), type: 'internal', ownerOrganizationId: orgId }), 'workspace');
  const workspaceId = ws.id as string;
  const headers = workspaceHeader(workspaceId);
  const project = await ok(api.post('/api/v1/projects', { name: unique(`${label} project`), workspaceId }, headers), 'project');
  // Initiated, never finalized: the dataset exists in the workspace with no ready ingestion (EC4).
  const init = await ok(
    api.post(
      `/api/v1/workspaces/${workspaceId}/datasets`,
      { organizationId: orgId, originalFilename: 'axi1767-unprofiled.csv', contentType: 'text/csv' },
      headers,
    ),
    'dataset',
  );
  return { orgId, workspaceId, projectId: project.id, datasetId: init.dataset.id, headers };
}

async function systemLibrary(): Promise<LibraryRule[]> {
  return (await ok(api.get('/api/v1/rules?scope=system&limit=200'), 'library')).data as LibraryRule[];
}

/**
 * AXI-1768: an unapproved carrier is not offered. Walk it through review
 * (idempotent — each step runs only from the state that needs it).
 */
async function ensureApproved(code: string): Promise<string> {
  const rule = (await systemLibrary()).find((r) => r.code === code);
  expect(rule, `${code} is boot-seeded`).toBeDefined();
  const id = rule!.id;
  let detail = await ok(api.get(`/api/v1/rules/${id}`), 'rule');
  if (detail.status === 'published') return id;
  if (detail.status === 'draft') {
    detail = await ok(api.patch(`/api/v1/rules/${id}`, { guidance: DELTA_GUIDANCE }), 'complete guidance');
    expect(detail.status, `${code} passes the checked gate`).toBe('checked');
  }
  if (detail.status === 'checked') {
    await ok(api.post(`/api/v1/rules/${id}/submit-for-review`, {}), 'submit-for-review');
    detail = await ok(api.get(`/api/v1/rules/${id}`), 'rule');
  }
  const approved = await ok(
    api.post('/api/v1/rules/bulk/approve', {
      ruleIds: [id],
      justification: 'AXI-1767 e2e — the resolver needs an offered carrier.',
      expectedContentHashes: { [id]: detail.review.contentHash },
    }),
    'bulk approve',
  );
  expect(approved).toMatchObject({ published: 1, failed: 0 });
  return id;
}

const body = (scope: Scope, extra: Record<string, unknown> = {}) => ({
  ruleId,
  operationId: OPERATION,
  workspaceId: scope.workspaceId,
  projectId: scope.projectId,
  datasetId: scope.datasetId,
  ...extra,
});

async function resolve(payload: Record<string, unknown>, headers: Record<string, string>) {
  return api.post<Resolution>('/api/v1/rule-runs/resolve', payload, headers);
}

const byName = (res: Resolution) => Object.fromEntries(res.fields.map((f) => [f.name, f]));

test.beforeAll(async () => {
  api = await adminApi();
  const orgs = asList((await api.get('/api/v1/organizations?limit=100')).body);
  const orgId =
    orgs.find((o: any) => o.name === 'AXI-1767 Resolver Org')?.id ??
    (await ok(api.post('/api/v1/organizations', { name: 'AXI-1767 Resolver Org', type: 'biotech' }), 'org')).id;
  home = await makeScope(orgId, 'AXI-1767 resolver');
  foreign = await makeScope(orgId, 'AXI-1767 foreign');
  ruleId = await ensureApproved(CARRIER);

  const offered = await ok(api.get(`/api/v1/rule-runs/offered-rules?workspaceId=${home.workspaceId}`, home.headers), 'offered');
  expect((offered.offered as Array<{ id: string }>).some((r) => r.id === ruleId), `${CARRIER} is offered once approved`).toBe(true);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-1767 rule-run resolver (API)', () => {
  test('12.3.1 EC4 FR23 — an unprofiled referent is disabled with the reason, roles open, params from the registry @SI-017 @SI-045', async () => {
    const res = await resolve(body(home), home.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ ruleId, operationId: OPERATION, fullyBound: false, disabledReason: PROFILE_NOT_READY });
    const fields = byName(res.body);
    for (const role of ['subjectKey', 'levelColumn', 'valueColumns']) {
      expect(fields[role], role).toMatchObject({ origin: null, value: null, required: true });
    }
    // Nothing is guessed from data it does not have: no suggestion, no role fill.
    expect(res.body.fields.filter((f) => f.origin === 'suggested' || f.origin === 'dataset_role')).toEqual([]);
    expect(fields.outputMode).toMatchObject({ value: 'delta_table', origin: 'registry_default', editable: true });
    expect(fields.levelFrom).toMatchObject({ origin: null, required: true });
    expect(fields.censoringSubstitution).toMatchObject({ origin: null, required: false });
  });

  test('12.3.2 EC8 FR23 — a LOCKED policy value is shown locked; a policy default outranks the registry and a pick outranks it @SI-017 @SI-045', async () => {
    await ok(
      api.post(
        `/api/v1/workspaces/${home.workspaceId}/analysis-policy`,
        { entries: { [OPERATION]: { outputMode: { value: 'annotate', locked: true }, censoringSubstitution: { value: 'exclude', locked: false } } } },
        home.headers,
      ),
      'author policy',
    );

    const plain = await resolve(body(home), home.headers);
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    let fields = byName(plain.body);
    expect(fields.outputMode).toMatchObject({ value: 'annotate', origin: 'locked_policy', editable: false });
    expect(fields.censoringSubstitution).toMatchObject({ value: 'exclude', origin: 'policy_default', editable: true });

    const picked = await resolve(
      body(home, { chosen: { params: { outputMode: 'delta_table', censoringSubstitution: 'lod_over_2' } } }),
      home.headers,
    );
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    fields = byName(picked.body);
    // The lock wins and the refused pick is named; the unlocked pick is the user's.
    expect(fields.outputMode).toMatchObject({ value: 'annotate', origin: 'locked_policy', pickRefused: true });
    expect(fields.outputMode.reason).toBeTruthy();
    expect(fields.censoringSubstitution).toMatchObject({ value: 'lod_over_2', origin: 'user' });
    expect(picked.body.fullyBound).toBe(false);
  });

  test('12.3.3 NFR6 — tenancy: a dataset or project outside the workspace is 404; no caller is 401 @SI-017', async () => {
    const foreignDataset = await resolve(body(home, { datasetId: foreign.datasetId }), home.headers);
    expect(foreignDataset.status, JSON.stringify(foreignDataset.body)).toBe(404);
    const foreignProject = await resolve(body(home, { projectId: foreign.projectId }), home.headers);
    expect(foreignProject.status, JSON.stringify(foreignProject.body)).toBe(404);

    const anonymous = await apiRequest.newContext();
    try {
      const res = await anonymous.post(apiUrl('/api/v1/rule-runs/resolve'), { data: body(home), headers: home.headers });
      expect(res.status()).toBe(401);
    } finally {
      await anonymous.dispose();
    }
  });

  test('12.3.4 FR22 AC5 — the rule must be offered and must carry the operation asked about @SI-017', async () => {
    const mismatch = await resolve(body(home, { operationId: 'stats.unpaired_ttest' }), home.headers);
    expect(mismatch.status, JSON.stringify(mismatch.body)).toBe(400);
    expect(JSON.stringify(mismatch.body)).toContain(`${CARRIER} does not run stats.unpaired_ttest`);

    const unknown = await resolve(body(home, { ruleId: '00000000-0000-4000-8000-00000000abcd' }), home.headers);
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(404);

    // AXI-1768: a carrier that was never approved is not offered, so it cannot be resolved.
    const unapproved = (await systemLibrary()).find((r) => r.code.startsWith('STAT-') && r.status !== 'published');
    if (unapproved) {
      const op = (unapproved.tags ?? []).find((t) => t.startsWith('op:'))!.slice(3);
      const res = await resolve(body(home, { ruleId: unapproved.id, operationId: op }), home.headers);
      expect(res.status, JSON.stringify(res.body)).toBe(404);
    }

    const unregistered = await resolve(body(home, { operationId: 'stats.axi1767_not_registered' }), home.headers);
    expect(unregistered.status, JSON.stringify(unregistered.body)).toBe(400);
  });

  test('12.3.5 NFR6 — the body cannot assert the caller, and the scope is required @SI-017', async () => {
    const forged = await resolve(body(home, { callerUserId: '00000000-0000-4000-8000-00000000beef' }), home.headers);
    expect(forged.status, JSON.stringify(forged.body)).toBe(400);
    const { workspaceId: _omit, ...noWorkspace } = body(home);
    const missing = await resolve(noWorkspace, home.headers);
    expect(missing.status, JSON.stringify(missing.body)).toBe(400);
  });

  test('12.3.6 FR27 NFR6 — an origin claim the platform cannot reproduce is refused and writes no run @SI-017 @SI-045', async () => {
    const runs = async () => asList((await api.get(`/api/v1/rule-runs?workspaceId=${home.workspaceId}&limit=100`, home.headers)).body).length;
    const before = await runs();
    const execute = (valueOrigins: unknown) =>
      api.post(
        '/api/v1/rule-runs',
        {
          ruleId,
          runKind: 'DELTA',
          operationId: OPERATION,
          formula: 'difference',
          workspaceId: home.workspaceId,
          projectId: home.projectId,
          datasetId: home.datasetId,
          pivot: { valueColumns: ['score'] },
          operationParams: { levelFrom: 'baseline', levelTo: 'week12', outputMode: 'annotate' },
          valueOrigins,
        },
        home.headers,
      );

    // No confirmed dataset role declares `score` (the referent is not even profiled): a forged claim.
    const forged = await execute({ roles: { valueColumns: 'dataset_role' } });
    expect(forged.status, JSON.stringify(forged.body)).toBe(400);
    expect(JSON.stringify(forged.body)).toContain('VALUE_ORIGIN_NOT_REPRODUCED');

    // An origin outside the closed vocabulary is a malformed claim.
    const malformed = await execute({ roles: { valueColumns: 'from_the_column_name' } });
    expect(malformed.status, JSON.stringify(malformed.body)).toBe(400);
    expect(JSON.stringify(malformed.body)).toContain('VALUE_ORIGINS_INVALID');

    expect(await runs()).toBe(before);
  });

  test('12.3.7 EC12 FR24 — a governed plan whose carrier was never approved fails "rule awaiting approval", naming the rule @SI-017 @SI-047', async () => {
    const awaiting = (await systemLibrary()).find(
      (r) => r.code.startsWith('STAT-') && r.status !== 'published' && (r.tags ?? []).some((t) => t.startsWith('op:stats.')),
    );
    test.skip(!awaiting, 'every STATISTICAL carrier on this stack is already approved — EC12 has no subject here');
    const operationId = awaiting!.tags!.find((t) => t.startsWith('op:'))!.slice(3);
    const plan = {
      planId: unique('PL-AXI-1767-EC12').replace(' ', '-'),
      revision: 1,
      question: 'AXI-1767 EC12 probe',
      sendData: false,
      reasoning: { restatedQuestion: 'EC12', whyThisApproach: 'awaiting approval', whatThisWillNotEstablish: 'n/a', alternativesConsidered: [] },
      datasetsUsed: [],
      datasetsAvailableNotUsed: [],
      declaredFamily: null,
      nodes: [
        {
          id: 'n1', nodeType: 'compare_groups', stepLabel: 'Compare', clinicalQuestion: 'EC12', why: 'EC12', dependsOn: [], params: {},
          expectedEvidence: { effect_measure: 'difference', report_ci: false }, visualisation: null,
          proposedClaimCeiling: 'exploratory', familyId: null, operation: { operationId },
        },
      ],
    };
    const submitted = await ok(
      api.post('/api/v1/governed-execution/submit', { projectId: home.projectId, plan, datasetId: home.datasetId, workspaceId: home.workspaceId }, home.headers),
      'governed submit',
    );
    let node: { status: string; error: string | null } | undefined;
    for (let i = 0; i < 45; i++) {
      const status = await ok(
        api.get(`/api/v1/governed-execution/status?projectId=${home.projectId}&runId=${submitted.runId}`, home.headers),
        'status',
      );
      node = (status.nodes as Array<{ nodeId: string; status: string; error: string | null }>).find((n) => n.nodeId.endsWith('__n1'));
      if (node && !['PENDING', 'READY', 'SCHEDULED', 'RUNNING'].includes(node.status)) break;
      await sleep(2000);
    }
    expect(node?.status, JSON.stringify(node)).toBe('FAILED');
    expect(node!.error).toMatch(new RegExp(`^rule awaiting approval: ${awaiting!.code} \\(${awaiting!.status}\\)`));
    expect(node!.error).toContain(operationId);
    expect(node!.error).toContain('rule:publish');
  });
});

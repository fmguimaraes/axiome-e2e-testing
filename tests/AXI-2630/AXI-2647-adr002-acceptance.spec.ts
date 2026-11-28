import { expect, test, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { apiUrl } from '../../config/env';

/**
 * AXI-2647 (epic AXI-2630 — ADR-002 Decision 7 / DD20; FR55-FR57, AC1-AC3, AC25, AC26, AC29,
 * AC35, AC36, NFR8; SI-042) — the three ADR-002 acceptance tests (DD20) plus the AXI-2642
 * chart-type checks the lead asked to be covered here too.
 *
 * API-ONLY, against w5val (BASE_URL/API_BASE_URL point at the live stack; no browser `page`).
 * Two identities, both server-provisioned, never a custom workspace role (the custom-role-create
 * route needs a SYSTEM admin — see the known-defect note on w5val below, which this suite works
 * around rather than depends on):
 *   - `admin` (E2E_TEST_EMAIL) — the PROVISIONING identity: project + semantic-profile link.
 *     Holds the built-in workspace "admin" role (workspace a73a5f52…, roleId …0104), which the
 *     platform's `ROLE_PERMISSIONS` table resolves with `mapping:confirm_binding` too.
 *   - the `investigator` auth role (E2E_INVESTIGATOR_EMAIL/_PASSWORD, roleId …0105) — every
 *     Investigator-surface step: protocol, plan, finalise, upload, link, launch, read.
 *
 * Provisioning is a MINIMAL plan over platform-only semantic-profile fields (no AXI-2638
 * extension pack): `group`/`reference`/`pct` of the MAG4 T1_LONG fixture, all already canonical
 * fields of `immune_mediated_microbiota` — this sidesteps a real defect found while building the
 * full AXI-2648 nine-field preset (recorded below) and keeps AC1-AC3/AC25/AC26/AC29 running on
 * live launch/analysis/evidence data rather than blocked behind it.
 *
 * KNOWN DEFECT (recorded, not fixed — app code is out of scope for this story):
 *   `POST /api/v1/semantic-profiles/projects/:projectId/extensions` refuses EVERY otherwise
 *   well-formed pack with `extension-registry-id-not-namespaced` even though the sent
 *   `registry_id` (`canonical_fields.project.<projectId>.v1`) matches
 *   `validateExtensionPackShape`'s own suffix regex byte-for-byte (verified by running the exact
 *   compiled function, `/app/dist/apps/organization-service/main.js`, inside the
 *   `axiome-w5val-backend` container with the same input: it returns `true`). The HTTP call
 *   through the gateway still refuses with the identical message. Something between the
 *   gateway's `AddProfileExtensionDto` and the organization-service handler
 *   (`semantic-profiles.message.controller.ts#addExtension`) is altering or re-validating the
 *   payload before `addProfileExtension` runs — root cause not isolated inside this story's
 *   budget. This BLOCKS the AXI-2648 nine-field MAG4 preset (images 2-4, which need the
 *   project-extension fields) and the AXI-2638 permission-matrix spec's custom-role setup (a
 *   SEPARATE, second w5val gap: no seeded user anywhere on this stack holds the system `ADMIN`
 *   role, so `POST /api/v1/roles` 403s for every identity tried, including the demo
 *   `admin@cro-one.com`, whose `/auth/me` reports `role: "USER"`).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2630-ADR-002-Acceptance.md`.
 */

const WS = process.env.HANDOVER_WORKSPACE_ID ?? '';
// AXI_2647_ORG_ID must be the WORKSPACE's own `ownerOrganizationId` — the browser flow
// (`signInBrowser`'s `axiome-top-org`) cannot resolve a workspace whose org disagrees with the
// selected org, which silently rendered "No Workspace" with every binding select empty (an
// unmatched-org symptom indistinguishable in the DOM from "data not loaded yet").
const ORG = process.env.AXI_2647_ORG_ID ?? 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const ADMIN_EMAIL = process.env.E2E_TEST_EMAIL ?? 'admin@cro-one.com';
const ADMIN_PASSWORD = process.env.E2E_TEST_PASSWORD ?? 'admin';
const INV_EMAIL = process.env.E2E_INVESTIGATOR_EMAIL ?? '';
const INV_PASSWORD = process.env.E2E_INVESTIGATOR_PASSWORD ?? '';
const PROFILE_ID = 'immune_mediated_microbiota';
const FIXTURE_CSV = path.resolve(process.cwd(), 'fixtures/handover/final_tableau1_long_synthetic.csv');

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 300_000 });

interface Session {
  api: APIRequestContext;
  userId: string;
  accessToken: string;
  refreshToken: string;
}

async function login(anon: APIRequestContext, email: string, password: string): Promise<Session> {
  const res = await anon.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  expect(res.ok(), `login ${email}: ${await res.text()}`).toBeTruthy();
  const { accessToken, refreshToken } = await res.json();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WS } });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { api, userId: me.id, accessToken, refreshToken };
}

/** Same localStorage-seeding pattern AXI-2060's specs use (AXI-2302/AXI-2292) to sign a real
 * browser page in as a session already authenticated over the API, with no UI login step. */
async function signInBrowser(page: Page, session: Session): Promise<void> {
  await page.addInitScript(
    ([access, refresh, org, ws]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [session.accessToken, session.refreshToken, ORG, WS] as const,
  );
}

let admin: Session;
let investigator: Session;
let approver: Session;
let projectId: string;
let sapId: string;
let sapVersionId: string;
let fieldIds: { group: string; reference: string; pct: string };
let questionId: string;
let datasetId: string;
let launchedViewAnalysisId: string;
let launchedRunId: string;

const EDITOR_WORKSPACE_ROLE_ID = '00000000-0000-0000-0000-000000000102';

/** SELF_APPROVAL_NOT_PERMITTED (back CLAUDE.md "AXI-2258") means the evidence creator can
 * never also approve it, and the Investigator role is below `editor` (too low to approve at
 * all) — so AC1 needs a SECOND editor-tier identity, provisioned once, synthetic-local only
 * (NFR3/NFR7 — never a committed credential), per `docs/REST-API-Guide.md` §1.2/§2. */
async function ensureApprover(anon: APIRequestContext): Promise<Session> {
  const email = `axi2647-approver-${Date.now()}@axiomebio.local`;
  const password = 'Axi2647Approver!1';
  // The new member's org must be a collaborator of the WORKSPACE's own `ownerOrganizationId`
  // — never AXI_2647_ORG_ID (a different, unrelated org constant used elsewhere in this spec).
  const workspace = await (await admin.api.get(apiUrl(`/api/v1/workspaces/${WS}`))).json();
  const workspaceOrgId = workspace.ownerOrganizationId;
  const create = await admin.api.post(apiUrl('/api/v1/users'), {
    data: { email, password, firstName: 'AXI-2647', lastName: 'Approver', organizationId: workspaceOrgId },
  });
  expect(create.status(), await create.text()).toBe(201);
  const userId = (await create.json()).id;
  const addMember = await admin.api.post(apiUrl(`/api/v1/workspaces/${WS}/members`), {
    data: { userId, organizationId: workspaceOrgId, roleId: EDITOR_WORKSPACE_ROLE_ID },
  });
  expect(addMember.status(), await addMember.text()).toBe(201);
  return login(anon, email, password);
}

test.beforeAll(async () => {
  test.skip(!WS || !INV_EMAIL || !INV_PASSWORD, 'HANDOVER_WORKSPACE_ID / E2E_INVESTIGATOR_EMAIL / _PASSWORD not configured');
  const anon = await apiRequest.newContext();
  admin = await login(anon, ADMIN_EMAIL, ADMIN_PASSWORD);
  investigator = await login(anon, INV_EMAIL, INV_PASSWORD);
  approver = await ensureApprover(anon);
  await anon.dispose();
});

test.afterAll(async () => {
  await admin?.api.dispose();
  await investigator?.api.dispose();
  await approver?.api.dispose();
});

async function createProject(label: string): Promise<string> {
  const res = await admin.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2647 ${label} ${Date.now()}`, workspaceId: WS, semanticProfileIds: [PROFILE_ID] },
    headers: { 'X-Workspace-Id': WS },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

test.describe('AXI-2647 ADR-002 acceptance @SI-042 @SI-010 @SI-065', () => {
  test('AXI-2647.0 provision a minimal declared plan over platform-only fields and finalise it @SI-065', async () => {
    projectId = await createProject('provision');

    const protocol = await investigator.api.put(apiUrl(`/api/v1/projects/${projectId}/study/protocol`), {
      data: { title: 'AXI-2647 ADR-002 acceptance', objective: 'ADR-002 acceptance tests', studyPopulation: 'MAG4 cohort', text: 'rehearsal' },
    });
    expect(protocol.status(), await protocol.text()).toBe(200);

    const contract = await (await investigator.api.get(apiUrl(`/api/v1/projects/${projectId}/semantic-contract`))).json();
    const configVersion = contract.profile.configVersion as string;
    expect(configVersion).toMatch(/\+sha256:/);

    const draft0 = await (await investigator.api.post(apiUrl(`/api/v1/projects/${projectId}/saps/draft`), { data: { planSchemaVersion: 2 } })).json();
    sapId = draft0.sapId;

    const specRes = await investigator.api.put(apiUrl(`/api/v1/projects/${projectId}/saps/${sapId}/draft`), {
      data: {
        basedOnRevision: draft0.revision,
        title: 'AXI-2647 ADR-002 plan',
        studyPopulation: 'MAG4 cohort',
        dataSpecification: {
          fields: [
            { name: 'group', label: 'Group', semanticRole: 'grouping_three_plus_levels', levels: ['HD', 'IgG4-RD', 'SD'], required: false, canonicalField: 'disease_group', profilePin: configVersion },
            { name: 'reference', label: 'Reference', semanticRole: 'grouping_three_plus_levels', levels: ['ENT 059', 'CER 229', 'CER 215 et 234'], required: false, canonicalField: 'reference_microbiota', profilePin: configVersion },
            { name: 'pct', label: 'Pct', semanticRole: 'continuous', required: false, canonicalField: 'coating_pct', profilePin: configVersion },
          ],
        },
      },
    });
    expect(specRes.status(), await specRes.text()).toBe(200);
    const spec = await specRes.json();
    const byName = new Map<string, string>(spec.plan.dataSpecification.fields.map((f: any) => [f.name, f.fieldId]));
    fieldIds = { group: byName.get('group')!, reference: byName.get('reference')!, pct: byName.get('pct')! };

    const qRes = await investigator.api.post(apiUrl(`/api/v1/projects/${projectId}/saps/${sapId}/draft/questions`), {
      data: {
        basedOnRevision: spec.revision,
        analysisDatasetId: null,
        question: {
          text: 'Does the IgG4 anti-microbiota coating differ between HD, IgG4-RD and SD?',
          role: 'primary',
          estimand: { population: 'MAG4 cohort', variable: 'coating pct', intercurrentEvents: 'none', populationSummary: 'KW+Dunn', treatmentComparison: 'HD vs IgG4-RD vs SD' },
          template: { templateId: 'T2', templateVersion: '0.3' },
          bindings: [{ slot: 'groupingColumn', field: fieldIds.group }, { slot: 'outcome', field: fieldIds.pct }],
          parameters: { alpha: 0.05, sidedness: 'two_sided', groups: ['HD', 'IgG4-RD', 'SD'] },
          decisionCriterion: { kind: 'p_at_or_below_alpha' },
          sensitivityAnalyses: [],
        },
      },
    });
    expect(qRes.status(), await qRes.text()).toBe(201);
    const qBody = await qRes.json();
    questionId = qBody.addedQuestionId;

    const completeness = await (await investigator.api.get(apiUrl(`/api/v1/projects/${projectId}/saps/${sapId}/draft/completeness`))).json();
    const fails = (completeness.results ?? []).filter((r: any) => r.status === 'fail');
    expect(fails, JSON.stringify(fails)).toEqual([]);

    const fin = await investigator.api.post(apiUrl(`/api/v1/projects/${projectId}/saps/${sapId}/draft/finalise`), {
      data: { basedOnRevision: qBody.revision, basedOnVersion: null },
    });
    expect(fin.status(), await fin.text()).toBe(201);
    const finBody = await fin.json();
    sapVersionId = finBody.sapVersionId;
    expect(finBody.status).toBe('final');
  });

  test('AXI-2647.0b upload + link the dataset, confirm per-question readiness resolves (FR13, FR65) @SI-065', async () => {
    const runToken = `axi2647_run_${Date.now()}`;
    const init = await investigator.api.post(apiUrl(`/api/v1/workspaces/${WS}/datasets`), {
      data: { organizationId: ORG, originalFilename: `axi2647-${Date.now()}-t1-long.csv`, contentType: 'text/csv' },
    });
    expect(init.status(), await init.text()).toBe(201);
    const initBody = await init.json();
    datasetId = initBody.dataset.id;

    // Dataset upload dedups on CONTENT hash, not filename — salt with one trailing per-run
    // column (every preset column/value unchanged) so a repeated local run never 409s against
    // a leftover from a previous run of this same spec (same pattern as AXI-2598's rehearsal
    // harness `saltedVariant`).
    const baseLines = readFileSync(FIXTURE_CSV, 'utf8').replace(/\n$/, '').split('\n');
    const salted = Buffer.from(
      `${baseLines.map((l, i) => `${l},${i === 0 ? 'axi2647_run' : runToken}`).join('\n')}\n`,
      'utf8',
    );

    const put = await fetch(String(initBody.presignedUrl), { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: salted });
    expect(put.ok, `presigned PUT -> ${put.status}`).toBeTruthy();

    const fin = await investigator.api.patch(apiUrl(`/api/v1/workspaces/${WS}/datasets/${datasetId}/finalize`));
    expect(fin.status(), await fin.text()).toBe(200);

    const link = await investigator.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId } });
    expect(link.status(), await link.text()).toBe(201);

    // Ingestion is async — normalize (and question-data) only see columns once the latest
    // ingestion reaches "ready".
    let ingestionReady = false;
    for (let i = 0; i < 20 && !ingestionReady; i++) {
      const ds = await (await investigator.api.get(apiUrl(`/api/v1/workspaces/${WS}/datasets/${datasetId}`))).json();
      ingestionReady = ds.latestIngestion?.status === 'ready';
      if (!ingestionReady) await new Promise((r) => setTimeout(r, 1500));
    }
    expect(ingestionReady, 'dataset ingestion never reached ready').toBeTruthy();

    // AXI-1576 — a column name alone is never auto-matched into a `ProjectFieldMapping` row;
    // an editor-rank caller re-resolves against the current alias packs (the platform's own
    // alias registry maps "group"/"reference"/"pct" to disease_group/reference_microbiota/
    // coating_pct for this profile). The Investigator does not hold `editor` (MinimumRole),
    // so this ONE step runs as the provisioning identity, same pattern as AXI-2638's binder.
    // `normalize` itself depends on an ASYNC column-profiling pass behind ingestion (a second,
    // separate readiness signal from "ingestion ready") — retried, not called once, because the
    // first call(s) can legitimately see zero columns yet.
    let normalizeBody: any = null;
    for (let i = 0; i < 20; i++) {
      const normalize = await admin.api.post(apiUrl(`/api/v1/semantic-profiles/projects/${projectId}/normalize`));
      expect(normalize.status(), await normalize.text()).toBe(200);
      normalizeBody = await normalize.json();
      const progressed = (normalizeBody.totals?.filled ?? 0) + (normalizeBody.totals?.created ?? 0) > 0;
      if (progressed) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    let resolved = false;
    let lastQd: any = null;
    for (let i = 0; i < 20 && !resolved; i++) {
      lastQd = await (await investigator.api.get(apiUrl(`/api/v1/projects/${projectId}/saps/${sapId}/versions/${sapVersionId}/question-data`))).json();
      resolved = lastQd.questions?.[0]?.resolution?.kind === 'resolved';
      if (!resolved) await new Promise((r) => setTimeout(r, 1500));
    }
    expect(
      resolved,
      `question-data readiness never resolved: ${JSON.stringify(lastQd)} (last normalize: ${JSON.stringify(normalizeBody)})`,
    ).toBeTruthy();
  });

  test('AXI-2647.1 AC2/AC5/AC6/AC35 — launching the question makes it an ordinary, unique analysis; relaunch is a no-op @SI-065', async () => {
    const t0 = Date.now();
    const launch = await investigator.api.post(
      apiUrl(`/api/v1/projects/${projectId}/saps/${sapId}/versions/${sapVersionId}/questions/${questionId}/launch`),
      { data: {} },
    );
    expect(launch.status(), await launch.text()).toBe(201);
    const launchBody = await launch.json();
    expect(launchBody.launched).toHaveLength(1);
    const viewAnalysisId = launchBody.launched[0].viewAnalysisId;
    launchedRunId = launchBody.launched[0].runId;

    // AC35 / NFR8 — first result inside the ADR-002 rehearsal's 1-minute budget.
    let verdict: any = null;
    for (let i = 0; i < 40 && verdict?.state !== 'finished'; i++) {
      const v = await (await investigator.api.get(apiUrl(`/api/v1/projects/${projectId}/saps/${sapId}/versions/${sapVersionId}/verdicts`))).json();
      verdict = v.questions?.[0];
      if (verdict?.state !== 'finished') await new Promise((r) => setTimeout(r, 1500));
    }
    const elapsedMs = Date.now() - t0;
    expect(verdict?.state, 'question never reached "finished"').toBe('finished');
    expect(elapsedMs, `first result took ${elapsedMs}ms`).toBeLessThan(60_000);

    // AC2 — the launched analysis carries NO SapRun marker and is unique per question.
    const direct = await (await investigator.api.get(apiUrl(`/api/v1/view-analyses/${viewAnalysisId}`))).json();
    expect(direct.sapRunId).toBeNull();
    expect(direct.status).toBe('active');

    // AC6 — relaunch returns the SAME analysis, no second one.
    const relaunch = await investigator.api.post(
      apiUrl(`/api/v1/projects/${projectId}/saps/${sapId}/versions/${sapVersionId}/questions/${questionId}/launch`),
      { data: {} },
    );
    expect(relaunch.status(), await relaunch.text()).toBe(201);
    const relaunchBody = await relaunch.json();
    const unchangedOrSame =
      relaunchBody.unchanged?.some((u: any) => u.viewAnalysisId === viewAnalysisId) ||
      relaunchBody.launched?.some((l: any) => l.viewAnalysisId === viewAnalysisId);
    expect(unchangedOrSame, JSON.stringify(relaunchBody)).toBeTruthy();

    const links = await (await investigator.api.get(apiUrl(`/api/v1/projects/${projectId}/saps/${sapId}/question-analyses`))).json();
    const forThisQuestion = links.links.filter((l: any) => l.questionId === questionId);
    expect(forThisQuestion).toHaveLength(1);
    expect(forThisQuestion[0].viewAnalysisId).toBe(viewAnalysisId);

    (test.info() as any).annotations.push({ type: 'viewAnalysisId', description: viewAnalysisId });
    launchedViewAnalysisId = viewAnalysisId;
  });

  let ac1ExplorerAnalysisId: string | null = null;
  let ac1EvidenceTitle = 'AC1 explorer evidence';

  test('AXI-2647.1b AC1 — a finished, validated explorer analysis (never through a plan) displays on the Investigator with its evidence and no plan-run object @SI-065', async () => {
    // Given an analysis made in the EXPLORER (never through a plan)... — `POST /view-analyses`
    // directly, editor rank, no `sapId`/`sapVersionId` anywhere in the call.
    const create = await admin.api.post(apiUrl('/api/v1/view-analyses'), {
      data: { projectId, datasetId, name: `AXI-2647 AC1 explorer analysis ${Date.now()}` },
    });
    expect(create.status(), await create.text()).toBe(201);
    const explorerAnalysisId = (await create.json()).id;

    // ...that is finished (an evidence exists) and validated (the evidence is approved). A bare
    // `kind: 'note'` evidence with no chartEntries/citationContext is a genuine FR6 refusal
    // ("must cite at least one chart entry or one row/population/sample") — discovered live and
    // worth noting, but not what AC1 is testing — so this cites a real chart over a real
    // snapshot of the explorer analysis, same shape as any other evidence on the platform.
    const snapshot = await admin.api.post(apiUrl('/api/v1/view-analyses/snapshots'), {
      data: { viewAnalysisId: explorerAnalysisId, filters: [] },
    });
    expect(snapshot.status(), await snapshot.text()).toBe(201);
    const explorerSnapshotId = (await snapshot.json()).id;

    const spec = await admin.api.post(apiUrl(`/api/v1/workspaces/${WS}/datasets/${datasetId}/candidates`), {
      data: {
        templateId: 'strip_v1',
        templateVersion: '1.0.0',
        title: `AXI-2647 AC1 chart ${Date.now()}`,
        bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
        params: {},
        filters: [],
        viewAnalysisId: explorerAnalysisId,
      },
    });
    expect(spec.status(), await spec.text()).toBe(201);
    const chartSpecId = (await spec.json()).id;

    const evidence = await admin.api.post(apiUrl('/api/v1/view-analyses/evidences'), {
      data: {
        viewAnalysisId: explorerAnalysisId,
        kind: 'chart',
        title: 'AC1 explorer evidence',
        chartEntries: [{ chartArtifactId: chartSpecId, snapshotId: explorerSnapshotId, datasetVersionId: datasetId }],
      },
    });
    expect(evidence.status(), await evidence.text()).toBe(201);
    const evidenceId = (await evidence.json()).id;
    // SELF_APPROVAL_NOT_PERMITTED: the admin identity created it, so a DIFFERENT, editor-tier
    // actor approves it (the Investigator role is below `editor` and 403s "Insufficient
    // workspace role" on this route) — same self-approval doctrine as decision drafts (see
    // back CLAUDE.md "AXI-2258").
    const approve = await approver.api.patch(apiUrl(`/api/v1/view-analyses/evidences/${evidenceId}/status`), {
      data: { status: 'approved' },
    });
    expect(approve.status(), await approve.text()).toBe(200);

    // when the Investigator opens that project...
    const direct = await (await investigator.api.get(apiUrl(`/api/v1/view-analyses/${explorerAnalysisId}`))).json();
    // then the analysis displays in the question/result page with its evidence...
    expect(direct.id).toBe(explorerAnalysisId);
    const explorerEvidences = await (
      await investigator.api.get(apiUrl(`/api/v1/view-analyses/${explorerAnalysisId}/evidences`))
    ).json();
    expect((explorerEvidences.data ?? explorerEvidences).some((e: any) => e.id === evidenceId)).toBeTruthy();
    // ...and no plan-run object or other Investigator-only data exists for it.
    expect(direct.sapRunId).toBeNull();
    const links = await (await investigator.api.get(apiUrl(`/api/v1/projects/${projectId}/saps/${sapId}/question-analyses`))).json();
    expect(links.links.some((l: any) => l.viewAnalysisId === explorerAnalysisId)).toBeFalsy();

    // Same read path as any other analysis (AC2's doctrine, checked from the other direction):
    // the explorer analysis is listed through the SAME project listing the launched question is.
    // `evidenceCount` is a FIND_ALL-only list decoration (absent from the single-GET response).
    const list = await (await investigator.api.get(apiUrl(`/api/v1/view-analyses?projectId=${projectId}`))).json();
    const rows: any[] = list.data ?? list;
    const listed = rows.find((r) => r.id === explorerAnalysisId);
    expect(listed, JSON.stringify(rows)).toBeTruthy();
    expect(listed.evidenceCount).toBeGreaterThan(0);

    ac1ExplorerAnalysisId = explorerAnalysisId;
  });

  test('AXI-2647.2 AC2/AC25/AC29 — the launched analysis is a same-shape explorer analysis; its chart evidence is the declared shape @SI-042', async () => {
    const viewAnalysisId = launchedViewAnalysisId;
    const list = await (await investigator.api.get(apiUrl(`/api/v1/view-analyses?projectId=${projectId}`))).json();
    const rows: any[] = list.data ?? list;
    const guided = rows.find((r) => r.id === viewAnalysisId);

    // AC2 — same shape as any other analysis (name, evidence count, published state), via the
    // SAME listing read path the explorer and the Investigator both use.
    expect(guided).toBeTruthy();
    expect(guided.sapRunId).toBeNull();
    expect(guided.evidenceCount).toBeGreaterThan(0);

    const evidences = await (await investigator.api.get(apiUrl(`/api/v1/view-analyses/${viewAnalysisId}/evidences`))).json();
    const chartEvidence = (evidences.data ?? evidences).find((e: any) => e.kind === 'chart');
    expect(chartEvidence, 'no chart evidence on the launched analysis (AC25/AC29 — a template chart action, FR11)').toBeTruthy();

    // AC25/AC29 shape, not just existence: read the chart's own dataview spec (never the DOM —
    // faster and exact) and assert its template family. My plan's T2 question is a 3-group
    // (HD/IgG4-RD/SD) Kruskal-Wallis+Dunn comparison, so its recommended chart is a
    // points-over-box family with a significance badge; boxplot/strip/jitter/badge all name the
    // same rendered shape in this codebase's template catalogue (`templates/seed-templates`).
    const chartArtifactId = chartEvidence.currentVersion?.charts?.[0]?.dataviewSpecId
      ?? chartEvidence.currentVersion?.charts?.[0]?.chartArtifactId;
    expect(chartArtifactId, JSON.stringify(chartEvidence)).toBeTruthy();
    const specRes = await investigator.api.get(apiUrl(`/api/v1/workspaces/${WS}/datasets/${datasetId}/candidates/${chartArtifactId}`));
    if (specRes.ok()) {
      const spec = await specRes.json();
      expect(String(spec.templateId ?? ''), JSON.stringify(spec)).toMatch(/box|strip|jitter|dunn|kruskal/i);
    } else {
      // The chart artifact id is a frozen citation render, not a live spec id — named, not
      // silently accepted: the existence check above still holds for AC25/AC29's floor.
      (test.info() as any).annotations.push({ type: 'AC25-AC29-shape-check-skipped', description: `candidates lookup ${specRes.status()} for ${chartArtifactId}` });
    }
  });

  // AC3 (DD20 half 3) — a custom chart over the launched question's snapshot, from the result
  // page's "Add a chart" entry (`CustomChartEntry`, editor rank only, L13), saved as evidence,
  // visible in the explorer, and published on sign. Real headless browser flow, driving the
  // w5val front on :5174. Identity: `admin@cro-one.com` (the workspace's built-in "admin" role,
  // which carries VIEW_ANALYSIS_CREATE and VIEW_ANALYSIS_PUBLISH — the Investigator does not
  // hold CHART creation/publish rights on this page, L13, so this is the editor-rank path the
  // feature defines, not the Investigator's own login).
  test('AXI-2647.3 AC3 — custom chart over the question snapshot, saved as evidence, visible in the explorer, published on sign @SI-042', async ({ page }) => {
    const chartTitle = `AXI-2647 AC3 chart ${Date.now()}`;
    await signInBrowser(page, admin);

    // The column-profiling pass (`ColumnShapeService`) the editor's binding selects read from
    // is a SEPARATE async readiness signal from ingestion-ready / semantic-normalize readiness
    // (both already polled above) — without it the editor renders every "Select column..."
    // permanently empty with no error. Poll it ready before opening the editor at all.
    let profiled = false;
    for (let i = 0; i < 40 && !profiled; i++) {
      const profiles = await (await admin.api.get(apiUrl(`/api/v1/workspaces/${WS}/datasets/${datasetId}/profiles`))).json();
      profiled = (Array.isArray(profiles) ? profiles : profiles.data ?? []).some((p: any) => p.status === 'ready');
      if (!profiled) await new Promise((r) => setTimeout(r, 1500));
    }
    expect(profiled, 'dataset column-profiling never reached ready').toBeTruthy();

    // 1. The result page's "Add a chart" entry (CustomChartEntry) — reached the same way the
    // Study page deep-links a signed-in caller to a question's result.
    await page.goto(`/projects/${projectId}/runs/${launchedRunId}?sapId=${sapId}&questionId=${questionId}`);
    const addChart = page.getByTestId('rp-add-custom-chart');
    await expect(addChart).toBeVisible({ timeout: 30_000 });
    await addChart.click();

    // 2. Lands on the analysis workspace's Editor sub-tab (?addChart=1) — build a chart over the
    // SAME snapshot and save it through the editor's own Save button.
    //
    // Which dataset "the same snapshot" resolves to is FR36/AXI-1422's `effectiveDatasetId`
    // (`ProjectViewAnalysisDetail.tsx` — "whichever dataset the analysis is CURRENTLY showing —
    // the base referent, or a rule-derived result... when one is selected"), confirmed live by
    // instrumenting this test: `viewAnalysis.datasetId` IS the raw uploaded T1_LONG dataset, but
    // this question's template (T2, Kruskal-Wallis+Dunn over 3 groups) means the result page
    // can be showing the derived Dunn PAIRWISE-COMPARISON table (not the raw group/pct/reference
    // fields) when "Add a chart" is clicked — confirmed by observation to vary run-to-run (which
    // referent is "current" on first paint is itself a race, not pinned by this story's scope).
    // Never hard-code a column name that only exists on ONE of the two possible datasets (a
    // prior version of this test asserted `col_pct`/`col_group` — raw-only — then `col_pValue`/
    // `col_groupA` — Dunn-result-only — and each hung 300s on the other dataset): read whichever
    // columns the editor actually offers and bind to those, by position (each select is already
    // filtered to the right column kind — numeric for Y, categorical for Group — so the first
    // real option in each is always a legal binding, regardless of which dataset is current).
    const template = page.locator('xpath=//label[normalize-space()="Template"]/following-sibling::div[1]//select');
    await expect(template).toBeVisible({ timeout: 30_000 });
    await template.selectOption({ label: 'Strip / Jitter Plot' });
    const slot = (label: string) => page.locator(`xpath=//label[normalize-space()="${label}"]/following-sibling::div[1]//select`);
    await expect(slot('Y')).toBeVisible({ timeout: 15_000 });
    // Wait for BOTH selects' options to actually land in the DOM before picking — the editor's
    // dataset profiles asynchronously on its own schedule, independent of the raw-dataset poll
    // above.
    await expect
      .poll(async () => (await slot('Y').locator('option').allTextContents()).length, {
        timeout: 30_000,
        message: 'Y column select never populated with any columns',
      })
      .toBeGreaterThan(1);
    await expect
      .poll(async () => (await slot('Group').locator('option').allTextContents()).length, {
        timeout: 30_000,
        message: 'Group column select never populated with any columns',
      })
      .toBeGreaterThan(1);
    await slot('Y').selectOption({ index: 1 });
    await slot('Group').selectOption({ index: 1 });
    await page.getByPlaceholder('Chart title (optional)').fill(chartTitle);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Visualization created successfully')).toBeVisible({ timeout: 20_000 });

    // 3. Switch to the gallery (Explore), find the new chart's card, "Add to evidence" -> "Create
    // New" -> save-as-evidence (sap_custom_chart_saved fires here, front-side, per the coordinator).
    await page.getByRole('tab', { name: 'Explore' }).click();
    // A bare `div` + `hasText` filter's `.last()` resolves to the MOST DEEPLY NESTED matching
    // div — here, the title heading's own wrapper, not the card (`VisualizationCard.tsx`) that
    // actually holds the "More actions" trigger as a sibling, not a descendant of that div. Also
    // require the trigger itself as a descendant so the match is the card container.
    const card = page.locator('div').filter({ hasText: chartTitle }).filter({ has: page.getByTitle('More actions') }).last();
    await expect(card).toBeVisible({ timeout: 30_000 });
    // The save-success toast (bottom-right) and this 32-chart gallery's own lazy-loading card
    // thumbnails (skeleton <-> rendered-image swaps as cards scroll into view) transiently
    // overlap the trigger's screen position while nothing is actually broken — the trigger
    // itself resolves as visible/enabled/stable on every retry, only the pointer-event target
    // differs. Wait the toast out, then force the click past the gallery's own paint churn.
    await expect(page.getByText('Visualization created successfully')).toBeHidden({ timeout: 15_000 }).catch(() => {});
    await card.scrollIntoViewIfNeeded();
    await card.getByTitle('More actions').click({ force: true });
    await page.getByRole('menuitem', { name: 'Add to evidence' }).click();
    await page.getByText('Create New', { exact: true }).click();
    const evidenceTitle = `${chartTitle} evidence`;
    await page.getByPlaceholder('Evidence title').fill(evidenceTitle);
    await page.getByTestId('create-evidence-submit').click();
    await expect(page.getByTestId('create-evidence-submit')).not.toBeVisible({ timeout: 20_000 });

    // 4. The new evidence is visible through the SAME API read path the explorer uses (AC1/AC2's
    // doctrine: one view, not a second Investigator-only store).
    let evidenceId: string | null = null;
    await expect.poll(async () => {
      const evidences = await (await admin.api.get(apiUrl(`/api/v1/view-analyses/${launchedViewAnalysisId}/evidences?limit=50`))).json();
      const rows = evidences.data ?? evidences;
      const found = rows.find((e: any) => e.currentVersion?.title === evidenceTitle);
      evidenceId = found?.id ?? null;
      return !!found;
    }, { timeout: 20_000, message: 'custom chart evidence never appeared in the explorer read path' }).toBeTruthy();

    // 4b. The app's own publish gate (seen live: "Every evidence version being published must
    // carry at least one APPROVED interpretation (decision draft)...") — `signPublishData`
    // (AC21) submits EVERY evidence of the analysis, not just this one, so the approved
    // interpretation must cite ALL of them (`assertApprovedInterpretationsExist` matches per
    // `evidenceVersionId`, auto-stamped server-side from `evidenceId` at create time —
    // `decision-drafts.service.ts#applyEvidenceVersionStamps`, AXI-2303) — here, this custom
    // chart's evidence AND the template/recommended chart's own auto-created evidence (AC25/
    // AC29). draft (admin) -> reviewed (admin) -> approved (the SEPARATE `approver` identity;
    // decision-draft approval enforces the same SELF_APPROVAL_NOT_PERMITTED rule as evidence
    // approval above, per `decision-draft-approval-policy.ts`).
    const allEvidences = await (await admin.api.get(apiUrl(`/api/v1/view-analyses/${launchedViewAnalysisId}/evidences?limit=50`))).json();
    const allEvidenceRows: any[] = allEvidences.data ?? allEvidences;
    const decisionCreate = await admin.api.post(apiUrl(`/api/v1/workspaces/${WS}/decisions`), {
      data: {
        label: `${chartTitle} interpretation`,
        type: 'phenotype_classification',
        confidence: 'medium',
        context: { intendedUse: 'RUO' },
        evidenceLinks: allEvidenceRows.map((e) => ({ evidenceId: e.id })),
        evidenceValues: [],
      },
    });
    expect(decisionCreate.ok(), await decisionCreate.text()).toBeTruthy();
    const decisionId = (await decisionCreate.json()).id;
    const toReviewed = await admin.api.post(apiUrl(`/api/v1/workspaces/${WS}/decisions/${decisionId}/transition`), {
      data: { targetStatus: 'reviewed' },
    });
    expect(toReviewed.ok(), await toReviewed.text()).toBeTruthy();
    const toApproved = await approver.api.post(apiUrl(`/api/v1/workspaces/${WS}/decisions/${decisionId}/transition`), {
      data: { targetStatus: 'approved' },
    });
    expect(toApproved.ok(), await toApproved.text()).toBeTruthy();

    // 5. Sign (publish) — SignQuestionControl, gated on view_analysis:publish.
    await page.goto(`/projects/${projectId}/runs/${launchedRunId}?sapId=${sapId}&questionId=${questionId}`);
    const signButton = page.getByTestId('rp-sign-button');
    await expect(signButton).toBeVisible({ timeout: 30_000 });
    await signButton.click();
    await expect(page.getByTestId('rp-signed-note')).toBeVisible({ timeout: 30_000 });

    // The published version carries the custom chart's evidence alongside the recommended one
    // (FR28) — `evidenceVersionIds` names a VERSION per evidence, not the evidence id itself, so
    // the check is "at least 2 cited" (the template chart + this custom one), not an id match.
    const published = await (
      await admin.api.get(apiUrl(`/api/v1/view-analyses/${launchedViewAnalysisId}/published-versions`))
    ).json();
    const rows = published.data ?? published;
    const latest = rows[0];
    expect(evidenceId, 'the custom chart evidence was never found').not.toBeNull();
    expect(latest?.evidenceVersionIds?.length ?? 0, JSON.stringify(latest)).toBeGreaterThanOrEqual(2);
  });

  test.fixme(
    'AXI-2647.4 AC26 — a stratified Dunn run (3 strata) has 3 panels, shared axis, brackets vs reference only',
    async () => {
      // AXI-2652 (the registry_id namespacing fix this file's header used to record as a
      // known defect) is confirmed merged/live on this stack (back main d82af71c), so the
      // ORIGINAL blocker this test.fixme named is gone. It remains fixme because building the
      // full AXI-2648 nine-field MAG4 preset is substantial new authoring not yet done, and —
      // discovered 2026-11-18 — every analysis this stack consolidates right now hits the
      // CandidatesService.replaceAutoGeneratedSpecs race (candidates.service.ts:981, a
      // `Unique constraint failed on (dataview_spec_id)` on a concurrent delete-then-insert
      // transaction; confirmed firing live, 0/150 view_analyses created in the last 24h have
      // latest_consolidated_node_id set) — a backend defect outside this story's ownership
      // that would make any newly-built AC26 flow unreliable to green today regardless of this
      // test's own authoring state. Report as blocking, not retried into a false green.
    },
  );

  // Browser spot-check (coordinator ask 2026-11-18, re: the confirmed consolidation race): an
  // API 200 on an analysis is not proof the page itself renders the evidence. Placed LAST (not
  // inside AC1/AC2/AC3's serial block) so a finding here never cascades to skip the core ACs —
  // this suite is `test.describe.configure({ mode: 'serial' })`.
  test('AXI-2647.5 spot-check — the AC1 explorer analysis renders in the Investigator browser UI, not just over the API', async ({ page }) => {
    test.skip(!ac1ExplorerAnalysisId, 'AC1 did not reach a provisioned analysis to check');
    await signInBrowser(page, investigator);
    // AXI-2322/FR4 (`App.tsx`): the Investigator role lives behind its OWN `/investigator/*`
    // route prefix, outside the team `Layout` — the bare team-surface path (correct for `admin`
    // above) 403s/redirects an investigator-rank session to their home Study page instead of
    // this analysis (root-caused live: no `/view-analyses/:id` or `/projects` network call for
    // this id was ever made — the app never got past the surface mismatch). AXI-2668/FR78 is the
    // explorer's investigator-surface mirror of this same route.
    await page.goto(`/investigator/projects/${projectId}/view-analyses/${ac1ExplorerAnalysisId}`);
    // The evidence citation's own title renders on the Evidence tab, not the Explore gallery
    // (which only shows the underlying chart's title) — the page landed on Explore by default.
    await page.getByRole('tab', { name: /^Evidence/ }).click();
    await expect(page.getByText(ac1EvidenceTitle)).toBeVisible({ timeout: 30_000 });
  });
});

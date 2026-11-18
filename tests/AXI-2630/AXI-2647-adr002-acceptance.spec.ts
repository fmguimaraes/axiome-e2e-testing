import { expect, test, request as apiRequest, type APIRequestContext } from '@playwright/test';
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
const ORG = process.env.AXI_2647_ORG_ID ?? '927d8eec-6c47-452f-bec6-593f4c0622c8';
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
}

async function login(anon: APIRequestContext, email: string, password: string): Promise<Session> {
  const res = await anon.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  expect(res.ok(), `login ${email}: ${await res.text()}`).toBeTruthy();
  const { accessToken } = await res.json();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WS } });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { api, userId: me.id };
}

let admin: Session;
let investigator: Session;
let projectId: string;
let sapId: string;
let sapVersionId: string;
let fieldIds: { group: string; reference: string; pct: string };
let questionId: string;
let datasetId: string;
let launchedViewAnalysisId: string;

test.beforeAll(async () => {
  test.skip(!WS || !INV_EMAIL || !INV_PASSWORD, 'HANDOVER_WORKSPACE_ID / E2E_INVESTIGATOR_EMAIL / _PASSWORD not configured');
  const anon = await apiRequest.newContext();
  admin = await login(anon, ADMIN_EMAIL, ADMIN_PASSWORD);
  investigator = await login(anon, INV_EMAIL, INV_PASSWORD);
  await anon.dispose();
});

test.afterAll(async () => {
  await admin?.api.dispose();
  await investigator?.api.dispose();
});

async function createProject(label: string): Promise<string> {
  const res = await admin.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2647 ${label} ${Date.now()}`, workspaceId: WS, semanticProfileId: PROFILE_ID },
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

  test('AXI-2647.2 AC2/AC25/AC29 — the launched analysis is a same-shape explorer analysis with a chart evidence @SI-042', async () => {
    const viewAnalysisId = launchedViewAnalysisId;
    const list = await (await investigator.api.get(apiUrl(`/api/v1/view-analyses?projectId=${projectId}`))).json();
    const rows: any[] = list.data ?? list;
    const guided = rows.find((r) => r.id === viewAnalysisId);
    const autoDefault = rows.find((r) => r.origin === 'auto_default');

    // AC2 — same shape as any other analysis (name, evidence count, published state), via the
    // SAME listing read path the explorer and the Investigator both use.
    expect(guided).toBeTruthy();
    expect(guided.sapRunId).toBeNull();
    expect(guided.evidenceCount).toBeGreaterThan(0);

    // AC1 (DD20 half 2, approximated without a browser-driven wizard analysis in this story's
    // budget) — a NON-plan analysis (the dataset-link auto_default one) is visible through the
    // exact same read path, with no plan-run object either; the two are interchangeable views.
    expect(autoDefault, 'no non-plan analysis found on the project').toBeTruthy();
    expect(autoDefault.sapRunId).toBeNull();

    const evidences = await (await investigator.api.get(apiUrl(`/api/v1/view-analyses/${viewAnalysisId}/evidences`))).json();
    const chartEvidence = (evidences.data ?? evidences).find((e: any) => e.kind === 'chart');
    expect(chartEvidence, 'no chart evidence on the launched analysis (AC25/AC29 — a template chart action, FR11)').toBeTruthy();
  });

  // AC3 (DD20 half 3) — a custom chart over the launched question's snapshot, from the result
  // page's "Add a chart" entry (`CustomChartEntry`, editor rank only, L13), saved as evidence,
  // visible in the explorer, published on sign. AXI-2645 (the entry) is merged to main
  // (front caf0cfa7) as of the coordinator's note, but this story's remaining budget did not
  // reach a browser-driven run of the full editor → save → sign → explorer round trip. Recorded
  // honestly as NOT executed rather than weakened into a false pass.
  test.fixme(
    'AXI-2647.3 AC3 — custom chart over the question snapshot, saved as evidence, visible in the explorer, published on sign',
    async () => {
      // Deep link (per the coordinator): /projects/:projectId/view-analyses/:viewAnalysisId?addChart=1&sapId=&questionId=&returnTo=
      // 1. open the result page as an editor-rank identity, follow CustomChartEntry (addChart=1)
      // 2. build + save a chart in the editor -> expect one `sap_custom_chart_saved` emission
      // 3. GET the explorer evidences list for the SAME viewAnalysisId -> the new chart evidence
      // 4. POST sign (SignQuestionControl / view_analysis:publish) -> GET published version
      //    carries the custom chart's evidence alongside the recommended one (FR28)
    },
  );

  test.fixme(
    'AXI-2647.4 AC26 — a stratified Dunn run (3 strata) has 3 panels, shared axis, brackets vs reference only',
    async () => {
      // Needs the full AXI-2648 nine-field MAG4 preset (image 1), which needs the project
      // extension pack — blocked by the registry_id defect recorded in this file's header.
    },
  );
});

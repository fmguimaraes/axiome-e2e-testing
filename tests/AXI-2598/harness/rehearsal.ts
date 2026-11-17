/**
 * AXI-2601 (epic AXI-2598 — feature §7.1 steps 2–10 over the API, FR3 `rehearsal`, FR5, FR6,
 * FR11, FR12, NFR8) — the bare API rehearsal, one function per step.
 *
 * Every step records the facts it observed into the {@link Ledger}. A PRODUCT defect never throws:
 * it is recorded (endpoint, request shape, response excerpt, suspected code location) and the step
 * goes on as far as the product lets it, so one run surfaces every defect after "Start run".
 * Only a HARNESS fault (unreachable environment, malformed preset, an unexpected shape the suite
 * cannot read) throws. Steps whose input an earlier step could not produce are BLOCKED, with the
 * blocking reason, never faked.
 *
 * No product code is changed by this suite; no LLM is called; no trace or video is recorded.
 */
import { randomUUID } from 'node:crypto';
import type { ApiResponse } from '../../AXI-2309/harness/prod-suite/api-client';
import type { HandoverConfig } from './config';
import { checkFile, type FileKind } from './files';
import { excerpt, type HandoverClient } from './http';
import type { Download, Ledger, StepRecord } from './report';
import { pollUntil, PollTimeoutError } from './poll';
import { csvFacts, expectedMapping, presetProblems, questionBody, sha256Hex, specificationBody, type Preset } from './preset';
import type { World } from './world';

export const UPLOAD_PREFIX = 'axi2601-handover-';
const INGESTION_TIMEOUT_MS = 6 * 60_000;
const RUN_TIMEOUT_MS = 15 * 60_000;
const RESULT_PAGE_TIMEOUT_MS = 3 * 60_000;
const COMPLETENESS_TIMEOUT_MS = 2 * 60_000;
const POLL_MS = 2_000;

export interface QuestionState {
  key: string;
  questionId: string | null;
  childRunId: string | null;
  childRunStatus: string | null;
  verdict: string | null;
  page: any | null;
  ruleRunIds: string[];
}

export interface Rehearsal {
  cfg: HandoverConfig;
  world: World;
  ledger: Ledger;
  preset: Preset;
  csvBytes: Buffer;
  token: string;
  projectId: string | null;
  sapId: string | null;
  planVersion: number | null;
  sapVersionId: string | null;
  fieldIdByName: Map<string, string>;
  questionIdByKey: Map<string, string>;
  datasetId: string | null;
  uploadedBytes: Buffer | null;
  ingestionId: string | null;
  linked: boolean;
  dataBindingId: string | null;
  sapRunId: string | null;
  sapRun: any | null;
  runStartedAt: number | null;
  questions: QuestionState[];
  signed: boolean;
  /** Why a later step is blocked (first upstream cause), keyed by what is missing. */
  blocked: Record<string, string>;
}

export function newRehearsal(cfg: HandoverConfig, world: World, ledger: Ledger, preset: Preset, csvBytes: Buffer, token: string): Rehearsal {
  return {
    cfg, world, ledger, preset, csvBytes, token,
    projectId: null, sapId: null, planVersion: null, sapVersionId: null,
    fieldIdByName: new Map(), questionIdByKey: new Map(),
    datasetId: null, uploadedBytes: null, ingestionId: null, linked: false, dataBindingId: null,
    sapRun: null, sapRunId: null, runStartedAt: null,
    questions: preset.questions.map((q) => ({ key: q.key, questionId: null, childRunId: null, childRunStatus: null, verdict: null, page: null, ruleRunIds: [] })),
    signed: false, blocked: {},
  };
}

const ws = (r: Rehearsal) => `/api/v1/workspaces/${r.world.workspaceId}`;
const proj = (r: Rehearsal) => `/api/v1/projects/${r.projectId}`;
const sap = (r: Rehearsal) => `${proj(r)}/saps/${r.sapId}`;

/** Request-shape text for a defect record: method, path with ids, body keys only (never values). */
function shape(method: string, path: string, body?: unknown): string {
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? ` body keys {${Object.keys(body as object).join(', ')}}` : '';
  return `\`${method} ${path}\`${keys}`;
}

function got(res: ApiResponse): string {
  return `HTTP ${res.status} ${excerpt(res.body, 500)}`;
}

/** Wrap a step body: elapsed time, and a harness fault becomes a `fail` with its message. */
export async function runStep(r: Rehearsal, step: StepRecord, body: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await body();
    if (step.status === 'pass' && step.defectIds.length > 0) step.status = 'fail';
  } catch (err) {
    step.status = 'fail';
    step.facts.push(`harness stopped: ${(err as Error).message}`);
    throw err;
  } finally {
    step.elapsedMs = Date.now() - started;
  }
}

export function block(r: Rehearsal, step: StepRecord, needs: string[]): string | null {
  const missing = needs.filter((n) => r.blocked[n]);
  if (missing.length === 0) return null;
  step.status = 'blocked';
  const reason = `blocked: ${missing.map((n) => `${n} — ${r.blocked[n]}`).join('; ')}`;
  step.facts.push(reason);
  return reason;
}

// ─── S1 — preset against the data file (FR12, EC6, EC7) ────────────────────────────────

export async function checkPreset(r: Rehearsal, step: StepRecord): Promise<string[]> {
  const facts = csvFacts(r.csvBytes.toString('utf8'));
  const problems = presetProblems(r.preset, facts, sha256Hex(r.csvBytes));
  step.facts.push(`${facts.rows} rows × ${facts.header.length} columns; ${r.preset.dataSpecification.fields.length} spec fields; ${r.preset.questions.length} questions`);
  const blanks = Object.entries(facts.blanks).filter(([, n]) => n > 0).map(([c, n]) => `${c}=${n}`);
  step.facts.push(`blank cells: ${blanks.join(', ') || 'none'} (EC4)`);
  for (const p of problems) step.facts.push(`refused: ${p}`);
  return problems;
}

// ─── S2 — sign-in, surface, rights (FR4, NFR8) ─────────────────────────────────────────

export async function signIn(r: Rehearsal, step: StepRecord): Promise<void> {
  const surface = await r.world.investigator.get('/api/v1/surface');
  step.facts.push(`GET surface -> ${surface.status} ${excerpt(surface.body, 80)}`);
  if (surface.status !== 200 || surface.body?.surface !== 'investigator') {
    r.ledger.defect(step, {
      code: 'surface-not-investigator', title: 'Investigator identity is not routed to the investigator surface', endpoint: 'GET /api/v1/surface',
      request: shape('GET', '/api/v1/surface'), observed: got(surface), expected: '200 {surface: "investigator"}',
      suspectedLocation: 'axiome-back apps/gateway (surface endpoint, isInvestigatorMembership)', severity: 'blocker',
    });
  }
  const members = (await r.world.investigator.get(`${ws(r)}`)).body?.members ?? [];
  const mine = members.find((m: any) => m.userId === r.world.investigatorUserId);
  step.facts.push(`investigator membership roleId ${mine?.roleId ?? 'unknown'}`);
  const probe = await r.world.investigator.post('/api/v1/projects', { name: `${UPLOAD_PREFIX}rights-probe-${r.token}`, workspaceId: r.world.workspaceId });
  step.facts.push(`investigator POST /projects -> ${probe.status} (expected refusal: project creation is outside the Investigator role, AXI-2322)`);
  if (probe.status < 300) {
    r.ledger.defect(step, {
      code: 'investigator-created-project', title: 'Investigator could create a project', endpoint: 'POST /api/v1/projects',
      request: shape('POST', '/api/v1/projects', { name: '', workspaceId: '' }), observed: got(probe), expected: '403 (InvestigatorDenyGuard)',
      suspectedLocation: 'axiome-back apps/gateway/src/proxy/projects.controller.ts create()', severity: 'major',
    });
    // FR6: never leave the probe's project behind — delete it as the investigator, else the provisioner.
    const probeId = probe.body?.id ? String(probe.body.id) : null;
    let removed = false;
    let note = 'created by the rights probe — no id in the response, cannot be deleted';
    if (probeId) {
      const tries: Array<[string, HandoverClient]> = [['investigator', r.world.investigator]];
      if (r.world.provisioner) tries.push(['provisioner', r.world.provisioner]);
      note = 'created by the rights probe — delete refused:';
      for (const [who, client] of tries) {
        const del = await client.delete(`/api/v1/projects/${probeId}`);
        step.facts.push(`rights-probe project DELETE as ${who} -> ${del.status}`);
        if (del.status >= 200 && del.status < 300) {
          removed = true;
          note = `created by the rights probe — deleted by the ${who}`;
          break;
        }
        note += ` ${who} ${got(del)};`;
      }
    }
    r.ledger.residue({ kind: 'project (rights probe)', id: probeId ?? 'unknown', removed, note });
  }
}

// ─── S3 — leftovers of a crashed run (EC1, FR6) ────────────────────────────────────────

export async function sweepLeftovers(r: Rehearsal, step: StepRecord): Promise<void> {
  const res = await r.world.investigator.get(`${ws(r)}/datasets?limit=1000`);
  const rows: any[] = Array.isArray(res.body?.data) ? res.body.data : Array.isArray(res.body) ? res.body : [];
  const mine = rows.filter((d) => String(d.originalFilename ?? '').startsWith(UPLOAD_PREFIX) && d.uploadedBy === r.world.investigatorUserId);
  step.facts.push(`${rows.length} dataset(s) in the workspace; ${mine.length} leftover(s) of this suite`);
  for (const d of mine) {
    const del = await r.world.investigator.delete(`${ws(r)}/datasets/${d.id}`);
    const removed = del.status >= 200 && del.status < 300;
    r.ledger.residue({ kind: 'dataset (leftover of an earlier run)', id: d.id, removed, note: removed ? 'deleted at start (EC1)' : `delete refused: ${got(del)}` });
    step.facts.push(`leftover ${d.id}: ${removed ? 'deleted' : `NOT deleted (${del.status})`}`);
  }
}

// ─── S4 — provision: project, protocol, declared plan, finalise (FR10, FR11) ───────────

export async function provision(r: Rehearsal, step: StepRecord): Promise<void> {
  const inv = r.world.investigator;
  if (!r.world.provisioner) {
    step.status = 'blocked';
    r.blocked.project = 'no provisioning identity configured (HANDOVER_PROVISIONER_EMAIL / _PASSWORD); an Investigator cannot create a project';
    step.facts.push(r.blocked.project);
    return;
  }
  const name = `E2E AXI-2601 handover rehearsal ${r.token}`;
  const created = await r.world.provisioner.post('/api/v1/projects', { name, workspaceId: r.world.workspaceId });
  if (created.status !== 201) {
    step.status = 'fail';
    r.blocked.project = `project creation refused (${created.status})`;
    step.facts.push(`POST /projects -> ${got(created)}`);
    return;
  }
  r.projectId = String(created.body.id);
  r.ledger.residue({ kind: 'project', id: r.projectId, removed: false, note: `"${name}" — kept as the run's evidence (results, review, sign-off)` });
  step.facts.push(`project ${r.projectId} created by the provisioning identity`);
  const readable = await inv.get(proj(r));
  if (readable.status !== 200) {
    r.ledger.defect(step, {
      code: 'investigator-cannot-read-new-project', title: 'Investigator cannot open the project created for him', endpoint: 'GET /api/v1/projects/:id',
      request: shape('GET', '/api/v1/projects/:id'), observed: got(readable), expected: '200',
      suspectedLocation: 'axiome-back ProjectAccessGuard / project visibility default', severity: 'blocker',
    });
    r.blocked.project = 'investigator cannot read the new project';
    return;
  }

  // Protocol first (owner ruling 2026-11-15: protocol FIRST, then questions).
  const p = r.preset.protocol;
  const protocol = await inv.put(`${proj(r)}/study/protocol`, { title: p.title, objective: p.objective, studyPopulation: p.studyPopulation, text: p.text });
  step.facts.push(`PUT study/protocol -> ${protocol.status}`);
  if (protocol.status >= 300) {
    r.ledger.defect(step, {
      code: 'protocol-save-refused', title: 'Investigator cannot save the study protocol', endpoint: 'PUT /api/v1/projects/:p/study/protocol',
      request: shape('PUT', '/api/v1/projects/:p/study/protocol', { title: 1, objective: 1, studyPopulation: 1, text: 1 }), observed: got(protocol),
      expected: '200 SapProtocolRecord', suspectedLocation: 'axiome-back apps/organization-service/src/sap/protocol/', severity: 'blocker',
    });
  }

  // Catalog: every pin must resolve; record whether it is the newest (non-newest pin acceptance is an open fact).
  const catalog = await inv.get(`${proj(r)}/sap-templates`);
  const entries: any[] = Array.isArray(catalog.body) ? catalog.body : [];
  for (const q of r.preset.questions) {
    const e = entries.find((x) => x.templateId === q.template.templateId && x.templateVersion === q.template.templateVersion);
    const newest = entries.find((x) => x.templateId === q.template.templateId && x.isNewest);
    step.facts.push(`${q.key}: ${q.template.templateId}@${q.template.templateVersion} ${e ? 'resolves' : 'DOES NOT RESOLVE'}${newest ? ` (newest ${newest.templateVersion})` : ''}`);
    if (!e) {
      r.ledger.defect(step, {
        code: `template-pin-unresolved-${q.template.templateId}`, title: `Pinned template ${q.template.templateId}@${q.template.templateVersion} is not in the project catalog`,
        endpoint: 'GET /api/v1/projects/:p/sap-templates', request: shape('GET', '/api/v1/projects/:p/sap-templates'),
        observed: `catalog lists ${entries.filter((x) => x.templateId === q.template.templateId).map((x) => x.templateVersion).join(', ') || 'nothing'}`,
        expected: 'the pinned version listed', suspectedLocation: 'axiome-back sap-finalise.controller sap-templates / template registry', severity: 'blocker',
      });
    }
  }

  // Draft (schemaVersion 2, declared), title + population + specification.
  const started = await inv.post(`${proj(r)}/saps/draft`, { planSchemaVersion: 2 });
  if (started.status !== 201) {
    r.ledger.defect(step, {
      code: 'draft-start-refused', title: 'Investigator cannot start a declared (v2) plan draft', endpoint: 'POST /api/v1/projects/:p/saps/draft',
      request: shape('POST', '/api/v1/projects/:p/saps/draft', { planSchemaVersion: 2 }), observed: got(started), expected: '201 SapDraftRecord (schemaVersion 2)',
      suspectedLocation: 'axiome-back apps/organization-service/src/sap/drafts/sap-draft.service.ts', severity: 'blocker',
    });
    r.blocked.plan = 'draft could not be started';
    return;
  }
  r.sapId = String(started.body.sapId);
  let draft = started.body;
  step.facts.push(`draft ${draft.draftId} on SAP ${r.sapId}, plan schemaVersion ${draft.plan?.schemaVersion}, specificationSource ${draft.plan?.specificationSource}`);
  const saved = await inv.put(`${sap(r)}/draft`, {
    basedOnRevision: draft.revision, title: r.preset.plan.title, studyPopulation: r.preset.plan.studyPopulation, dataSpecification: specificationBody(r.preset),
  });
  if (saved.status !== 200) {
    r.ledger.defect(step, {
      code: 'draft-specification-refused', title: 'Declared data specification refused', endpoint: 'PUT /api/v1/projects/:p/saps/:sapId/draft',
      request: shape('PUT', '/api/v1/projects/:p/saps/:sapId/draft', { basedOnRevision: 1, title: 1, studyPopulation: 1, dataSpecification: 1 }),
      observed: got(saved), expected: '200 with server-assigned fieldIds', suspectedLocation: 'libs/contracts sap-draft.contract.ts dataSpecification parse', severity: 'blocker',
    });
    r.blocked.plan = 'specification refused';
    return;
  }
  draft = saved.body;
  for (const f of draft.plan?.dataSpecification?.fields ?? []) r.fieldIdByName.set(f.name, f.fieldId);
  step.facts.push(`${r.fieldIdByName.size} spec field(s) stored with fieldIds`);

  for (const q of r.preset.questions) {
    const body = { basedOnRevision: draft.revision, analysisDatasetId: null, question: questionBody(q, r.fieldIdByName) };
    const added = await inv.post(`${sap(r)}/draft/questions`, body);
    if (added.status !== 201) {
      r.ledger.defect(step, {
        code: `question-add-refused-${q.template.templateId}`, title: `Question ${q.key} (${q.template.templateId}@${q.template.templateVersion}) refused`,
        endpoint: 'POST /api/v1/projects/:p/saps/:sapId/draft/questions', request: shape('POST', '…/draft/questions', body),
        observed: got(added), expected: '201 SapDraftQuestionAdded', suspectedLocation: 'libs/contracts sap-draft.contract.ts / sap-plan-v2.contract.ts question parse', severity: 'blocker',
      });
      continue;
    }
    draft = added.body;
    r.questionIdByKey.set(q.key, String(added.body.addedQuestionId));
  }
  for (const qs of r.questions) qs.questionId = r.questionIdByKey.get(qs.key) ?? null;
  step.facts.push(`${r.questionIdByKey.size}/${r.preset.questions.length} question(s) added in preset order`);
  if (r.questionIdByKey.size !== r.preset.questions.length) {
    r.blocked.plan = 'not every preset question could be added';
    return;
  }

  // CC7 counts an EXPLORATORY question's position in the confirmatory gap check, although its own
  // contract says exploratory positions order display only. The feature §10 order (exploratory
  // heatmap first) therefore cannot be finalised. Record it, then — so the chain after finalise
  // can still be rehearsed — renumber: confirmatory questions 1..n in preset order, exploratory after.
  let expectedOrder = r.preset.questions.map((q) => q.key);
  const firstCheck = (await inv.get(`${sap(r)}/draft/completeness`)).body;
  const cc7Gap = (firstCheck?.results ?? []).find((x: any) => x.checkId === 'CC7' && x.status === 'fail' && /have a gap/.test(String(x.message)));
  if (cc7Gap) {
    r.ledger.defect(step, {
      code: 'cc7-exploratory-position-gap', title: 'An exploratory question placed first makes the plan unfinalisable (CC7 counts its position)',
      endpoint: 'GET /api/v1/projects/:p/saps/:sapId/draft/completeness', request: shape('GET', '…/draft/completeness'),
      observed: `CC7 fail: ${cc7Gap.message} (positions are assigned in add order: Q1 exploratory = 1, Q2 primary = 2, Q3/Q4 secondary = 3, 4); finalise answers 422 SAP_INCOMPLETE`,
      expected: 'exploratory positions order display only (CC7 header, FR10 of AXI-2433): confirmatory positions are ranked among confirmatory questions, so the feature §10 order (heatmap first) finalises',
      suspectedLocation: 'axiome-back apps/organization-service/src/sap-decision/completeness/checks/cc7-position-ordering.ts evaluateCc7 (gap check on raw positions); sap/drafts/sap-draft-plan.ts nextQuestionPosition',
      severity: 'major',
    });
    const confirmatory = r.preset.questions.filter((q) => q.role !== 'exploratory');
    const exploratory = r.preset.questions.filter((q) => q.role === 'exploratory');
    expectedOrder = [...confirmatory, ...exploratory].map((q) => q.key);
    const positions = expectedOrder.map((key, i) => ({ questionId: r.questionIdByKey.get(key) as string, position: i + 1 }));
    const moved = await inv.put(`${sap(r)}/draft`, { basedOnRevision: draft.revision, positions });
    step.facts.push(`workaround: renumbered positions ${expectedOrder.join(', ')} -> ${moved.status}`);
    if (moved.status !== 200) throw new Error(`CC7 workaround: PUT positions -> ${got(moved)}`);
    draft = moved.body;
  }

  // Completeness: wait for a report with no failing check; record what fails.
  let failing: string[] = [];
  try {
    await pollUntil({
      what: 'draft completeness', timeoutMs: COMPLETENESS_TIMEOUT_MS, intervalMs: POLL_MS,
      read: async () => (await inv.get(`${sap(r)}/draft/completeness`)).body,
      done: (rep: any) => {
        failing = (rep?.results ?? []).filter((x: any) => x.status === 'fail').map((x: any) => `${x.checkId}: ${x.message}`);
        return Array.isArray(rep?.results) && failing.length === 0;
      },
    });
    step.facts.push('completeness: no failing check');
  } catch (err) {
    r.ledger.defect(step, {
      code: 'completeness-fails', title: 'Completeness never clears for the preset plan', endpoint: 'GET /api/v1/projects/:p/saps/:sapId/draft/completeness',
      request: shape('GET', '…/draft/completeness'), observed: failing.join(' | ') || (err as Error).message, expected: 'no failing check (the preset is complete)',
      suspectedLocation: 'axiome-back apps/organization-service/src/sap/finalise/sap-draft-completeness.evaluator.ts (SI-071)', severity: 'blocker',
    });
  }

  // FR11 — zero bindings at finalise.
  const before = await inv.get(`${sap(r)}/data-bindings`);
  const bindingsBefore = Array.isArray(before.body) ? before.body.length : -1;
  step.facts.push(`data bindings before finalise: ${bindingsBefore}`);
  if (bindingsBefore !== 0) throw new Error(`FR11: provisioning refused — the plan has ${bindingsBefore} data binding(s) before finalise`);
  const fin = await inv.post(`${sap(r)}/draft/finalise`, { basedOnRevision: draft.revision, basedOnVersion: null });
  if (fin.status !== 201) {
    r.ledger.defect(step, {
      code: 'finalise-refused', title: 'Finalise of the preset plan refused', endpoint: 'POST /api/v1/projects/:p/saps/:sapId/draft/finalise',
      request: shape('POST', '…/draft/finalise', { basedOnRevision: 1, basedOnVersion: null }), observed: got(fin), expected: '201 version 1',
      suspectedLocation: 'axiome-back apps/organization-service/src/sap/finalise/sap-finalise.service.ts', severity: 'blocker',
    });
    r.blocked.plan = 'finalise refused';
    return;
  }
  const versions = await inv.get(`${sap(r)}/versions`);
  const list: any[] = Array.isArray(versions.body) ? versions.body : versions.body?.data ?? [];
  const v1 = list.find((v) => v.version === 1) ?? fin.body;
  r.planVersion = Number(v1.version);
  r.sapVersionId = String(v1.sapVersionId);
  const facts = `version ${v1.version}, status ${v1.status}, plan.schemaVersion ${v1.plan?.schemaVersion}, planTiming ${v1.planTiming}, analysisDatasetId ${v1.analysisDatasetId}`;
  step.facts.push(`finalised: ${facts}`);
  // FR11 — provisioning FAILS (not warns) when any of these does not hold.
  const fr11: string[] = [];
  if (v1.version !== 1) fr11.push(`version ${v1.version} ≠ 1`);
  if (v1.status !== 'final') fr11.push(`status ${v1.status} ≠ final`);
  if (v1.plan?.schemaVersion !== 2) fr11.push(`schemaVersion ${v1.plan?.schemaVersion} ≠ 2`);
  if (v1.planTiming !== 'before_data') fr11.push(`planTiming ${v1.planTiming} ≠ before_data`);
  const after = await inv.get(`${sap(r)}/data-bindings`);
  if (!Array.isArray(after.body) || after.body.length !== 0) fr11.push(`data bindings after finalise: ${Array.isArray(after.body) ? after.body.length : after.status}`);
  const order = [...(v1.plan?.questions ?? [])].sort((a: any, b: any) => a.position - b.position).map((q: any) => q.text);
  const want = expectedOrder.map((k) => r.preset.questions.find((q) => q.key === k)!.text);
  if (order.join('\n') !== want.join('\n')) fr11.push(`question order differs from ${expectedOrder.join(', ')} (FR21)`);
  if (fr11.length > 0) {
    r.blocked.plan = `FR11 provisioning check failed: ${fr11.join('; ')}`;
    throw new Error(r.blocked.plan);
  }
}

// ─── S5 — upload, ingestion, link (§7.1 step 3; EC1) ───────────────────────────────────

interface UploadAttempt {
  status: number;
  body: any;
  datasetId: string | null;
}

async function uploadBytes(r: Rehearsal, filename: string, bytes: Buffer): Promise<UploadAttempt> {
  const inv = r.world.investigator;
  const init = await inv.post(`${ws(r)}/datasets`, { organizationId: r.world.organizationId, originalFilename: filename, contentType: 'text/csv' });
  if (init.status >= 300) return { status: init.status, body: init.body, datasetId: null };
  const id = String(init.body?.dataset?.id);
  const put = await fetch(String(init.body.presignedUrl), { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(bytes) });
  if (!put.ok) return { status: put.status, body: { message: `presigned PUT -> ${put.status}` }, datasetId: id };
  const fin = await inv.patch(`${ws(r)}/datasets/${id}/finalize`);
  return { status: fin.status, body: fin.body, datasetId: id };
}

const duplicateOf = (a: UploadAttempt): string | null =>
  a.status === 409 && (a.body?.code === 'DUPLICATE_DATASET_CONTENT' || a.body?.errorCode === 'DUPLICATE_DATASET_CONTENT')
    ? String(a.body?.details?.existingDatasetId ?? '')
    : null;

/** The preset bytes with one trailing per-run column — the same table, a different content hash. */
export function saltedVariant(bytes: Buffer, token: string): Buffer {
  const lines = bytes.toString('utf8').replace(/\n$/, '').split('\n');
  return Buffer.from(`${lines.map((l, i) => `${l},${i === 0 ? 'axi2601_rehearsal_run' : token}`).join('\n')}\n`, 'utf8');
}

export async function upload(r: Rehearsal, step: StepRecord): Promise<void> {
  const filename = `${UPLOAD_PREFIX}${r.token}-final_tableau2_synthetic.csv`;
  const t0 = Date.now();
  let attempt = await uploadBytes(r, filename, r.csvBytes);
  let bytes = r.csvBytes;
  const dup = duplicateOf(attempt);
  if (dup) {
    const existing = await r.world.investigator.get(`${ws(r)}/datasets/${dup}`);
    const ours = String(existing.body?.originalFilename ?? '').startsWith(UPLOAD_PREFIX);
    step.facts.push(`exact preset file refused as duplicate of ${dup} (${ours ? 'a leftover of this suite' : `NOT this suite's: "${existing.body?.originalFilename}"`})`);
    if (!ours) {
      r.ledger.defect(step, {
        code: 'duplicate-of-foreign-dataset', title: 'The data file cannot be uploaded to a new study: the workspace already holds the same bytes in another study',
        endpoint: 'PATCH /api/v1/workspaces/:ws/datasets/:id/finalize',
        request: `${shape('POST', '/api/v1/workspaces/:ws/datasets', { organizationId: 1, originalFilename: 1, contentType: 1 })} → presigned PUT (exact preset bytes) → \`PATCH …/finalize\``,
        observed: got(attempt),
        expected: 'the investigator can bring the same file into a second study of his workspace (or is offered to link the existing upload) — the Study page upload of FR13 has no such path',
        suspectedLocation: 'axiome-back apps/organization-service/src/datasets/datasets.service.ts finalizeUpload → findDuplicateByContentHash (AXI-2538, workspace-scoped); axiome-front src/lib/investigatorUploads/uploads.ts uploadFile',
        severity: 'minor',
      });
    }
    bytes = saltedVariant(r.csvBytes, r.token);
    step.facts.push('fallback: uploading the same table with one trailing per-run column (axi2601_rehearsal_run) — every preset column and value unchanged');
    attempt = await uploadBytes(r, filename, bytes);
  }
  if (attempt.status >= 300 || !attempt.datasetId) {
    r.ledger.defect(step, {
      code: 'upload-refused', title: 'Upload of the data file refused', endpoint: 'POST/PATCH /api/v1/workspaces/:ws/datasets[/:id/finalize]',
      request: 'initiate → presigned PUT → finalize', observed: got({ status: attempt.status, body: attempt.body }), expected: '2xx, dataset available',
      suspectedLocation: 'axiome-back apps/organization-service/src/datasets/datasets.service.ts', severity: 'blocker',
    });
    r.blocked.dataset = `upload refused (${attempt.status})`;
    return;
  }
  r.datasetId = attempt.datasetId;
  r.uploadedBytes = bytes;
  r.ledger.residue({ kind: 'dataset', id: r.datasetId, removed: false, note: `uploaded by the investigator (${bytes.length} bytes)` });
  r.ledger.timing('upload (initiate → finalize)', Date.now() - t0);
  step.facts.push(`dataset ${r.datasetId} available (${bytes.length} bytes)`);

  // Ingestion — asynchronous, auto-started by finalize; bounded poll.
  let latest: any = null;
  try {
    const out = await pollUntil({
      what: 'ingestion', timeoutMs: INGESTION_TIMEOUT_MS, intervalMs: POLL_MS,
      read: async () => {
        latest = (await r.world.investigator.get(`${ws(r)}/datasets/${r.datasetId}`)).body?.latestIngestion ?? null;
        return latest;
      },
      done: (l: any) => l?.status === 'ready',
      fatal: (l: any) => (l?.status === 'failed' ? `ingestion failed: ${l.errorCode ?? ''} ${l.errorMessage ?? ''}` : null),
    });
    r.ingestionId = String(out.value.id);
    r.ledger.timing('ingestion (finalize → ready)', out.elapsedMs);
    step.facts.push(`ingestion ${r.ingestionId} ready in ${(out.elapsedMs / 1000).toFixed(1)} s; rows ${out.value.rowCount ?? '?'}, columns ${out.value.columnCount ?? '?'}`);
  } catch (err) {
    r.ledger.timing('ingestion (finalize → ready)', err instanceof PollTimeoutError ? err.elapsedMs : null);
    r.ledger.defect(step, {
      code: 'ingestion-not-ready', title: 'Ingestion of the uploaded file never became ready', endpoint: 'GET /api/v1/workspaces/:ws/datasets/:id (latestIngestion)',
      request: shape('GET', '/api/v1/workspaces/:ws/datasets/:id'), observed: `${(err as Error).message}; last ${excerpt(latest, 300)}`,
      expected: `status ready within ${INGESTION_TIMEOUT_MS / 60_000} min`, suspectedLocation: 'axiome-back ingestion pipeline / axiome-bio-compute profiling', severity: 'blocker',
    });
    r.blocked.ingestion = 'ingestion not ready';
    return;
  }

  if (!r.projectId) {
    step.facts.push('link to study: skipped (no project)');
    return;
  }
  const link = await r.world.investigator.post(`${proj(r)}/datasets`, { datasetId: r.datasetId });
  step.facts.push(`POST projects/:p/datasets -> ${link.status}`);
  if (link.status >= 300) {
    r.ledger.defect(step, {
      code: 'link-refused', title: 'Investigator cannot link his upload to the study', endpoint: 'POST /api/v1/projects/:p/datasets',
      request: shape('POST', '/api/v1/projects/:p/datasets', { datasetId: 1 }), observed: got(link), expected: '2xx (OwnUploadLinkGuard admits his own upload)',
      suspectedLocation: 'axiome-back apps/gateway/src/proxy/projects.controller.ts linkDataset / OwnUploadLinkGuard', severity: 'blocker',
    });
    r.blocked.link = 'link refused';
    return;
  }
  r.linked = true;
}

// ─── S6 — mapping proposal + confirm (FR5, FR12, FR14 API half) ────────────────────────

export async function mapping(r: Rehearsal, step: StepRecord): Promise<void> {
  const inv = r.world.investigator;
  const q = `datasetVersionId=${r.ingestionId}`;
  const propose = () => inv.get(`${sap(r)}/versions/${r.planVersion}/data-binding-proposal?${q}`);
  let prop = await propose();
  if (prop.status !== 200) {
    r.ledger.defect(step, {
      code: 'proposal-refused', title: 'Mapping proposal refused', endpoint: 'GET /api/v1/projects/:p/saps/:sapId/versions/:v/data-binding-proposal',
      request: shape('GET', '…/versions/1/data-binding-proposal?datasetVersionId'), observed: got(prop), expected: '200 SapDataBindingProposal',
      suspectedLocation: 'axiome-back apps/organization-service/src/sap/bindings/sap-binding-proposals.ts', severity: 'blocker',
    });
    r.blocked.mapping = 'no proposal';
    return;
  }
  const blocksOf = (body: any): any[] => (body.conformance?.findings ?? []).filter((f: any) => f.severity === 'block');
  const describe = (body: any) => {
    const fields: any[] = body.fields ?? [];
    const notExact = fields.filter((f) => f.status !== 'proposed' || f.column !== f.name);
    const warns = (body.conformance?.findings ?? []).filter((f: any) => f.severity === 'warn');
    return { fields, notExact, blocks: blocksOf(body), warns };
  };
  let d = describe(prop.body);
  step.facts.push(`proposal: ${d.fields.length - d.notExact.length}/${d.fields.length} field(s) proposed by exact name; conformance ${prop.body.conformance?.status}; ${d.blocks.length} BLOCK, ${d.warns.length} WARN; ${(prop.body.columns ?? []).length} column(s) in the dataset version`);
  for (const w of d.warns) step.facts.push(`warn ${w.code}: ${w.message}`);

  // A declared grouping field whose file values are numeric codes (atteinte_pancreatique = 0/1)
  // measures as continuous: the profiler only calls a column categorical when most of its levels
  // are non-numeric, and only a dataset semantic declaration (governs_analysis_parameters — not an
  // Investigator right) can say otherwise. The plan's own declared field is not consulted.
  const groupingNames = new Set(r.preset.dataSpecification.fields.filter((f) => f.semanticRole !== 'continuous').map((f) => f.name));
  const codedGroups = [...new Set(d.blocks.filter((b: any) => (b.code === 'role_mismatch' || b.code === 'level_not_measured') && groupingNames.has(b.column)).map((b: any) => String(b.column)))];
  if (codedGroups.length > 0) {
    r.ledger.defect(step, {
      code: 'numeric-coded-grouping-not-bindable', title: 'A declared grouping field coded 0/1 in the file cannot be mapped: the column measures as continuous',
      endpoint: 'GET …/versions/:v/data-binding-proposal (conformance)', request: shape('GET', '…/data-binding-proposal?datasetVersionId'),
      observed: d.blocks.filter((b: any) => codedGroups.includes(b.column)).map((b: any) => `${b.code}: ${b.message}`).join(' | '),
      expected: `the plan declares ${codedGroups.join(', ')} as a grouping field with levels equal to the file values (FR12): conformance passes, or the Investigator is offered a way to confirm the role. Today only a dataset semantic declaration (PUT /discovery/datasets/:id/semantic-declaration, governs_analysis_parameters) can make the column a group, and the Investigator does not hold that right`,
      suspectedLocation: 'axiome-back sap/bindings/sap-binding-measured.ts measuredColumnsOf → guided-analysis/templates/opening/opening-template.columns.ts columnRolesOf/hasCategoricalLevels (numeric levels never categorical); sap-decision/conformance/binding-conformance.ts roleFindings/levelFindings',
      severity: 'blocker',
    });
    if (r.world.provisioner && r.datasetId) {
      // WORKAROUND (outside the Investigator path, recorded): the provisioning identity declares
      // the coded grouping columns on THIS run's dataset so the chain after mapping can be rehearsed.
      const bindings = codedGroups.map((name) => {
        const f = r.preset.dataSpecification.fields.find((x) => x.name === name)!;
        return { column: name, role: 'group', levels: [...(f.levels ?? [])], ...(f.controlLevels ? { controlLevels: [...f.controlLevels] } : {}) };
      });
      const declared = await r.world.provisioner.put(`/api/v1/discovery/datasets/${r.datasetId}/semantic-declaration`, { declaration: { scopeRoles: [], templateColumnBindings: bindings } });
      step.facts.push(`workaround: provisioning identity declared ${codedGroups.join(', ')} as group on this run's dataset -> ${declared.status}${declared.status >= 300 ? ` ${excerpt(declared.body, 200)}` : ''}`);
      if (declared.status < 300) {
        prop = await propose();
        d = describe(prop.body);
        step.facts.push(`proposal after the declaration: conformance ${prop.body.conformance?.status}; ${d.blocks.length} BLOCK`);
      }
    }
  }
  if (prop.status !== 200 || d.notExact.length > 0 || d.blocks.length > 0 || prop.body.conformance?.status !== 'pass') {
    const remaining: any[] = d.blocks;
    r.ledger.defect(step, {
      code: 'proposal-not-conforming', title: 'Mapping proposal does not conform for a file whose column names equal the spec',
      endpoint: 'GET …/versions/:v/data-binding-proposal', request: shape('GET', '…/data-binding-proposal?datasetVersionId'),
      observed: `${d.notExact.map((f: any) => `${f.name}: ${f.status}/${f.column ?? '—'}`).join(', ') || 'all proposed'}; BLOCK: ${remaining.map((b: any) => `${b.code} ${b.message}`).join(' | ') || 'none'}`,
      expected: 'every field proposed (exact_name), conformance pass, zero BLOCK', suspectedLocation: 'axiome-back sap-binding-proposals.ts proposeFieldMappings / sap-decision/conformance/binding-conformance.ts', severity: 'blocker',
    });
    r.blocked.mapping = 'the mapping proposal does not conform';
  }
  const proposalConforms = !r.blocked.mapping;
  const mappingBody = { datasetVersionId: r.ingestionId, mapping: expectedMapping(r.preset, r.fieldIdByName) };
  const conf = await inv.post(`${sap(r)}/versions/${r.planVersion}/data-bindings`, mappingBody);
  if (conf.status !== 201) {
    r.ledger.defect(step, {
      code: 'binding-confirm-refused', title: 'Investigator cannot confirm the mapping', endpoint: 'POST …/versions/:v/data-bindings',
      request: shape('POST', '…/versions/1/data-bindings', mappingBody), observed: got(conf), expected: '201 SapDataBindingRecord (conformance pass)',
      suspectedLocation: 'axiome-back apps/organization-service/src/sap/bindings/sap-data-binding.service.ts', severity: 'blocker',
    });
    r.blocked.mapping = 'binding not confirmed';
    return;
  }
  r.dataBindingId = String(conf.body.dataBindingId);
  step.facts.push(`binding ${r.dataBindingId}: conformance ${conf.body.conformance?.status}, confirmed by ${conf.body.confirmedByUserId === r.world.investigatorUserId ? 'the investigator' : conf.body.confirmedByUserId}`);
  if (conf.body.conformance?.status !== 'pass' && proposalConforms) {
    r.ledger.defect(step, {
      code: 'binding-not-conforming', title: 'Confirmed mapping stored as failing conformance', endpoint: 'POST …/versions/:v/data-bindings',
      request: shape('POST', '…/data-bindings', mappingBody), observed: excerpt(conf.body.conformance, 500), expected: 'conformance pass',
      suspectedLocation: 'axiome-back sap-binding.judge.ts', severity: 'blocker',
    });
    r.blocked.mapping = 'binding fails conformance';
  }
  if (conf.body.confirmedByUserId !== r.world.investigatorUserId) {
    r.ledger.defect(step, {
      code: 'binding-not-attributed', title: 'Confirmed mapping not attributed to the investigator', endpoint: 'POST …/versions/:v/data-bindings',
      request: shape('POST', '…/data-bindings', mappingBody), observed: `confirmedByUserId ${conf.body.confirmedByUserId}`, expected: 'the caller (FR14)',
      suspectedLocation: 'axiome-back sap-data-binding.service.ts', severity: 'major',
    });
  }
}

// ─── S7 — pre-flight + classification preview (FR5) ────────────────────────────────────

export async function preflight(r: Rehearsal, step: StepRecord): Promise<void> {
  const inv = r.world.investigator;
  const q = `version=${r.planVersion}&datasetVersionId=${r.ingestionId}&dataBindingId=${r.dataBindingId}`;
  const pf = await inv.get(`${sap(r)}/preflight?${q}`);
  step.facts.push(`preflight -> ${pf.status} ok=${pf.body?.ok}`);
  if (pf.status !== 200 || pf.body?.ok !== true) {
    const problems = (pf.body?.problems ?? []).map((p: any) => `${p.reason}${p.questionId ? ` (${[...r.questionIdByKey].find(([, id]) => id === p.questionId)?.[0] ?? p.questionId})` : ''}: ${p.message}`);
    r.ledger.defect(step, {
      code: 'preflight-refused', title: 'Pre-flight refuses the preset run', endpoint: 'GET /api/v1/projects/:p/saps/:sapId/preflight',
      request: shape('GET', '…/preflight?version&datasetVersionId&dataBindingId'), observed: problems.join(' | ') || got(pf), expected: '{ ok: true }',
      suspectedLocation: 'axiome-back apps/organization-service/src/sap/runs/ (sap-run-preflight.ts)', severity: 'blocker',
    });
  }
  const cp = await inv.get(`${sap(r)}/run-classification-preview?${q}`);
  step.facts.push(`classification preview -> ${cp.status} ${cp.body?.classification ?? excerpt(cp.body, 200)}`);
  if (cp.status !== 200 || cp.body?.classification !== 'planned_final_look') {
    r.ledger.defect(step, {
      code: 'classification-not-planned-final-look', title: 'First declared-plan run is not classified "Planned final look"',
      endpoint: 'GET /api/v1/projects/:p/saps/:sapId/run-classification-preview', request: shape('GET', '…/run-classification-preview?version&datasetVersionId&dataBindingId'),
      observed: got(cp), expected: '200 { classification: "planned_final_look" }', suspectedLocation: 'axiome-back SI-071 run classification (sap-decision)', severity: 'major',
    });
  }
}

// ─── S8 — start + poll the run (§7.1 steps 5–7) ────────────────────────────────────────

export async function runPlan(r: Rehearsal, step: StepRecord): Promise<void> {
  const inv = r.world.investigator;
  const body = { version: r.planVersion, datasetVersionId: r.ingestionId, clientRequestId: `axi2601-${r.token}-${randomUUID()}`, dataBindingId: r.dataBindingId };
  r.runStartedAt = Date.now();
  const started = await inv.post(`${sap(r)}/runs`, body);
  if (started.status !== 201) {
    r.ledger.defect(step, {
      code: 'run-start-refused', title: '"Start run" refused', endpoint: 'POST /api/v1/projects/:p/saps/:sapId/runs',
      request: shape('POST', '…/runs', body), observed: got(started), expected: '201 StartSapRunResponse',
      suspectedLocation: 'axiome-back apps/organization-service/src/sap/runs/ (sap-run.service start)', severity: 'blocker',
    });
    r.blocked.run = `start refused (${started.status})`;
    return;
  }
  r.sapRunId = String(started.body.sapRunId);
  step.facts.push(`SAP run ${r.sapRunId} started, classification ${started.body.classification}, ${started.body.questions?.length ?? 0} question(s)`);
  r.ledger.residue({ kind: 'SAP run', id: r.sapRunId, removed: false, note: 'kept with the project (append-only record)' });
  let firstResultMs: number | null = null;
  let last: any = null;
  try {
    const out = await pollUntil({
      what: 'SAP run', timeoutMs: RUN_TIMEOUT_MS, intervalMs: POLL_MS,
      read: async () => {
        const res = await inv.get(`${sap(r)}/runs/${r.sapRunId}`);
        last = res.status === 200 ? res.body : last;
        // First result = the first question carrying a verdict (a SAP child never reaches
        // `completed`: its interpretation step waits for a person — see the defect below).
        if (firstResultMs === null && (last?.questions ?? []).some((q: any) => q.childRunStatus === 'completed' || q.verdict)) {
          firstResultMs = Date.now() - (r.runStartedAt as number);
        }
        return last;
      },
      done: (v: any) => !!v && v.status !== 'running',
    });
    r.sapRun = out.value;
    r.ledger.timing('run (Start run → plan run settled)', Date.now() - (r.runStartedAt as number));
  } catch (err) {
    r.sapRun = last;
    r.ledger.timing('run (Start run → plan run settled)', err instanceof PollTimeoutError ? err.elapsedMs : null);
    r.ledger.defect(step, {
      code: 'run-never-settles', title: 'The plan run never leaves "running"', endpoint: 'GET /api/v1/projects/:p/saps/:sapId/runs/:sapRunId',
      request: shape('GET', '…/runs/:sapRunId'), observed: `${(err as Error).message}; questions ${excerpt((last?.questions ?? []).map((q: any) => q.childRunStatus), 200)}`,
      expected: `status completed within ${RUN_TIMEOUT_MS / 60_000} min`, suspectedLocation: 'axiome-back SAP run evaluation (evaluate-on-read) / governed execution', severity: 'blocker',
    });
  }
  r.ledger.timing('time to first result (Start run → first question verdict)', firstResultMs);
  const run = r.sapRun;
  if (!run) {
    r.blocked.run = 'run unreadable';
    return;
  }
  step.facts.push(`run status ${run.status}; engineVersion ${run.engineVersion ?? '—'}`);
  run.questions.forEach((q: any) => {
    const st = r.questions.find((x) => x.questionId === q.questionId);
    if (st) {
      st.childRunId = q.childRunId;
      st.childRunStatus = q.childRunStatus;
      st.verdict = q.verdict;
    }
    const key = st?.key ?? q.questionId;
    step.facts.push(
      `${key}: child ${q.childRunId ?? '—'} ${q.childRunStatus}, verdict ${q.verdict ?? '—'}, p ${q.mainPValue ?? '—'}, n ${q.n ?? (q.nPerGroup ? `[${q.nPerGroup.join(', ')}]` : '—')}, method "${q.methodName}"${q.guardReason ? `, not answerable: ${q.guardReason.code} ${q.guardReason.message}` : ''}`,
    );
  });
  const order = run.questions.map((q: any) => r.questions.find((x) => x.questionId === q.questionId)?.key);
  if (order.join(',') !== r.preset.questions.map((q) => q.key).join(',')) step.facts.push(`question order on the run: ${order.join(', ')} (preset order differs — FR21)`);
  if (run.status !== 'completed') {
    r.ledger.defect(step, {
      code: `run-${run.status}`, title: `The plan run ended "${run.status}"`, endpoint: 'GET /api/v1/projects/:p/saps/:sapId/runs/:sapRunId',
      request: shape('GET', '…/runs/:sapRunId'),
      observed: run.questions.map((q: any) => `${r.questions.find((x) => x.questionId === q.questionId)?.key}: ${q.childRunStatus}/${q.verdict}`).join(', '),
      expected: 'status completed, every child run completed (FR5)', suspectedLocation: 'see the per-question child failures (governed execution / bio-compute)', severity: 'blocker',
    });
  }
  const keyOf = (q: any): string => r.questions.find((x) => x.questionId === q.questionId)?.key ?? q.questionId;
  // A child that is still `running` although the SAP run has settled and its verdict is in: the
  // governed run parks on an interpretation step AWAITING_APPROVAL that no investigator surface
  // offers. One defect for the class, naming every question.
  const stuck = run.questions.filter((q: any) => q.childRunStatus === 'running' && run.status !== 'running');
  if (stuck.length > 0) {
    r.ledger.defect(step, {
      code: 'child-status-running-after-settle', title: 'Every plan child run stays "running" after the plan run completed',
      endpoint: 'GET /api/v1/projects/:p/saps/:sapId/runs/:sapRunId (+ GET /governed-execution/status)', request: shape('GET', '…/runs/:sapRunId'),
      observed: `run status ${run.status}; ${stuck.map((q: any) => `${keyOf(q)} child ${q.childRunId} childRunStatus running, verdict ${q.verdict}`).join('; ')}; governed status RUNNING with the last node "<run>__interpretation" AWAITING_APPROVAL`,
      expected: 'FR5: "the run completes with every child run succeeded" — the child shows completed once its computation settled (the SAP evaluation already treats it as terminal: isChildRunTerminal)',
      suspectedLocation: 'axiome-back sap/runs/sap-run-child-results.reader.ts (computationSettled → terminal, but the view still reports governed_runs.status); the SAP child compiled plan ends in an interpretation step awaiting approval',
      severity: 'major',
    });
  }
  for (const q of run.questions) {
    const key = keyOf(q);
    if (q.childRunStatus !== 'completed' && !(q.childRunStatus === 'running' && stuck.includes(q))) {
      r.ledger.defect(step, {
        code: `child-${q.childRunStatus}-${key}`, title: `Question ${key}: child run ${q.childRunStatus}`, endpoint: 'GET /api/v1/projects/:p/saps/:sapId/runs/:sapRunId',
        request: shape('GET', '…/runs/:sapRunId'), observed: `childRunStatus ${q.childRunStatus}, verdict ${q.verdict}, guardReason ${excerpt(q.guardReason, 200)}`,
        expected: 'completed', suspectedLocation: `governed run ${q.childRunId ?? '(none)'} — see GET /governed-execution/status`, severity: 'blocker',
      });
    } else if (!q.verdict && !q.guardReason) {
      r.ledger.defect(step, {
        code: `no-verdict-${key}`, title: `Question ${key}: completed with neither a verdict nor a not-answerable reason`, endpoint: 'GET …/runs/:sapRunId',
        request: shape('GET', '…/runs/:sapRunId'), observed: excerpt(q, 300), expected: 'a verdict or an explicit guardReason (FR5)',
        suspectedLocation: 'axiome-back SI-071 evaluation (sap-decision)', severity: 'major',
      });
    } else if (q.verdict === 'failed_to_run' && q.mainPValue == null) {
      r.ledger.defect(step, {
        code: `verdict-failed-to-run-${key}`, title: `Question ${key}: verdict "failed to run" although its child computed a result`,
        endpoint: 'GET …/runs/:sapRunId', request: shape('GET', '…/runs/:sapRunId'),
        observed: `verdict failed_to_run, guardReason ${excerpt(q.guardReason, 160)}, method "${q.methodName}"; the child's result page is ready with the full matrix (see S9)`,
        expected: 'an exploratory question with a computed result is reported as computed (not tested / descriptive), never as "failed to run" (FR5)',
        suspectedLocation: 'axiome-back sap/runs/sap-run-child-results.reader.ts main-result extraction (MAIN_ROWS_READ = 2: exactly ONE main row expected; T5@0.3 yields one row per reference × variable cell)',
        severity: 'major',
      });
    }
  }
  if (!r.questions.some((q) => q.childRunId)) r.blocked.results = 'no child run id on any question';
}

// ─── S9 — result pages + chart evidence (§7.1 step 8; FR5, FR19, FR23) ─────────────────

export async function resultPages(r: Rehearsal, step: StepRecord): Promise<void> {
  const inv = r.world.investigator;
  const noPreset: string[] = [];
  for (const q of r.questions) {
    const preset = r.preset.questions.find((x) => x.key === q.key)!;
    if (!q.childRunId) {
      step.facts.push(`${q.key}: no child run — page not read`);
      continue;
    }
    const path = `${proj(r)}/runs/${q.childRunId}/result-page`;
    let page: any = null;
    let status = 0;
    try {
      const out = await pollUntil({
        what: `${q.key} result page`, timeoutMs: RESULT_PAGE_TIMEOUT_MS, intervalMs: POLL_MS,
        read: async () => {
          const res = await inv.get(path);
          status = res.status;
          page = res.body;
          return res;
        },
        done: (res: ApiResponse) => res.status !== 200 || res.body?.state !== 'running',
      });
      void out;
    } catch {
      /* recorded below from the last observation */
    }
    q.page = status === 200 ? page : null;
    if (status !== 200 || page?.state !== 'ready') {
      r.ledger.defect(step, {
        code: `result-page-not-ready-${q.key}`, title: `Question ${q.key}: result page not ready`, endpoint: 'GET /api/v1/projects/:p/runs/:runId/result-page',
        request: shape('GET', '/api/v1/projects/:p/runs/:runId/result-page'), observed: `HTTP ${status} state ${page?.state ?? '—'} ${excerpt(page?.message ?? '', 200)}`,
        expected: '200 state ready', suspectedLocation: 'axiome-back apps/organization-service result-page service', severity: 'blocker',
      });
      continue;
    }
    const results: any[] = page.results ?? [];
    q.ruleRunIds = [...new Set(results.map((x) => String(x.ruleRunId)).filter(Boolean))];
    const charts = results.map((x) => `${x.operationId}→${x.chart?.type ?? (x.chartWithheld ? `withheld(${x.chartWithheld})` : 'none')}${x.preset?.variants ? ` [variant ${x.preset.variants.selectedKey} of ${x.preset.variants.offered.map((o: any) => o.variantKey).join('/')}]` : ''}`);
    step.facts.push(`${q.key}: ${results.length} result(s); analysisKind ${page.analysisKind}; plan marker ${page.sapRun ? 'yes' : 'NO'}; answer "${(page.answer ?? []).join(' ').slice(0, 160)}"; charts ${charts.join(', ')} (expected default ${preset.expectedChart})`);
    if (!page.sapRun) {
      r.ledger.defect(step, {
        code: `no-plan-marker-${q.key}`, title: `Question ${q.key}: result page carries no plan marker`, endpoint: 'GET …/runs/:runId/result-page',
        request: shape('GET', '…/result-page'), observed: `sapRun null, analysisKind ${page.analysisKind}`, expected: 'sapRun reference (FR23)',
        suspectedLocation: 'axiome-back result-page service (sapRun reference)', severity: 'major',
      });
    }
    const charted = results.filter((x) => x.chart);
    if (charted.length === 0) {
      r.ledger.defect(step, {
        code: `no-chart-${q.key}`, title: `Question ${q.key}: result page has no chart`, endpoint: 'GET …/runs/:runId/result-page',
        request: shape('GET', '…/result-page'), observed: results.map((x) => `${x.operationId}: chart null, withheld ${x.chartWithheld ?? '—'}`).join('; '),
        expected: `a default chart (${preset.expectedChart}) — FR5, FR19`, suspectedLocation: 'axiome-back …/result-page/result-page-chart.ts pageChartFor; rule-runs/kernel/operation-registry.ts', severity: 'blocker',
      });
      continue;
    }
    // Chart evidence for every chart that carries a recorded preset (FR57 of AXI-2414 — the "requests chart evidence" step).
    for (const res of charted) {
      if (!res.preset?.presetId) {
        step.facts.push(`${q.key} ${res.operationId}: chart has no recorded preset — chart evidence cannot be requested`);
        noPreset.push(`${q.key} ${res.operationId} (${res.chart?.type})`);
        continue;
      }
      const variantKey = res.preset.variants?.selectedKey ?? 'default';
      const ev = await inv.post(`${path}/chart-evidence`, { presetId: res.preset.presetId, variantKey });
      step.facts.push(`${q.key} ${res.operationId}: chart evidence (${variantKey}) -> ${ev.status}`);
      if (ev.status !== 201) {
        r.ledger.defect(step, {
          code: `chart-evidence-refused-${q.key}`, title: `Question ${q.key}: saving the chart as evidence is refused`, endpoint: 'POST /api/v1/projects/:p/runs/:runId/result-page/chart-evidence',
          request: shape('POST', '…/result-page/chart-evidence', { presetId: 1, variantKey: 1 }), observed: got(ev), expected: '201 SavedChartEvidence',
          suspectedLocation: 'axiome-back chart-evidence service (save)', severity: 'major',
        });
      }
    }
  }
  if (noPreset.length > 0) {
    r.ledger.defect(step, {
      code: 'chart-without-preset', title: 'Plan result charts carry no recorded chart preset: they cannot be saved as evidence and offer no variant',
      endpoint: 'GET /api/v1/projects/:p/runs/:runId/result-page (results[].preset) → POST …/result-page/chart-evidence {presetId, variantKey}',
      request: shape('GET', '…/result-page'), observed: `results[].preset null for ${noPreset.join(', ')}; chart evidence needs a presetId, so no chart could be saved`,
      expected: 'each plan result chart is a recorded preset (presetId + offered variants) so the Investigator can restyle it and save it as evidence (feature §7.1 step 8, FR23)',
      suspectedLocation: 'axiome-back SAP child runs are compiled through the opening templates without minting a chart preset (sap/runs → governed execution); result-page/result-page-chart.ts reads preset only when one was recorded',
      severity: 'major',
    });
  }
}

// ─── S10 — reports and figures (§7.1 step 9; FR5, FR24–FR26) ───────────────────────────

const EXPORTS: ReadonlyArray<{ kind: string; fileKind: FileKind; path: (rr: string) => string }> = [
  { kind: 'export csv', fileKind: 'csv', path: (rr) => `rule-runs/${rr}/exports/csv` },
  { kind: 'export svg', fileKind: 'svg', path: (rr) => `rule-runs/${rr}/exports/svg` },
  { kind: 'export png', fileKind: 'png', path: (rr) => `rule-runs/${rr}/exports/png` },
  { kind: 'export report (zip)', fileKind: 'zip', path: (rr) => `rule-runs/${rr}/exports/report` },
  { kind: 'client report md', fileKind: 'md', path: (rr) => `rule-runs/${rr}/client-report?format=md` },
  { kind: 'client report pdf', fileKind: 'pdf', path: (rr) => `rule-runs/${rr}/client-report?format=pdf` },
  { kind: 'client report zip', fileKind: 'zip', path: (rr) => `rule-runs/${rr}/client-report?format=zip` },
];

async function fetchAndCheck(r: Rehearsal, step: StepRecord, questionKey: string, kind: string, fileKind: FileKind, path: string, label: string): Promise<boolean> {
  const dl = await r.world.investigator.download(path);
  const verdict = dl.status === 200 ? checkFile(fileKind, dl.bytes) : { valid: false, note: excerpt(dl.bytes.toString('utf8'), 240) };
  const file = dl.status === 200 && dl.bytes.length > 0 ? r.ledger.saveDownload(`${questionKey}-${label}-${dl.filename ?? `${kind}.${fileKind}`}`, dl.bytes) : null;
  r.ledger.report.downloads.push({ questionKey, kind, file, status: dl.status, contentType: dl.contentType, bytes: dl.bytes.length, valid: verdict.valid, note: verdict.note });
  return dl.status === 200 && verdict.valid;
}

export async function downloads(r: Rehearsal, step: StepRecord): Promise<void> {
  for (const q of r.questions) {
    for (const [i, rr] of q.ruleRunIds.entries()) {
      for (const e of EXPORTS) await fetchAndCheck(r, step, q.key, e.kind, e.fileKind, `${proj(r)}/${e.path(rr)}`, `rr${i + 1}`);
    }
  }
  if (r.sapRunId) await fetchAndCheck(r, step, 'run', 'run report md', 'md', `${sap(r)}/runs/${r.sapRunId}/report`, 'run');
  const all = r.ledger.report.downloads;
  const bad = all.filter((d) => !d.valid);
  step.facts.push(`${all.length - bad.length}/${all.length} download(s) valid`);
  for (const d of all.filter((x) => x.valid)) step.facts.push(`ok: ${d.questionKey} ${d.kind} (${d.bytes} bytes, ${d.note})`);
  // One defect per failure CLASS: a refusal (same status + server message) across kinds and
  // questions is one defect; an invalid 200 body is one defect per kind.
  const classOf = (d: Download): { code: string; label: string } => {
    if (d.status !== 200) {
      let message = d.note;
      try {
        message = String(JSON.parse(d.note.replace(/…$/, '')).message ?? d.note);
      } catch {
        message = (d.note.match(/"message":"([^"]+)"/) ?? [])[1] ?? d.note.slice(0, 80);
      }
      return { code: `download-${d.status}-${message.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}`, label: `HTTP ${d.status} "${message}"` };
    }
    return { code: `download-invalid-${d.kind.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, label: `HTTP 200 but ${d.note}` };
  };
  const classes = new Map<string, { label: string; items: Download[] }>();
  for (const d of bad) {
    const c = classOf(d);
    classes.set(c.code, { label: c.label, items: [...(classes.get(c.code)?.items ?? []), d] });
  }
  for (const [code, { label, items }] of classes) {
    const kinds = [...new Set(items.map((d) => d.kind))];
    const exportsOnly = kinds.every((k) => !k.startsWith('run report'));
    r.ledger.defect(step, {
      code, title: `${kinds.length === 1 ? `Download "${kinds[0]}"` : `${kinds.length} download kinds`} refused or invalid: ${label}`,
      endpoint: exportsOnly ? 'GET /api/v1/projects/:p/rule-runs/:ruleRunId/exports/{csv,svg,png,report} and …/client-report?format={md,pdf,zip}' : 'GET …/saps/:sapId/runs/:sapRunId/report',
      request: `as the investigator, ruleRunId = the result page's results[].ruleRunId (as the front's ResultExportButtons does); kinds: ${kinds.join(', ')}; questions: ${[...new Set(items.map((d) => d.questionKey))].join(', ')}`,
      observed: `${items.length} download(s): ${label}`,
      expected: 'HTTP 200, a non-empty file of the declared type (PNG at 300 dpi) — FR5, FR24, FR25',
      suspectedLocation: /rule run not found/i.test(label)
        ? 'axiome-back exports/run-exports/run-export.service.ts and provenance/audit-report/client-report/client-report.service.ts use placedRun() (route project only, client-report-anchor.reader.ts read() → placementOf(snapshotId)); the result page reads the same run through placedRunOrReusedSource() — the plan children\'s rule runs are not "placed" in the study project'
        : 'axiome-back run-export / client-report services (pdf-render.service.ts for PDF/PNG)',
      severity: 'blocker',
    });
  }
}

// ─── S11 — review + sign-off (§7.1 step 10) ────────────────────────────────────────────

export async function reviewAndSign(r: Rehearsal, step: StepRecord): Promise<void> {
  const inv = r.world.investigator;
  const base = `${sap(r)}/runs/${r.sapRunId}`;
  let reviewed = 0;
  for (const q of r.questions) {
    if (!q.questionId) continue;
    const outcome = q.verdict === 'met' || q.verdict === 'not_met' ? 'answered' : 'not_answered';
    const body = { questionId: q.questionId, outcome, note: `AXI-2601 rehearsal ${r.token}: reviewed (verdict ${q.verdict ?? 'none'})` };
    const res = await inv.post(`${base}/question-reviews`, body);
    if (res.status === 201) reviewed++;
    else {
      r.ledger.defect(step, {
        code: `review-refused-${q.key}`, title: `Question ${q.key}: review refused`, endpoint: 'POST /api/v1/projects/:p/saps/:sapId/runs/:sapRunId/question-reviews',
        request: shape('POST', '…/question-reviews', body), observed: got(res), expected: '201 SapQuestionReviewRecord',
        suspectedLocation: 'axiome-back apps/organization-service/src/sap/review/', severity: 'major',
      });
    }
  }
  step.facts.push(`${reviewed}/${r.questions.length} question review(s) recorded`);
  const sign = await inv.post(`${base}/sign-off`, {});
  step.facts.push(`sign-off -> ${sign.status}`);
  if (sign.status !== 201) {
    r.ledger.defect(step, {
      code: 'sign-off-refused', title: 'Sign-off refused after every card is reviewed', endpoint: 'POST /api/v1/projects/:p/saps/:sapId/runs/:sapRunId/sign-off',
      request: shape('POST', '…/sign-off'), observed: got(sign), expected: '201 SapRunSignOffRecord (actor + time + hash)',
      suspectedLocation: 'axiome-back apps/organization-service/src/sap/review/ (sign-off)', severity: 'major',
    });
    return;
  }
  r.signed = true;
  step.facts.push(`signed by ${sign.body.signerUserId === r.world.investigatorUserId ? 'the investigator' : sign.body.signerUserId} at ${sign.body.signedAt}; contentHash ${String(sign.body.contentHash).slice(0, 12)}…`);
  const okSigned = await fetchAndCheck(r, step, 'run', 'signed report md', 'md', `${base}/sign-off/report`, 'signed');
  if (!okSigned) {
    const d = r.ledger.report.downloads.at(-1)!;
    r.ledger.defect(step, {
      code: 'signed-report-download', title: 'Signed report does not download', endpoint: 'GET …/runs/:sapRunId/sign-off/report',
      request: shape('GET', '…/sign-off/report'), observed: `HTTP ${d.status} ${d.note}`, expected: '200 Markdown (FR26)',
      suspectedLocation: 'axiome-back sign-off signed report', severity: 'major',
    });
  }
}

// ─── S12 — cleanup + duplicate re-upload (FR6, EC1, AC15) ──────────────────────────────

export async function cleanup(r: Rehearsal, step: StepRecord): Promise<void> {
  const inv = r.world.investigator;
  if (!r.datasetId) {
    step.facts.push('no dataset uploaded by this run');
    return;
  }
  const del = await inv.delete(`${ws(r)}/datasets/${r.datasetId}`);
  const removed = del.status >= 200 && del.status < 300;
  // FR6 as amended (D13, 2026-11-17): a dataset cited by a completed run is KEPT (citation
  // integrity, AXI-2314). That exact refusal is recorded residue, not a defect; every other
  // refusal still is one. Each run uploads a per-run variant, so the kept file never blocks the next.
  const keptByCitation = del.status === 409 && del.body?.errorCode === 'DATASET_DELETE_REFUSED_CITED';
  r.ledger.residue({
    kind: 'dataset', id: r.datasetId, removed,
    note: removed ? 'deleted by the investigator (dataset:delete_own)'
      : keptByCitation ? 'kept: cited by the run\'s evidence (citation integrity, AXI-2314; FR6 as amended, D13)'
        : `delete refused: ${got(del)}`,
  });
  step.facts.push(`DELETE dataset -> ${del.status}${keptByCitation ? ' DATASET_DELETE_REFUSED_CITED (kept per D13)' : ''}`);
  if (keptByCitation) {
    step.facts.push('EC1 re-upload check: not applicable (the cited dataset is kept by design; each run uploads a per-run variant)');
    return;
  }
  if (!removed) {
    r.ledger.defect(step, {
      code: 'dataset-delete-refused', title: 'The rehearsal cannot delete the dataset it uploaded', endpoint: 'DELETE /api/v1/workspaces/:ws/datasets/:id',
      request: shape('DELETE', '/api/v1/workspaces/:ws/datasets/:id'), observed: got(del),
      expected: '2xx — FR6 requires the rehearsal to leave no dataset behind (or the product to offer a way to)',
      suspectedLocation: 'axiome-back apps/organization-service/src/datasets/datasets.service.ts delete → findDatasetDeleteCitations / dataset-delete-refusal.ts (AXI-2314)', severity: 'major',
    });
    step.facts.push('EC1 re-upload check: blocked (the dataset is still there, so the same bytes WILL be refused as a duplicate on the next run)');
    return;
  }
  // EC1 / AC15: the same bytes are accepted again once the earlier upload is deleted.
  const again = await uploadBytes(r, `${UPLOAD_PREFIX}${r.token}-reupload-final_tableau2_synthetic.csv`, r.uploadedBytes as Buffer);
  const dup = duplicateOf(again);
  step.facts.push(`re-upload of the same bytes after delete -> ${again.status}${dup ? ` DUPLICATE of ${dup}` : ''}`);
  if (again.status >= 300) {
    r.ledger.defect(step, {
      code: 'reupload-refused-after-delete', title: 'Same file refused again after the earlier upload was deleted', endpoint: 'PATCH /api/v1/workspaces/:ws/datasets/:id/finalize',
      request: 'initiate → presigned PUT (same bytes) → finalize', observed: got({ status: again.status, body: again.body }), expected: '2xx (a deleted dataset is never a duplicate — EC1, AC15)',
      suspectedLocation: 'axiome-back datasets.service.ts findDuplicateByContentHash (deletedAt filter)', severity: 'major',
    });
  }
  if (again.datasetId && again.status < 300) {
    const del2 = await inv.delete(`${ws(r)}/datasets/${again.datasetId}`);
    const removed2 = del2.status >= 200 && del2.status < 300;
    r.ledger.residue({ kind: 'dataset (EC1 re-upload probe)', id: again.datasetId, removed: removed2, note: removed2 ? 'deleted' : `delete refused: ${got(del2)}` });
  }
}

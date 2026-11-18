/**
 * AXI-2663 (epic AXI-2630, FR73, FR74, AC54, AC55; SI-042). The documented procedure
 * (axiome-docs demo/mag4-microbiote/final/REPRODUCE-VIA-API.md) as API calls, in the product's order:
 * protocol, questions, variables, question planning, finalise, data, run, results.
 *
 * Every call is one the app itself makes. The run ends at results, images and draft evidence:
 * approval, interpretation sign-off and signing are human steps and no route for them appears here.
 * The two reference files are uploaded byte for byte, never salted and never prepared.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { excerpt, type HandoverClient } from '../../AXI-2598/harness/http';
import { pollUntil, PollTimeoutError } from '../../AXI-2598/harness/poll';
import {
  csvFacts, extensionFieldsOf, presetProblems, questionBody, sha256Hex, specificationBody,
  type CsvFacts, type FileKey, type NewModelPreset, type PresetFile, type PresetQuestion,
} from '../harness/new-model-preset';
import type { ImageKey, ServedPage, ServedPages } from './read-results';
import type { Trace } from './trace';

export const EXIT_MISMATCH = 1;
export const EXIT_BLOCKED = 3;

/** Stops the run: a response that differs (exit 1) or a step the stack cannot serve yet (exit 3). */
export class StopRun extends Error {
  constructor(readonly exitCode: number, message: string) {
    super(message);
  }
}

const POLL = { timeoutMs: 180_000, intervalMs: 2_000 };
const RUN_POLL = { timeoutMs: 900_000, intervalMs: 3_000 };

export interface Actors {
  investigator: HandoverClient;
  provisioner: HandoverClient;
  workspaceId: string;
  organizationId: string;
}

export interface Procedure {
  actors: Actors;
  trace: Trace;
  preset: NewModelPreset;
  repoRoot: string;
  token: string;
  projectId: string;
  sapId: string;
  sapVersionId: string;
  revision: number;
  fieldIdByName: Map<string, string>;
  questionIdByKey: Map<string, string>;
  runIdByKey: Map<string, string>;
}

type Res = { status: number; body: any };

function expectStatus(res: Res, step: string, expected: number[]): any {
  if (expected.includes(res.status)) return res.body;
  throw new StopRun(EXIT_MISMATCH, `${step}: expected HTTP ${expected.join(' or ')}, got ${res.status}: ${excerpt(res.body, 400)}`);
}

function expectValue(step: string, name: string, expected: unknown, actual: unknown): void {
  if (actual === expected) return;
  throw new StopRun(EXIT_MISMATCH, `${step}: ${name} expected ${String(expected)}, got ${String(actual)}`);
}

/** A designed route absent from the stack blocks the run: no substitute path is ever taken. */
function blockedWhenMissing(res: Res, step: string, story: string): void {
  if (res.status !== 404) return;
  throw new StopRun(EXIT_BLOCKED, `${step}: this stack does not serve the route yet; it arrives with ${story}`);
}

const projectPath = (p: Procedure) => `/api/v1/projects/${p.projectId}`;
const sapPath = (p: Procedure) => `${projectPath(p)}/saps/${p.sapId}`;
const versionPath = (p: Procedure) => `${sapPath(p)}/versions/${p.sapVersionId}`;
const imageKey = (q: PresetQuestion) => `image-${q.image}` as ImageKey;

function fileBytes(repoRoot: string, file: PresetFile): Buffer {
  return readFileSync(path.join(repoRoot, file.path));
}

/** Step 0: the two local files are the reference files, byte for byte. */
export function verifyInputs(repoRoot: string, preset: NewModelPreset, trace: Trace): void {
  const facts = {} as Record<FileKey, CsvFacts>;
  for (const file of preset.files) {
    const bytes = fileBytes(repoRoot, file);
    expectValue('0 inputs', `${file.key} sha256`, file.sha256, sha256Hex(bytes));
    facts[file.key] = csvFacts(bytes.toString('utf8'));
  }
  const problems = presetProblems(preset, facts);
  if (problems.length > 0) throw new StopRun(EXIT_MISMATCH, `0 inputs: ${problems.join('; ')}`);
  trace.record('0 inputs', { files: preset.files.map((f) => ({ key: f.key, sha256: f.sha256, rows: f.rows })) });
}

/** Step 1: a NEW project, created by the provisioning identity (an Investigator cannot). */
export async function createProject(p: Procedure): Promise<void> {
  const { provisioner, investigator, workspaceId } = p.actors;
  const name = `AXI-2663 MAG4 reproduction ${p.token}`;
  const body = { name, workspaceId, semanticProfileId: p.preset.profile.profileId };
  p.projectId = String(expectStatus(await provisioner.post('/api/v1/projects', body), '1 project', [201]).id);
  expectStatus(await investigator.get(projectPath(p)), '1 project read by the investigator', [200]);
  p.trace.record('1 project', { projectId: p.projectId, name });
}

/** Step 2: the protocol comes first. */
export async function saveProtocol(p: Procedure): Promise<void> {
  const { title, objective, studyPopulation } = p.preset.study;
  const body = { title, objective, studyPopulation, text: objective };
  const saved = expectStatus(await p.actors.investigator.put(`${projectPath(p)}/study/protocol`, body), '2 protocol', [200]);
  expectValue('2 protocol', 'title', title, saved?.title);
  p.trace.record('2 protocol', { title });
}

/** Step 3: the questions, as text and role only; each is planned in step 6. */
export async function addQuestions(p: Procedure): Promise<void> {
  const inv = p.actors.investigator;
  const draft = expectStatus(await inv.post(`${projectPath(p)}/saps/draft`, { planSchemaVersion: 2 }), '3 draft', [201]);
  p.sapId = String(draft.sapId);
  p.revision = Number(draft.revision);
  for (const q of p.preset.questions) {
    const question = { text: q.text, role: q.role };
    const body = { basedOnRevision: p.revision, question };
    const added = expectStatus(await inv.post(`${sapPath(p)}/draft/question-stubs`, body), `3 question ${q.key}`, [201]);
    p.questionIdByKey.set(q.key, String(added.addedQuestionId));
    p.revision = Number(added.revision);
  }
  p.trace.record('3 questions', { sapId: p.sapId, questionIds: Object.fromEntries(p.questionIdByKey) });
}

async function addExtensionFields(p: Procedure): Promise<string[]> {
  const fields = extensionFieldsOf(p.preset).map((f) => `project.${p.projectId}.${f.key}`);
  const packs = [{ registry_id: `canonical_fields.project.${p.projectId}.v1`, fields }];
  const url = `/api/v1/semantic-profiles/projects/${p.projectId}/extensions`;
  expectStatus(await p.actors.provisioner.post(url, { packs }), '4 profile extension', [201]);
  return fields;
}

/** The live pin, read AFTER the extension: adding a field changes the registry hash. */
async function liveConfigVersion(p: Procedure, extensionFields: string[]): Promise<string> {
  const res = await p.actors.investigator.get(`${projectPath(p)}/semantic-contract`);
  const contract = expectStatus(res, '4 semantic contract', [200]);
  const known = new Set<string>(contract?.canonicalFields ?? []);
  for (const field of extensionFields) expectValue('4 semantic contract', `field ${field} present`, true, known.has(field));
  return String(contract?.profile?.configVersion);
}

/** AXI-2587 (designed route, branch AXI-2587-variables): the variables step reads the catalogue. */
async function readStandardFields(p: Procedure, configVersion: string): Promise<void> {
  const res = await p.actors.investigator.get(`${projectPath(p)}/sap-standard-fields`);
  blockedWhenMissing(res, '4 standard fields', 'AXI-2587 (variables)');
  const catalog = expectStatus(res, '4 standard fields', [200]);
  expectValue('4 standard fields', 'profile configVersion', configVersion, catalog?.profile?.configVersion);
  const offered = new Set<string>((catalog?.fields ?? []).map((f: any) => f.canonicalField));
  const platform = p.preset.dataSpecification.fields.filter((f) => f.canonicalFieldSource === 'platform');
  for (const f of platform) expectValue('4 standard fields', `${f.canonicalField} offered`, true, offered.has(f.canonicalField));
}

/** Step 4: variables and the semantic profile. */
export async function declareVariables(p: Procedure): Promise<void> {
  const extensionFields = await addExtensionFields(p);
  const configVersion = await liveConfigVersion(p, extensionFields);
  await readStandardFields(p, configVersion);
  const { title, studyPopulation } = p.preset.plan;
  const dataSpecification = specificationBody(p.preset, p.projectId, configVersion);
  const body = { basedOnRevision: p.revision, title, studyPopulation, dataSpecification };
  const saved = expectStatus(await p.actors.investigator.put(`${sapPath(p)}/draft`, body), '4 variables', [200]);
  p.revision = Number(saved.revision);
  for (const f of saved.plan?.dataSpecification?.fields ?? []) p.fieldIdByName.set(String(f.name), String(f.fieldId));
  expectValue('4 variables', 'fields saved', p.preset.dataSpecification.fields.length, p.fieldIdByName.size);
  p.trace.record('4 variables', { configVersion, fieldIds: Object.fromEntries(p.fieldIdByName) });
}

/** AXI-2590 (designed, branch AXI-2590-plan-question): the planning page reads the workflow. */
async function readWorkflows(p: Procedure): Promise<void> {
  const res = await p.actors.investigator.get(`${projectPath(p)}/sap-templates`);
  const catalog: any[] = expectStatus(res, '5 templates', [200]) ?? [];
  for (const { template } of p.preset.questions) {
    const entry = catalog.find((t) => t.templateId === template.templateId && t.templateVersion === template.templateVersion);
    expectValue('5 templates', `${template.templateId}@${template.templateVersion} offered`, true, Boolean(entry));
    if (!entry.workflow) throw new StopRun(EXIT_BLOCKED, '5 templates: no workflow is served yet; it arrives with AXI-2590 (question planning)');
  }
}

/** Step 5: each question is planned in place; its id and position are kept. */
export async function planQuestions(p: Procedure): Promise<void> {
  await readWorkflows(p);
  for (const q of p.preset.questions) {
    const url = `${sapPath(p)}/draft/questions/${p.questionIdByKey.get(q.key)}`;
    const body = { basedOnRevision: p.revision, analysisDatasetId: null, question: questionBody(q, p.fieldIdByName) };
    p.revision = Number(expectStatus(await p.actors.investigator.put(url, body), `5 plan ${q.key}`, [200]).revision);
  }
  p.trace.record('5 planning', { revision: p.revision });
}

/** Step 6: completeness has no failing check, then the plan is finalised. */
export async function finalisePlan(p: Procedure): Promise<void> {
  const inv = p.actors.investigator;
  const completeness = expectStatus(await inv.get(`${sapPath(p)}/draft/completeness`), '6 completeness', [200]);
  const failing = (completeness?.results ?? []).filter((r: any) => r.status === 'fail');
  if (failing.length > 0) throw new StopRun(EXIT_MISMATCH, `6 completeness: failing checks ${excerpt(failing, 400)}`);
  const body = { basedOnRevision: p.revision, basedOnVersion: null };
  const finalised = expectStatus(await inv.post(`${sapPath(p)}/draft/finalise`, body), '6 finalise', [201]);
  expectValue('6 finalise', 'status', 'final', finalised?.status);
  p.sapVersionId = String(finalised.sapVersionId);
  p.trace.record('6 finalise', { sapVersionId: p.sapVersionId });
}

async function uploadFile(p: Procedure, file: PresetFile): Promise<Res & { datasetId: string }> {
  const inv = p.actors.investigator;
  const datasets = `/api/v1/workspaces/${p.actors.workspaceId}/datasets`;
  const body = { organizationId: p.actors.organizationId, originalFilename: path.basename(file.path), contentType: 'text/csv' };
  const init = expectStatus(await inv.post(datasets, body), `7 upload ${file.key}`, [201]);
  const datasetId = String(init.dataset.id);
  const bytes = new Uint8Array(fileBytes(p.repoRoot, file));
  const put = await fetch(String(init.presignedUrl), { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: bytes });
  if (!put.ok) throw new StopRun(EXIT_MISMATCH, `7 upload ${file.key}: storage PUT answered ${put.status}`);
  return { ...(await inv.patch(`${datasets}/${datasetId}/finalize`)), datasetId };
}

/** The server recognised the same bytes: its existing dataset IS the reference file. */
function datasetIdAfterUpload(file: PresetFile, uploaded: Res & { datasetId: string }): string {
  const code = uploaded.body?.code ?? uploaded.body?.errorCode;
  if (uploaded.status === 409 && code === 'DUPLICATE_DATASET_CONTENT') return String(uploaded.body?.details?.existingDatasetId);
  expectStatus(uploaded, `7 finalize ${file.key}`, [200]);
  return uploaded.datasetId;
}

async function waitForIngestion(p: Procedure, file: PresetFile, datasetId: string): Promise<void> {
  const url = `/api/v1/workspaces/${p.actors.workspaceId}/datasets/${datasetId}`;
  await pollUntil({
    ...POLL,
    what: `7 ingestion ${file.key}`,
    read: () => p.actors.investigator.get(url),
    fatal: (res) => (res.body?.latestIngestion?.status === 'failed' ? 'ingestion failed' : null),
    done: (res) => res.body?.latestIngestion?.status === 'ready',
  });
}

async function addDataFile(p: Procedure, file: PresetFile): Promise<string> {
  const datasetId = datasetIdAfterUpload(file, await uploadFile(p, file));
  const link = await p.actors.investigator.post(`${projectPath(p)}/datasets`, { datasetId });
  expectStatus(link, `7 link ${file.key}`, [200, 201]);
  await waitForIngestion(p, file, datasetId);
  return datasetId;
}

const unresolved = (body: any): any[] => (body?.questions ?? []).filter((q: any) => q?.resolution?.kind !== 'resolved');

async function readQuestionData(p: Procedure): Promise<Res> {
  const url = `/api/v1/semantic-profiles/projects/${p.projectId}/normalize`;
  expectStatus(await p.actors.provisioner.post(url), '7 normalize', [200, 201]);
  return p.actors.investigator.get(`${versionPath(p)}/question-data`);
}

/** Every question must resolve to one dataset; if one cannot, the run stops and names it. */
async function waitForQuestionData(p: Procedure): Promise<void> {
  try {
    await pollUntil({
      ...POLL,
      what: '7 question data',
      read: () => readQuestionData(p),
      done: (res) => res.status === 200 && (res.body?.questions?.length ?? 0) > 0 && unresolved(res.body).length === 0,
    });
  } catch (error) {
    if (!(error instanceof PollTimeoutError)) throw error;
    const last = error.last as Res | undefined;
    throw new StopRun(EXIT_BLOCKED, `7 question data: questions without data: ${excerpt(unresolved(last?.body), 700)}`);
  }
}

/** Step 7: the two reference files, unchanged, then per-question data readiness. */
export async function addData(p: Procedure): Promise<void> {
  const datasetIds: Record<string, string> = {};
  for (const file of p.preset.files) datasetIds[file.key] = await addDataFile(p, file);
  await waitForQuestionData(p);
  p.trace.record('7 data', { datasetIds });
}

async function launchQuestion(p: Procedure, q: PresetQuestion): Promise<void> {
  const url = `${versionPath(p)}/questions/${p.questionIdByKey.get(q.key)}/launch`;
  const body = expectStatus(await p.actors.investigator.post(url, {}), `8 launch ${q.key}`, [201]);
  if ((body?.refused ?? []).length > 0) throw new StopRun(EXIT_MISMATCH, `8 launch ${q.key}: refused ${excerpt(body.refused, 500)}`);
  expectValue(`8 launch ${q.key}`, 'launched questions', 1, body?.launched?.length);
  p.runIdByKey.set(q.key, String(body.launched[0].runId));
}

function failedQuestion(body: any): string | null {
  const failed = (body?.questions ?? []).filter((q: any) => q.state === 'failed');
  return failed.length > 0 ? `failed questions ${excerpt(failed, 400)}` : null;
}

/** Step 8: each question launches once; the run waits until all four finish. */
export async function runQuestions(p: Procedure): Promise<void> {
  for (const q of p.preset.questions) await launchQuestion(p, q);
  const finished = await pollUntil({
    ...RUN_POLL,
    what: '8 run',
    read: () => p.actors.investigator.get(`${versionPath(p)}/verdicts`),
    fatal: (res) => failedQuestion(res.body),
    done: (res) => (res.body?.questions ?? []).length === p.preset.questions.length && res.body.questions.every((q: any) => q.state === 'finished'),
  });
  p.trace.record('8 run', { runIds: Object.fromEntries(p.runIdByKey), verdicts: finished.value.body?.questions });
}

async function readResultPage(p: Procedure, q: PresetQuestion): Promise<ServedPage> {
  const url = `${projectPath(p)}/runs/${p.runIdByKey.get(q.key)}/result-page`;
  const ready = await pollUntil({
    ...POLL,
    what: `9 result page ${q.key}`,
    read: () => p.actors.investigator.get(url),
    fatal: (res) => (['failed', 'source_no_access'].includes(res.body?.state) ? `page state ${res.body.state}` : null),
    done: (res) => res.status === 200 && res.body?.state === 'ready',
  });
  return ready.value.body as ServedPage;
}

/** What the run leaves for a human: the evidence as drafted, never accepted by this script. */
function draftEvidence(page: any): Record<string, unknown> {
  return {
    verdictStates: (page?.verdicts ?? []).map((v: any) => v.state),
    results: (page?.results ?? []).map((r: any) => ({
      ruleRunId: r.ruleRunId, operationId: r.operationId, hasChart: Boolean(r.chart),
      method: r.evidence?.method, dataHash: r.evidence?.dataHash, ruleVersion: r.evidence?.ruleVersion,
    })),
  };
}

/** Step 9: the four result pages. The comparison itself is `compare.ts`. */
export async function readResults(p: Procedure): Promise<ServedPages> {
  const pages = {} as ServedPages;
  for (const q of p.preset.questions) {
    pages[imageKey(q)] = await readResultPage(p, q);
    p.trace.record(`9 results ${q.key}`, draftEvidence(pages[imageKey(q)]));
  }
  return pages;
}

export const PROCEDURE_STEPS = [
  createProject, saveProtocol, addQuestions, declareVariables, planQuestions, finalisePlan, addData, runQuestions,
] as const;

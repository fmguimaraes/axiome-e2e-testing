import { asList, type Api } from '../../AXI-1400/harness/api';

/**
 * AXI-2338 (epic AXI-2308 — FR16, AC12; Headless §10 delta, §17 D8) — a project
 * holds EXACTLY ONE SAP. A second `POST /projects/:projectId/saps` is refused
 * 409 `SAP_ALREADY_EXISTS`, and re-planning is a new VERSION of that one SAP.
 *
 * Specs that run against a REUSED tenant project (`ensureTenant`) used to create
 * a fresh SAP on every run. Under one-SAP-per-project the second run is a 409,
 * so they bind the project's CURRENT SAP version instead: create it the first
 * time, read it back every time after. The linked methods of an existing SAP are
 * not re-checked — the run binding asks only that the version belongs to the
 * project (SI-065), never what the SAP lists.
 */
export interface SapContent {
  title: string;
  questionText: string;
  planText: string;
  linkedMethods: Array<Record<string, unknown>>;
}

export async function projectSapVersionId(
  api: Api,
  projectId: string,
  headers: Record<string, string>,
  content: SapContent,
): Promise<string> {
  const created = await api.post(`/api/v1/projects/${projectId}/saps`, content, headers);
  if (created.status === 201 && typeof created.body?.sapVersionId === 'string') return created.body.sapVersionId;
  if (created.status === 409 && created.body?.errorCode === 'SAP_ALREADY_EXISTS') {
    const listed = await api.get(`/api/v1/projects/${projectId}/saps?limit=1`, headers);
    const current = asList(listed.body)[0];
    if (typeof current?.sapVersionId === 'string') return current.sapVersionId;
    throw new Error(`project ${projectId} refused a second SAP but lists none (${listed.status}): ${JSON.stringify(listed.body)}`);
  }
  throw new Error(`SAP creation for project ${projectId} failed (${created.status}): ${JSON.stringify(created.body)}`);
}

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
  // AXI-2438 retired the free-text create (410 SAP_FREE_TEXT_RETIRED): a reused project keeps its
  // existing SAP version; a project with none cannot get one until AXI-2439's finalise lands.
  const retired = created.status === 410 && created.body?.errorCode === 'SAP_FREE_TEXT_RETIRED';
  if (retired || (created.status === 409 && created.body?.errorCode === 'SAP_ALREADY_EXISTS')) {
    const listed = await api.get(`/api/v1/projects/${projectId}/saps?limit=1`, headers);
    const current = asList(listed.body)[0];
    if (typeof current?.sapVersionId === 'string') return current.sapVersionId;
    if (retired) {
      throw new Error(`project ${projectId} has no SAP version and POST …/saps is retired (410, AXI-2438): `
        + 'a SAP version now needs draft + finalise (AXI-2439)');
    }
    throw new Error(`project ${projectId} refused a second SAP but lists none (${listed.status}): ${JSON.stringify(listed.body)}`);
  }
  throw new Error(`SAP creation for project ${projectId} failed (${created.status}): ${JSON.stringify(created.body)}`);
}

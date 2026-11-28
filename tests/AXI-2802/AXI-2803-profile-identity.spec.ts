import { expect, test, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { API_BASE_URL } from '../../config/env';
import { psqlRows } from '../AXI-1640/harness/seed';

/**
 * AXI-2803 (epic AXI-2802 — Semantic Profile Management, area A1): profile identity, baseline
 * and legacy conversion. Scenarios: `axiome-docs/manual-e2e/AXI-2802-Semantic-Profile-Management.md`
 * § AXI-2803 (4.1–4.6, 5.1).
 *
 * E2E CONTRACT — an A/B over the REAL gateway, API level, as `admin@cro-one.com` only (no
 * throwaway members: since AXI-2734 attaching a freshly registered user needs the platform admin):
 *   - REFERENCE = `REF_API_BASE_URL` (default `http://localhost:3000`, the shared demo = `main`);
 *   - STORY     = `API_BASE_URL` (the branch's gateway; before merge a sidecar over the SAME demo DB).
 * Every read is made on both and must be equal except the Feature §10.4 items. When both URLs
 * name the same stack (after merge) the A/B reduces to the post-change assertions.
 * Writes: two throwaway projects in the `Public Datasets — IO Benchmarks` workspace (never a
 * client demo workspace), one dataset link, one extension revision — unlinked and deleted at the
 * end. Database access (`docker exec axiome-localhost psql`, `E2E_PG_CONTAINER`) is READ-ONLY:
 * the mapping rows' identity strings are exposed by no API.
 */

const REF_API_BASE_URL = (process.env.REF_API_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
const SAME_STACK = REF_API_BASE_URL === API_BASE_URL;
const EMAIL = process.env.E2E_2803_EMAIL?.trim() || 'admin@cro-one.com';
const PASSWORD = process.env.E2E_2803_PASSWORD?.trim() || 'admin';

const WS_MAG4 = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const WS_IO = '81bc7740-7dd0-45d6-9b8e-b7fdef861078';
const PROJECTS = [
  { id: 'ba5d1363-a7d3-485f-8907-6e046dfce514', ws: WS_IO, name: 'Riaz 2017', profile: 'immuno_oncology' },
  { id: '22585add-60ab-4d8e-a8ff-0f1071862553', ws: WS_MAG4, name: 'Microbiote IgG4 (AXI-2064)', profile: 'immunology' },
  { id: '634d1c6d-4209-446a-aa0d-733d825c1fea', ws: WS_MAG4, name: 'Demo 2411', profile: 'immune_mediated_microbiota' },
];
const DEMO_2411 = PROJECTS[2];
const RIAZ = PROJECTS[0];
const RIAZ_DATASET = '5cc64377-1459-4bde-a7e2-65af8c29ef49';

const CONVERTED = ['immunology', 'oncology', 'immuno_oncology'];
const LIST_ORDER = ['immuno_oncology', 'immunology', 'oncology', 'immune_mediated', 'immune_mediated_microbiota'];
/** Legacy hashes the platform identity ledger names (`profile-identity/identity-ledger.ts`). */
const PLATFORM_LEGACY_HASHES: Record<string, string> = {
  immune_mediated: '59d8a286986b5456663124f6dd8bdd60eb30e9ae854995fe3157ba9f10375c57',
  immune_mediated_microbiota: 'e8208d519052d6e36b5a6b6fe564436c82cd4b033fd8b99df5b258e1f773349b',
};
const CURRENT_IDENTITY = /^([a-z_]+)@(\d+\.\d+\.\d+)\+cid1:([0-9a-f]{64})$/;
const STORED_IDENTITY = /^([a-z_]+)@(\d+\.\d+\.\d+)(?:\+(cid1|sha256):([0-9a-f]{64}))?$/;

interface Stack { name: string; base: string; api: APIRequestContext }
let ref: Stack;
let story: Stack;
const createdProjects: string[] = [];
let linked: { projectId: string; datasetId: string } | null = null;

async function open(name: string, base: string): Promise<Stack> {
  const bootstrap = await apiRequest.newContext();
  const res = await bootstrap.post(`${base}/api/v1/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
  expect(res.ok(), `${name} login → ${res.status()}`).toBeTruthy();
  const { accessToken } = await res.json();
  await bootstrap.dispose();
  return { name, base, api: await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } }) };
}

async function get<T = any>(s: Stack, path: string, ws?: string): Promise<T> {
  const res = await s.api.get(`${s.base}${path}`, { headers: ws ? { 'X-Workspace-Id': ws } : {} });
  expect(res.status(), `${s.name} GET ${path}: ${await res.text()}`).toBe(200);
  return res.json();
}

/** Drop the keys §10.4 item 3 lets differ (identity strings and hashes), recursively. */
function withoutIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIdentity);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !['configVersion', 'registryHash', 'version'].includes(k))
        .map(([k, v]) => [k, withoutIdentity(v)]),
    );
  }
  return value;
}

/** Ordered pairs — the alias map's key order is content (first claimant wins). */
const ordered = (o: Record<string, unknown> | undefined) => Object.entries(o ?? {});

/** The stored extension revision hashes of `projectId` (`'*'` = of every project). Read only. */
function extensionHashesOf(projectId: string): string[] {
  if (projectId === '*') return psqlRows('SELECT DISTINCT content_hash FROM organization_svc.project_semantic_profile_extensions');
  if (!/^[0-9a-f-]{36}$/.test(projectId)) throw new Error('projectId must be a uuid');
  return psqlRows(`SELECT content_hash FROM organization_svc.project_semantic_profile_extensions WHERE project_id = '${projectId}'`);
}

/** Is `pin` (stored, older format) the same content as the unhashed row identity `actual`? */
function sameContentLegacy(pin: string, actual: string, projectId: string): boolean {
  const p = STORED_IDENTITY.exec(pin);
  const a = STORED_IDENTITY.exec(actual);
  if (!p || !a || p[1] !== a[1] || p[2] !== a[2] || a[3]) return false;
  if (p[3] !== 'sha256') return false;
  return PLATFORM_LEGACY_HASHES[p[1]] === p[4] || extensionHashesOf(projectId).includes(p[4]);
}

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.beforeAll(async () => {
  ref = await open('reference', REF_API_BASE_URL);
  story = SAME_STACK ? ref : await open('story', API_BASE_URL);
});

test.afterAll(async () => {
  if (story) {
    if (linked) await story.api.delete(`${story.base}/api/v1/projects/${linked.projectId}/datasets/${linked.datasetId}`, { headers: { 'X-Workspace-Id': WS_IO } });
    for (const id of createdProjects) await story.api.delete(`${story.base}/api/v1/projects/${id}`, { headers: { 'X-Workspace-Id': WS_IO } });
  }
  await ref?.api.dispose();
  if (story && story !== ref) await story.api.dispose();
});

test.describe('AXI-2803 profile identity, baseline and legacy conversion @SI-014', () => {
  test('AC69, AC60, FR1 — 4.1: the profile list is unchanged; the three converted profiles read 2.0.0', { tag: ['@SI-014'] }, async () => {
    const [a, b] = await Promise.all([get<any[]>(ref, '/api/v1/semantic-profiles'), get<any[]>(story, '/api/v1/semantic-profiles')]);
    expect(b.map((p) => p.id)).toEqual(LIST_ORDER);
    expect(b.map((p) => [p.id, p.displayName ?? p.display_name])).toEqual(a.map((p) => [p.id, p.displayName ?? p.display_name]));
    for (const p of b) expect(p.version, p.id).toBe(CONVERTED.includes(p.id) ? '2.0.0' : '1.0.0');
  });

  test('AC1, AC2, AC3 — 4.2: converted profiles resolve to the same content; only immunology gains template roles', { tag: ['@SI-014'] }, async () => {
    for (const id of [...CONVERTED, 'immune_mediated', 'immune_mediated_microbiota']) {
      const [a, b] = await Promise.all([get(ref, `/api/v1/semantic-profiles/${id}/resolved`), get(story, `/api/v1/semantic-profiles/${id}/resolved`)]);
      for (const section of ['canonicalFields', 'vocabulary', 'filters', 'chartPresets', 'matchingRules']) {
        expect(b[section], `${id}.${section}`).toEqual(a[section]);
      }
      expect(ordered(b.aliasMap), `${id}.aliasMap (key order)`).toEqual(ordered(a.aliasMap));
      expect(b.registryHash, `${id}.registryHash`).toMatch(/^[0-9a-f]{64}$/);
      if (CONVERTED.includes(id)) {
        expect(b.levels ?? null, `${id}.levels`).toBeNull();
        expect(b.qualifiers ?? null, `${id}.qualifiers`).toBeNull();
        expect(b.packs, `${id}.packs`).toEqual([id]);
        expect(b.templateRoles ?? {}, `${id}.templateRoles`).toEqual(
          id === 'immunology' ? { age: 'continuous_outcome', sex: 'group', cohort_arm: 'group', response_status: 'group' } : {},
        );
      } else {
        expect(withoutIdentity(b), `${id} (every section but the identity)`).toEqual(withoutIdentity(a));
      }
    }
  });

  test('AC60, AC71 — 4.3: existing projects keep their semantic contract and matched columns', { tag: ['@SI-014', '@SI-013'] }, async () => {
    for (const p of PROJECTS) {
      const [ca, cb] = await Promise.all([
        get(ref, `/api/v1/projects/${p.id}/semantic-contract`, p.ws),
        get(story, `/api/v1/projects/${p.id}/semantic-contract`, p.ws),
      ]);
      expect(withoutIdentity(cb), `${p.name} contract`).toEqual(withoutIdentity(ca));
      const m = CURRENT_IDENTITY.exec(cb.profile.configVersion);
      expect(m, `${p.name} configVersion ${cb.profile.configVersion}`).not.toBeNull();
      expect(m![1]).toBe(p.profile);
      expect(m![2]).toBe(CONVERTED.includes(p.profile) ? '2.0.0' : ca.profile.version);
      const [ma, mb] = await Promise.all([
        get(ref, `/api/v1/projects/${p.id}/field-mappings`, p.ws),
        get(story, `/api/v1/projects/${p.id}/field-mappings`, p.ws),
      ]);
      expect(mb, `${p.name} field mappings`).toEqual(ma);
    }
  });

  test('AC66, AC9, AC10, AC71 — 4.4: question data of a finalised study is unchanged; only same-content pin drift is gone', { tag: ['@SI-065'] }, async () => {
    const versions = psqlRows(
      `SELECT s.id || '|' || v.id FROM organization_svc.saps s JOIN organization_svc.sap_versions v ON v.sap_id = s.id ` +
        `WHERE s.project_id = '${DEMO_2411.id}' AND v.status = 'final' ORDER BY v.id`,
    );
    expect(versions.length, 'Demo 2411 has final SAP versions').toBeGreaterThan(0);
    for (const row of versions) {
      const [sapId, versionId] = row.split('|');
      const path = `/api/v1/projects/${DEMO_2411.id}/saps/${sapId}/versions/${versionId}/question-data`;
      const [a, b] = await Promise.all([get(ref, path, DEMO_2411.ws), get(story, path, DEMO_2411.ws)]);
      const strip = (d: any) => ({ ...d, questions: d.questions.map((q: any) => ({ ...q, resolution: { ...q.resolution, pinDrift: undefined } })) });
      expect(strip(b), `${versionId} (all but pinDrift)`).toEqual(strip(a));
      a.questions.forEach((qa: any, i: number) => {
        const before: any[] = qa.resolution.pinDrift ?? [];
        const after: any[] = b.questions[i].resolution.pinDrift ?? [];
        for (const e of after) expect(before, `${versionId} q${i}: a new drift entry`).toContainEqual(e);
        for (const e of before.filter((x) => !after.some((y) => JSON.stringify(y) === JSON.stringify(x)))) {
          expect(sameContentLegacy(e.profilePin, e.actualConfigVersion, DEMO_2411.id), `${versionId} q${i}: dropped ${e.profilePin} vs ${e.actualConfigVersion}`).toBe(true);
        }
      });
    }
  });

  test('AC7 — 4.5: a converted profile can be extended (no "has no manifest" refusal)', { tag: ['@SI-014'] }, async () => {
    const res = await story.api.post(`${story.base}/api/v1/projects`, {
      headers: { 'X-Workspace-Id': WS_IO },
      data: { name: `E2E AXI-2803 extension ${Date.now()}`, workspaceId: WS_IO, semanticProfileId: 'immunology' },
    });
    expect(res.status(), await res.text()).toBe(201);
    const projectId: string = (await res.json()).id;
    createdProjects.push(projectId);
    const field = `project.${projectId}.e2e_titer`;
    const ext = await story.api.post(`${story.base}/api/v1/semantic-profiles/projects/${projectId}/extensions`, {
      headers: { 'X-Workspace-Id': WS_IO },
      data: { packs: [{ registry_id: `canonical_fields.project.${projectId}.v1`, fields: [field] }] },
    });
    const body = await ext.text();
    expect(ext.status(), body).toBe(201);
    expect(body).not.toContain('has no manifest');
    expect(JSON.parse(body).configVersion).toMatch(CURRENT_IDENTITY);
    const contract = await get(story, `/api/v1/projects/${projectId}/semantic-contract`, WS_IO);
    expect(contract.canonicalFields).toContain(field);
  });

  test('AC13, AC5 — 4.6: link-time and normalise rows carry one identity format and match as before', { tag: ['@SI-014', '@SI-013'] }, async () => {
    const res = await story.api.post(`${story.base}/api/v1/projects`, {
      headers: { 'X-Workspace-Id': WS_IO },
      data: { name: `E2E AXI-2803 link ${Date.now()}`, workspaceId: WS_IO, semanticProfileId: 'immuno_oncology' },
    });
    expect(res.status(), await res.text()).toBe(201);
    const projectId: string = (await res.json()).id;
    createdProjects.push(projectId);
    const link = await story.api.post(`${story.base}/api/v1/projects/${projectId}/datasets`, { headers: { 'X-Workspace-Id': WS_IO }, data: { datasetId: RIAZ_DATASET } });
    expect(link.status(), await link.text()).toBe(201);
    linked = { projectId, datasetId: RIAZ_DATASET };

    const contract = await get(story, `/api/v1/projects/${projectId}/semantic-contract`, WS_IO);
    const identitiesOf = () => psqlRows(`SELECT DISTINCT config_version FROM organization_svc.project_field_mappings WHERE project_id = '${projectId}'`);
    const atLink = identitiesOf();
    expect(atLink, 'link-time rows carry the ONE current identity').toEqual([contract.profile.configVersion]);
    expect(atLink[0]).toMatch(/^immuno_oncology@2\.0\.0\+cid1:[0-9a-f]{64}$/);

    const rows = await get(story, `/api/v1/projects/${projectId}/datasets/${RIAZ_DATASET}/field-mappings`, WS_IO);
    const riazRows = await get(ref, `/api/v1/projects/${RIAZ.id}/datasets/${RIAZ_DATASET}/field-mappings`, RIAZ.ws);
    expect(rows, 'matched columns equal the Riaz 2017 rows for that dataset').toEqual(riazRows);

    const norm = await story.api.post(`${story.base}/api/v1/semantic-profiles/projects/${projectId}/normalize`, { headers: { 'X-Workspace-Id': WS_IO } });
    expect(norm.status(), await norm.text()).toBe(200);
    const report = await norm.json();
    expect(report.totals).toMatchObject({ filled: 0, created: 0, divergences: 0 });
    expect(identitiesOf(), 'normalise writes the same identity string').toEqual(atLink);
    expect(await get(story, `/api/v1/projects/${projectId}/datasets/${RIAZ_DATASET}/field-mappings`, WS_IO)).toEqual(rows);
  });

  test('AC14, AC4 — 5.1: every stored identity string is current, unhashed-known, a ledger entry or its project\'s extension revision', { tag: ['@SI-014'] }, async () => {
    const profiles = new Set(LIST_ORDER);
    const classify = (identity: string, projectId: string): string | null => {
      const m = STORED_IDENTITY.exec(identity);
      if (!m || !profiles.has(m[1])) return `not a profile identity: ${identity}`;
      if (!m[3]) return null; // unhashed `<id>@<version>` of a known profile
      if (m[3] === 'cid1') return null; // the new format (minted by the story stack)
      if (PLATFORM_LEGACY_HASHES[m[1]] === m[4]) return null;
      return extensionHashesOf(projectId).includes(m[4]) ? null : `unknown hash ${identity} (project ${projectId})`;
    };
    const stored = [
      ...psqlRows(`SELECT DISTINCT project_id || '|' || config_version FROM organization_svc.project_field_mappings WHERE config_version IS NOT NULL`),
      ...psqlRows(
        `SELECT DISTINCT s.project_id || '|' || (p #>> '{}') FROM organization_svc.sap_versions v JOIN organization_svc.saps s ON s.id = v.sap_id, ` +
          `jsonb_path_query(v.plan::jsonb, 'strict $.**.profilePin') p`,
      ),
      ...psqlRows(
        // A declaration is keyed by dataset, not project: its fill's extension hash is checked
        // against every project's revisions ('*').
        `SELECT DISTINCT '*|' || substr(d.declared_by, length('system:semantic-profile:') + 1) FROM organization_svc.dataset_semantic_declarations d ` +
          `WHERE d.declared_by LIKE 'system:semantic-profile:%'`,
      ),
    ];
    expect(stored.length).toBeGreaterThan(0);
    const problems = stored.map((r) => { const [projectId, identity] = r.split('|'); return classify(identity, projectId); }).filter(Boolean);
    expect(problems).toEqual([]);
  });
});

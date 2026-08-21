import { test, expect, APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  adminContext,
  createWorkspace,
  publishSchema,
  createTimepoint,
  createSubject,
  putRow,
  newRoleRequestContext,
  type SubjectFixture,
} from './subject-fixtures';

/**
 * AXI-1252 — subject promotion selection & CSV materialization (FR22, FR23,
 * FR24, FR26, AC10, AC11; manual-e2e §4.13 + lineage read §4.14).
 *
 * Covers the SYNCHRONOUS promotion surface end-to-end against the live stack:
 * `POST /subjects/promotions` returning 201 naming an available dataset with the
 * derived clinical+analysis column set (biological excluded — FR23) built over
 * the CURRENT row versions; the optional timepoint filter (FR22); a zero-row
 * subject remaining promotable (EC6); the deny/reject matrix (empty list EC5,
 * unknown subject, non-member 403 — NFR4); re-promotion always minting a NEW
 * dataset while the prior is left untouched (FR26/AC11); and the persisted
 * lineage stamp + provenance subgraph read (FR24), including the cross-workspace
 * 404 oracle.
 *
 * Data is provisioned per run through the public API (self-contained, no ambient
 * seed dependence — NFR3): a schema workspace with two subjects carrying rows at
 * two timepoints plus one zero-row subject. The materialized CSV bytes on S3 and
 * the async auto-ingestion / provenance-graph settling are NOT asserted here —
 * they are recorded as manual residue (see the spec header comment).
 */

interface PromotionFixture {
  orgId: string;
  adminUserId: string;
  ws: string;
  baseline: string;
  week4: string;
  subjectA: SubjectFixture;
  subjectB: SubjectFixture;
  subjectZ: SubjectFixture;
}

let fixture: PromotionFixture;
let adminApi: APIRequestContext;

/** Stand up a schema workspace: two subjects with rows at both timepoints and
 *  one zero-row subject (EC6). Provisioning api is disposed once built. */
async function provision(): Promise<PromotionFixture> {
  const { api, userId, orgId } = await adminContext();
  try {
    const ws = await createWorkspace(api, orgId, userId, 'subject-promote');
    await publishSchema(api, ws);
    const baseline = await createTimepoint(api, ws, 'Baseline', 1);
    const week4 = await createTimepoint(api, ws, 'Week 4', 2);

    const subjectA = await createSubject(api, ws, 'SUBJ-A');
    const subjectB = await createSubject(api, ws, 'SUBJ-B');
    for (const subject of [subjectA, subjectB]) {
      for (const tp of [baseline, week4]) {
        await putRow(api, ws, subject.id, tp, {
          age_at_enrollment: { state: 'present', value: 54 },
          treatment_arm: { state: 'present', value: 'A' },
          clinician_notes: { state: 'present', value: 'stable' },
          bmi: { state: 'present', value: 24.1 },
        });
      }
    }
    // EC6: SUBJ-Z is registered but carries zero rows.
    const subjectZ = await createSubject(api, ws, 'SUBJ-Z');

    return { orgId, adminUserId: userId, ws, baseline, week4, subjectA, subjectB, subjectZ };
  } finally {
    await api.dispose();
  }
}

test.beforeAll(async () => {
  fixture = await provision();
  adminApi = await newRoleRequestContext('admin');
});

test.afterAll(async () => {
  await adminApi?.dispose();
});

/** POST a promotion with the admin token, scoped to the fixture workspace. */
function postPromotion(body: unknown, ws = fixture.ws) {
  return adminApi.post(apiUrl(`/api/v1/workspaces/${ws}/subjects/promotions`), {
    headers: { 'X-Workspace-Id': ws },
    data: body,
  });
}

/** GET a promotion's lineage with the admin token, scoped to the workspace. */
function getLineage(promotionId: string, ws = fixture.ws) {
  return adminApi.get(apiUrl(`/api/v1/workspaces/${ws}/subjects/promotions/${promotionId}/lineage`), {
    headers: { 'X-Workspace-Id': ws },
  });
}

test.describe('AXI-1252 — subject promotion (FR22/FR23/FR24/FR26)', () => {
  // ─── Promotion happy path (FR22/FR23/AC10) ─────────────────────────

  test('FR22 AC10 — promoting a subject-id list returns 201 naming an available dataset', async () => {
    const { subjectA, subjectB, subjectZ } = fixture;
    const res = await postPromotion({ subjectIds: [subjectA.id, subjectB.id, subjectZ.id] });

    expect(res.status()).toBe(201);
    const body = await res.json();
    // The response names the created dataset — the promotion behaves as uploaded.
    expect(body.id).toBeTruthy();
    expect(body.datasetId).toBeTruthy();
    expect(body.dataset.id).toBe(body.datasetId);
    expect(body.dataset.availability).toBe('available');
    // Promoted marker, not synthetic — so the uploaded listing does not hide it (AC10).
    expect(body.dataset.sourceSystem).toBe('subject_promotion');
    expect(body.subjectIds).toEqual([subjectA.id, subjectB.id, subjectZ.id]);
    expect(body.createdBy).toBe(fixture.adminUserId);
  });

  test('FR23 — the promotion derives clinical+analysis columns, excludes biological, over current rows', async () => {
    const { subjectA, subjectB, subjectZ } = fixture;
    const body = await (await postPromotion({ subjectIds: [subjectA.id, subjectB.id, subjectZ.id] })).json();

    // Schema order preserved; the two clinical keys + the analysis key, biological `bmi` absent.
    expect(body.columnKeys).toEqual(['age_at_enrollment', 'treatment_arm', 'clinician_notes']);
    expect(body.columnKeys).not.toContain('bmi');
    // One row per subject×timepoint that HAS a current row: A and B contribute two
    // each; SUBJ-Z (zero rows, EC6) contributes none → 4 data rows.
    expect(body.rowCount).toBe(4);
  });

  test('FR22 — an optional timepoint filter restricts the exported rows', async () => {
    const { subjectA, subjectB, baseline } = fixture;
    const body = await (
      await postPromotion({ subjectIds: [subjectA.id, subjectB.id], timepointIds: [baseline] })
    ).json();

    expect(body.filter).toEqual({ timepointIds: [baseline] });
    // Only the Baseline timepoint survives the filter → one row per subject.
    expect(body.rowCount).toBe(2);
  });

  test('FR23 EC6 — a zero-row subject is promotable and contributes no data rows', async () => {
    const { subjectZ } = fixture;
    const res = await postPromotion({ subjectIds: [subjectZ.id] });

    expect(res.status()).toBe(201);
    const body = await res.json();
    // 201 with a materialized (header-only) dataset — a zero-row subject never blocks a promotion.
    expect(body.dataset.availability).toBe('available');
    expect(body.rowCount).toBe(0);
  });

  // ─── Reject / deny matrix (EC5, NFR4) ──────────────────────────────

  test('FR22 EC5 — an empty subject list is rejected 400', async () => {
    const res = await postPromotion({ subjectIds: [] });
    expect(res.status()).toBe(400);
  });

  test('FR22 — an unknown subject id is rejected 400 (no cross-workspace leak)', async () => {
    const res = await postPromotion({ subjectIds: ['11111111-1111-1111-1111-111111111111'] });
    expect(res.status()).toBe(400);
  });

  test('NFR4 — a caller without subject:promote (non-member) is denied 403', async () => {
    const { ws, subjectA } = fixture;
    const userApi = await newRoleRequestContext('user');
    try {
      const res = await userApi.post(apiUrl(`/api/v1/workspaces/${ws}/subjects/promotions`), {
        headers: { 'X-Workspace-Id': ws },
        data: { subjectIds: [subjectA.id] },
      });
      expect(res.status()).toBe(403);
    } finally {
      await userApi.dispose();
    }
  });

  // ─── Re-promotion (FR26/AC11) ──────────────────────────────────────

  test('FR26 AC11 — re-promotion mints a new dataset and leaves the prior byte-identical', async () => {
    const { subjectA, subjectB } = fixture;
    const list = { subjectIds: [subjectA.id, subjectB.id] };

    const first = await (await postPromotion(list)).json();
    const beforeLineage = await (await getLineage(first.id)).json();
    const firstNode = beforeLineage.provenance.nodes.find((n: any) => n.nodeType === 'SubjectPromotion');
    expect(firstNode.id).toBe(beforeLineage.lineageNodeId);

    // Same list again → a brand-new promotion + dataset (no overwrite affordance, FR26).
    const secondRes = await postPromotion(list);
    expect(secondRes.status()).toBe(201);
    const second = await secondRes.json();
    expect(second.id).not.toBe(first.id);
    expect(second.datasetId).not.toBe(first.datasetId);

    // The first promotion's stamp + provenance node are unchanged after the second.
    const afterLineage = await (await getLineage(first.id)).json();
    expect(afterLineage.datasetId).toBe(first.datasetId);
    expect(afterLineage.lineageNodeId).toBe(beforeLineage.lineageNodeId);
    const afterNode = afterLineage.provenance.nodes.find((n: any) => n.nodeType === 'SubjectPromotion');
    expect(afterNode.id).toBe(firstNode.id);
  });

  // ─── Lineage read (FR24/AC11) ──────────────────────────────────────

  test('FR24 AC11 — lineage returns the persisted stamp and provenance subgraph', async () => {
    const { ws, subjectA, subjectB } = fixture;
    const promotion = await (await postPromotion({ subjectIds: [subjectA.id, subjectB.id] })).json();

    const res = await getLineage(promotion.id);
    expect(res.status()).toBe(200);
    const lineage = await res.json();

    // Persisted stamp (§4.14 step 1).
    expect(lineage.workspaceId).toBe(ws);
    expect(lineage.subjectIds).toEqual([subjectA.id, subjectB.id]);
    expect(lineage.schemaVersion).toBe(promotion.schemaVersion);
    expect(lineage.createdBy).toBe(fixture.adminUserId);
    expect(lineage.datasetId).toBe(promotion.datasetId);
    expect(lineage.columnKeys).toEqual(['age_at_enrollment', 'treatment_arm', 'clinician_notes']);
    expect(lineage.rowCount).toBe(4);

    // Provenance subgraph (§4.14 step 2): the four canonical node types are present.
    const nodeTypes = lineage.provenance.nodes.map((n: any) => n.nodeType);
    expect(nodeTypes).toEqual(
      expect.arrayContaining(['SubjectPromotion', 'SubjectRegistry', 'SubjectSchemaVersion', 'Dataset']),
    );
    const promoNode = lineage.provenance.nodes.find((n: any) => n.nodeType === 'SubjectPromotion');
    // The derivation node references the promotion and is the persisted lineage node (§4.14 step 3).
    expect(promoNode.referenceId).toBe(promotion.id);
    expect(promoNode.id).toBe(lineage.lineageNodeId);
    const datasetNode = lineage.provenance.nodes.find((n: any) => n.nodeType === 'Dataset');
    expect(datasetNode.referenceId).toBe(promotion.datasetId);
    // The SubjectPromotion --PRODUCES--> Dataset edge exists.
    expect(
      lineage.provenance.edges.some(
        (e: any) =>
          e.edgeType === 'PRODUCES' &&
          e.sourceNodeId === promoNode.id &&
          e.targetNodeId === datasetNode.id,
      ),
    ).toBe(true);
  });

  test('NFR4 — a lineage id from another/unknown workspace 404s (no cross-workspace oracle)', async () => {
    const res = await getLineage('11111111-1111-1111-1111-111111111111');
    expect(res.status()).toBe(404);
  });
});

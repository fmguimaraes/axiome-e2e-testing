import { test, expect } from '@playwright/test';
import { arrange, disposeArranged, ensureViewerMember, openSession, type Arranged } from './harness/session';
import { seedFinalizedEvidence, supersedeEvidence, linkEvidenceIntoAnalysisGraph, dropSupersedeEdge, uniq } from './harness/seed';

/**
 * AXI-1650 (FR23, AC11) automating AXI-1648 (SUPERSEDED_BY edge in the provenance
 * graph) — replaces the AXI-886 graph check done by reading provenance rows in SQL.
 * Scenarios E2E-1640-H1..H2. The evidence node is linked into a view analysis by a
 * single fixture edge (see linkEvidenceIntoAnalysisGraph).
 */
test.use({ storageState: { cookies: [], origins: [] } });

let ctx: Arranged;

test.beforeAll(async () => {
  ctx = await arrange();
  // The provenance page needs platform-admin AND workspace membership (else 'Workspace not found').
  await ensureViewerMember(ctx.api, ctx.t, 'admin', 'admin');
});
test.afterAll(async () => {
  await disposeArranged(ctx);
});

const graphUrl = (analysisId: string) => `/projects/${ctx.t.projectId}/view-analyses/${analysisId}/provenance`;

test('AC8 @SI-033 — E2E-1640-H1: a superseded evidence shows the SUPERSEDED_BY edge v1 to v2, labelled, with the superseded chip on v1', async ({ page }) => {
  const v1 = await seedFinalizedEvidence(ctx.api, ctx.t);
  await supersedeEvidence(ctx.api, ctx.t, v1.evidence_id, `graph chain ${uniq()}`);
  const analysisId = await linkEvidenceIntoAnalysisGraph(ctx.api, ctx.t, v1.evidence_id);

  // Contract: the graph read returns the edge with the chain facts.
  const g = await ctx.api.get(`/api/v1/view-analyses/${analysisId}/provenance-graph`, ctx.t.headers);
  const edge = g.body.edges.find((e: any) => e.edgeType === 'SUPERSEDED_BY');
  expect(edge, 'SUPERSEDED_BY edge present in the analysis graph').toBeTruthy();
  expect(edge.metadata.priorEvidenceVersion).toBe(1);
  expect(edge.metadata.newEvidenceVersion).toBe(2);

  // The page gates on a platform admin or a project-role permission; the tenant owner has no project role.
  await openSession(page, 'platform', ctx.t);
  await page.goto(graphUrl(analysisId));
  await expect(page.getByTestId('evidence-reference-node')).toHaveCount(2);
  await expect(page.getByText('superseded by v2', { exact: false }).first()).toBeVisible();
  const superseded = page.locator('[data-testid="evidence-reference-node"][data-superseded="true"]');
  await expect(superseded).toHaveCount(1);
  await expect(superseded.getByTestId('superseded-chip')).toBeVisible();
  await expect(page.locator('[data-testid="evidence-reference-node"][data-superseded="false"]')).toHaveCount(1);
});

test('AC8 @SI-033 — E2E-1640-H2: a supersede whose graph edge was never projected shows no edge and no superseded mark', async ({ page }) => {
  const v1 = await seedFinalizedEvidence(ctx.api, ctx.t);
  await supersedeEvidence(ctx.api, ctx.t, v1.evidence_id, `unprojected ${uniq()}`);
  expect(dropSupersedeEdge(v1.evidence_id), 'fixture needs the local Postgres container').toBe(true);
  const analysisId = await linkEvidenceIntoAnalysisGraph(ctx.api, ctx.t, v1.evidence_id);

  const g = await ctx.api.get(`/api/v1/view-analyses/${analysisId}/provenance-graph`, ctx.t.headers);
  expect(g.body.edges.filter((e: any) => e.edgeType === 'SUPERSEDED_BY')).toHaveLength(0);

  // The page gates on a platform admin or a project-role permission; the tenant owner has no project role.
  await openSession(page, 'platform', ctx.t);
  await page.goto(graphUrl(analysisId));
  await expect(page.getByTestId('evidence-reference-node')).toHaveCount(1);
  await expect(page.getByTestId('superseded-chip')).toHaveCount(0);
  await expect(page.getByText(/superseded by v\d/i)).toHaveCount(0);
});

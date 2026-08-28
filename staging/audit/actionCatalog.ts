import type { StagingAction } from './types';

/**
 * Canonical staging-action catalog (FR15 mapping input).
 *
 * Derived from Feature FR1-FR14 and the dev-epic-context "Reusable code map",
 * cross-checked against the actual controller decorators (not the loosely
 * paraphrased paths in the dev-context table — a few are corrected here, see
 * the AXI-1369 learnings block). Every action must resolve to an existing
 * route EXCEPT the four declared in `knownGap`, which are FR16's candidate
 * gaps and are closed by AXI-1374/AXI-1375, not by this story.
 */
export const STAGING_ACTIONS: StagingAction[] = [
  // --- Service account & auth (FR1/FR2) ---
  { id: 'login', description: 'service account obtains a bearer token', fr: 'FR2', method: 'POST', pathTemplate: '/api/v1/auth/login' },
  { id: 'set-theme', description: 'set light theme preference before capture', fr: 'FR2', method: 'PATCH', pathTemplate: '/api/v1/auth/preferences' },

  // --- Cast & roles (FR1/FR3) ---
  { id: 'create-user', description: 'create a cast/service account with a known password', fr: 'FR1', method: 'POST', pathTemplate: '/api/v1/users' },
  { id: 'create-role', description: 'create the service-account role', fr: 'FR1', method: 'POST', pathTemplate: '/api/v1/roles' },
  { id: 'assign-role', description: 'assign a role to a user', fr: 'FR1', method: 'POST', pathTemplate: '/api/v1/users/:userId/roles' },

  // --- Tenant (FR5) ---
  { id: 'create-organization', description: 'create the organization', fr: 'FR5', method: 'POST', pathTemplate: '/api/v1/organizations' },
  { id: 'create-workspace', description: 'create a workspace', fr: 'FR5', method: 'POST', pathTemplate: '/api/v1/workspaces' },
  { id: 'create-project', description: 'create a project', fr: 'FR5', method: 'POST', pathTemplate: '/api/v1/projects' },
  { id: 'add-workspace-member', description: 'add a cast member to a workspace', fr: 'FR5', method: 'POST', pathTemplate: '/api/v1/workspaces/:workspaceId/members' },
  { id: 'set-member-role', description: 'set a workspace member role', fr: 'FR5', method: 'PATCH', pathTemplate: '/api/v1/workspaces/:workspaceId/members/:userId/role' },
  { id: 'delete-workspace', description: 'cleanup: delete a stale E2E workspace (EC1)', fr: 'FR5', method: 'DELETE', pathTemplate: '/api/v1/workspaces/:workspaceId' },
  { id: 'delete-project', description: 'cleanup: delete a stale E2E project (EC1)', fr: 'FR5', method: 'DELETE', pathTemplate: '/api/v1/projects/:projectId' },

  // --- External stakeholder (FR13) ---
  { id: 'enable-client-exploration', description: 'enable client exploration on a project', fr: 'FR13', method: 'POST', pathTemplate: '/api/v1/projects/:projectId/client-exploration/enable' },
  { id: 'add-client-member', description: 'add the external stakeholder as a client-exploration member', fr: 'FR13', method: 'POST', pathTemplate: '/api/v1/projects/:projectId/client-exploration/members' },
  { id: 'set-client-permissions', description: 'scope the external stakeholder permissions', fr: 'FR13', method: 'PUT', pathTemplate: '/api/v1/projects/:projectId/client-exploration/members/:clientUserId/permissions' },

  // --- Dataset & ingestion (FR7/FR25) ---
  { id: 'create-dataset', description: 'create the Riaz 2017 dataset', fr: 'FR7', method: 'POST', pathTemplate: '/api/v1/workspaces/:workspaceId/datasets' },
  { id: 'create-ingestion', description: 'ingest the dataset version', fr: 'FR7', method: 'POST', pathTemplate: '/api/v1/workspaces/:workspaceId/datasets/:datasetId/ingestions' },
  { id: 'finalize-dataset', description: 'finalize the dataset (File Hash, FR25)', fr: 'FR25', method: 'PATCH', pathTemplate: '/api/v1/workspaces/:workspaceId/datasets/:datasetId/finalize' },

  // --- Analysis & assumptions (FR9) ---
  { id: 'set-scientific-question', description: 'set the analysis scientific question', fr: 'FR9', method: 'PATCH', pathTemplate: '/api/v1/view-analyses/:viewAnalysisId/review-question' },
  { id: 'create-assumption', description: 'declare an assumption', fr: 'FR9', method: 'POST', pathTemplate: '/api/v1/view-analyses/:viewAnalysisId/assumptions' },
  { id: 'withdraw-assumption', description: 'withdraw an assumption no longer true of the run', fr: 'FR9', method: 'POST', pathTemplate: '/api/v1/assumptions/:assumptionId/withdraw' },

  // --- Charts (FR8) ---
  { id: 'create-chart', description: 'create a user-origin chart', fr: 'FR8', method: 'POST', pathTemplate: '/api/v1/workspaces/:workspaceId/cohorts/:cohortId/visualizations' },
  { id: 'set-chart-title', description: 'set a chart title', fr: 'FR8', method: 'PATCH', pathTemplate: '/api/v1/workspaces/:workspaceId/datasets/:datasetId/candidates/:specId/title' },
  { id: 'set-chart-params', description: 'set a chart spec params blob', fr: 'FR8', method: 'PATCH', pathTemplate: '/api/v1/workspaces/:workspaceId/datasets/:datasetId/candidates/:specId/params' },

  // --- Thresholds ---
  { id: 'create-threshold', description: 'declare a threshold with provenance', fr: 'FR11', method: 'POST', pathTemplate: '/api/v1/thresholds' },
  { id: 'edit-threshold', description: 'edit a threshold (supersedes prior)', fr: 'FR11', method: 'POST', pathTemplate: '/api/v1/thresholds/:thresholdId/edit' },
  { id: 'archive-threshold', description: 'archive a threshold', fr: 'FR11', method: 'POST', pathTemplate: '/api/v1/thresholds/:thresholdId/archive' },

  // --- Comments (FR10) ---
  // AXI-1375 CORRECTION: the AXI-1369 audit labeled `/api/v1/comments` as the
  // "analysis-level" surface and `/api/v1/snapshot-comments` as the
  // "chart-anchored/snapshot" one — backwards from what the frontend
  // actually wires. Confirmed against `axiome-front/src/components/
  // SnapshotDiscussionPanel.tsx` (Discussion tab, type-badged, calls
  // `/api/v1/snapshot-comments` with `anchorType: 'view_analysis'`) and
  // `ChartComments.tsx` (chart detail drawer, calls `/api/v1/comments`
  // keyed on `dashboardVisualizationId`). Descriptions corrected below; ids
  // and path templates are unchanged (still correct, just mislabeled).
  { id: 'create-analysis-comment', description: 'create a chart-anchored comment (Capture Spec §7.2) — despite the id, this is /api/v1/comments, the CHART surface, not the analysis-level thread; see the AXI-1375 correction note above', fr: 'FR10', method: 'POST', pathTemplate: '/api/v1/comments' },
  { id: 'update-analysis-comment', description: 'edit a chart-anchored comment', fr: 'FR10', method: 'PATCH', pathTemplate: '/api/v1/comments/:commentId' },
  {
    id: 'resolve-analysis-comment',
    description: 'resolve a chart-anchored comment thread — CLOSED by AXI-1375 (SI-019): chart-comments.controller.ts now exposes /comments/:id/resolve, mirroring snapshot-comments/review-threads',
    fr: 'FR16',
    method: 'PATCH',
    pathTemplate: '/api/v1/comments/:commentId/resolve',
  },
  {
    id: 'reopen-analysis-comment',
    description: 'reopen a resolved chart-anchored comment thread — CLOSED by AXI-1375 (SI-019), same controller as resolve',
    fr: 'FR16',
    method: 'PATCH',
    pathTemplate: '/api/v1/comments/:commentId/reopen',
  },
  { id: 'create-snapshot-comment', description: 'create an internal analysis-level thread comment (Capture Spec §7.1) — despite the id, this is /api/v1/snapshot-comments with anchorType:view_analysis, the type-badged Discussion-tab surface; see the AXI-1375 correction note above', fr: 'FR10', method: 'POST', pathTemplate: '/api/v1/snapshot-comments' },
  { id: 'resolve-snapshot-comment', description: 'resolve an internal analysis-level comment thread (already existed pre-AXI-1375 — the precedent that made the /comments gap read as an omission)', fr: 'FR10', method: 'PATCH', pathTemplate: '/api/v1/snapshot-comments/:commentId/resolve' },
  { id: 'reopen-snapshot-comment', description: 'reopen an internal analysis-level comment thread', fr: 'FR10', method: 'PATCH', pathTemplate: '/api/v1/snapshot-comments/:commentId/reopen' },
  { id: 'create-review-thread', description: 'create a review thread', fr: 'FR10', method: 'POST', pathTemplate: '/api/v1/review-threads' },
  { id: 'resolve-review-thread', description: 'resolve a review thread (the external thread → v2 precondition)', fr: 'FR10', method: 'PATCH', pathTemplate: '/api/v1/review-threads/:threadId/resolve' },
  { id: 'list-mentionable-members', description: 'list mentionable project members', fr: 'FR10', method: 'GET', pathTemplate: '/api/v1/mention-comments/projects/:projectId/members' },
  { id: 'create-dashboard', description: 'AXI-1375: create the dashboard chart-anchored comments link onto', fr: 'FR10', method: 'POST', pathTemplate: '/api/v1/dashboards' },
  { id: 'link-dashboard-visualization', description: 'AXI-1375: link a chart candidate to a dashboard, producing the dashboardVisualizationId a chart comment anchors to', fr: 'FR10', method: 'POST', pathTemplate: '/api/v1/dashboards/:dashboardId/visualizations' },
  { id: 'enable-client-exploration-for-comments', description: 'AXI-1375: enable client exploration (external thread precondition, idempotent alongside AXI-1371/1378\'s own enable call)', fr: 'FR10', method: 'POST', pathTemplate: '/api/v1/projects/:projectId/client-exploration/enable' },
  { id: 'publish-client-exploration-artifact', description: 'AXI-1375: publish the view-analysis as a client-exploration artifact so the external thread has a valid artifactId to anchor to', fr: 'FR10', method: 'POST', pathTemplate: '/api/v1/projects/:projectId/client-exploration/published-artifacts' },
  { id: 'create-external-comment', description: 'create the external stakeholder thread comment — both the external stakeholder (authorType:client) and an internal cast reply (authorType:internal) post through this SAME route (AuthGuard only, no role check)', fr: 'FR10', method: 'POST', pathTemplate: '/api/v1/projects/:projectId/client-exploration/artifacts/:artifactId/comments' },

  // --- Snapshots (FR11, EC7) ---
  { id: 'create-snapshot', description: 'create snapshot v1/v2', fr: 'FR11', method: 'POST', pathTemplate: '/api/v1/view-analyses/snapshots' },
  { id: 'materialize-snapshot', description: 'materialize a snapshot (await completion, EC7)', fr: 'FR11', method: 'POST', pathTemplate: '/api/v1/view-analyses/snapshots/materialize' },

  // --- Governance (FR12) ---
  { id: 'create-interpretation', description: 'create an interpretation (decision draft)', fr: 'FR12', method: 'POST', pathTemplate: '/api/v1/workspaces/:workspaceId/decisions' },
  { id: 'transition-interpretation', description: 'transition an interpretation', fr: 'FR12', method: 'POST', pathTemplate: '/api/v1/workspaces/:workspaceId/decisions/:decisionId/transition' },
  { id: 'create-evidence', description: 'create an evidence record', fr: 'FR12', method: 'POST', pathTemplate: '/api/v1/view-analyses/evidences' },
  { id: 'update-evidence-status', description: 'update an evidence record status', fr: 'FR12', method: 'PATCH', pathTemplate: '/api/v1/view-analyses/evidences/:evidenceId/status' },
  { id: 'read-provenance-graph', description: 'read the provenance graph (fork check, FR12)', fr: 'FR12', method: 'GET', pathTemplate: '/api/v1/view-analyses/:viewAnalysisId/provenance-graph' },
  { id: 'publish-view', description: 'publish one view', fr: 'FR12', method: 'POST', pathTemplate: '/api/v1/view-analyses/publish' },

  // --- Attestation & export ---
  { id: 'compute-attestation', description: 'compute the quality attestation', fr: 'FR14', method: 'POST', pathTemplate: '/api/v1/attestations/compute' },
  { id: 'compute-passport', description: 'compute the dataset passport', fr: 'FR14', method: 'POST', pathTemplate: '/api/v1/attestations/passports/compute' },
  { id: 'generate-sponsor-export', description: 'generate the co-branded sponsor export', fr: 'FR14', method: 'POST', pathTemplate: '/api/v1/exports/sponsor' },
  { id: 'preview-sponsor-export', description: 'preview the sponsor export', fr: 'FR14', method: 'GET', pathTemplate: '/api/v1/exports/sponsor/:publishedVersionId/preview' },
  { id: 'org-logo-upload-url', description: 'get an upload URL for the invented sponsor mark', fr: 'FR14', method: 'POST', pathTemplate: '/api/v1/organizations/:organizationId/logo/upload-url' },
  { id: 'org-logo-finalize', description: 'finalize the org logo upload', fr: 'FR14', method: 'POST', pathTemplate: '/api/v1/organizations/:organizationId/logo/finalize' },

  // --- Events feed (FR14) ---
  { id: 'post-governance-event', description: 'post a governance-shaped event', fr: 'FR14', method: 'POST', pathTemplate: '/api/v1/events' },
  { id: 'post-engagement-event', description: 'post an engagement event', fr: 'FR14', method: 'POST', pathTemplate: '/api/v1/engagement/events' },
  { id: 'read-home-summary', description: 'read the home counters `verify` asserts non-zero (§2.3)', fr: 'FR14', method: 'GET', pathTemplate: '/api/v1/home/summary' },
  { id: 'read-home-metrics', description: 'read home metrics', fr: 'FR14', method: 'GET', pathTemplate: '/api/v1/home/metrics' },
  { id: 'read-overview-org', description: 'read org overview counters', fr: 'FR14', method: 'GET', pathTemplate: '/api/v1/overview/org' },

  // --- FR16 client-side-state candidate gaps ---
  {
    id: 'persist-display-mode',
    description: "persist a visualization's exploration/publication display mode",
    fr: 'FR16',
    method: 'PATCH',
    pathTemplate: '/api/v1/workspaces/:workspaceId/datasets/:datasetId/candidates/:specId/display-mode',
    knownGap: {
      reason: '`displayMode` lives only in the front-end `stylingPresetStore` (grep of `libs/contracts/src` and `apps/gateway/src` for "displayMode"/"display_mode" returns zero hits) — there is no persistence route at all, dedicated or generic.',
      closesInStory: 'AXI-1374',
    },
  },
  {
    id: 'persist-chart-origin-filter',
    description: 'persist the chart-origin filter used by a captured view',
    fr: 'FR16',
    method: 'PATCH',
    pathTemplate: '/api/v1/workspaces/:workspaceId/cohorts/:cohortId/visualizations/origin-filter',
    knownGap: {
      reason: '`origin` (`auto|user|derived`) is a per-visualization field, not a filter preference. `GET .../visualizations` takes no origin query param and no saved-view/styling-preset field stores an origin filter — confirmed by reading `cohort-visualizations.controller.ts` and `styling-presets.controller.ts`.',
      closesInStory: 'AXI-1374',
    },
  },
  {
    id: 'persist-volcano-axis-colour',
    description: "persist a volcano's y-axis transform and colour-by field as saved spec params",
    fr: 'FR16',
    method: 'PATCH',
    pathTemplate: '/api/v1/workspaces/:workspaceId/datasets/:datasetId/candidates/:specId/params',
    knownGap: {
      reason: 'PATCH .../candidates/:specId/params exists and accepts an untyped `Record<string, unknown>` — so a route to write there is technically present — but there is no dedicated `yAxisTransform`/`colorBy` contract field (zero hits in `libs/contracts/src`), so no server-side validation or guaranteed round-trip, and the chart renderer does not read these keys back from a saved spec today. Recorded as a partial/typed-field gap, not a missing route.',
      closesInStory: 'AXI-1374',
    },
  },
];

const DUMMY_ID = '00000000-0000-4000-8000-000000000000';

/** Substitute every `:param` in a path template with a syntactically valid dummy UUID, for route-existence probing. */
export function resolvePathTemplate(template: string): string {
  return template.replace(/:[A-Za-z]+/g, DUMMY_ID);
}

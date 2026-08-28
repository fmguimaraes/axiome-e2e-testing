import type { HttpMethod } from '../client/types';

/** One route extracted from a gateway controller's decorators. */
export interface RouteEntry {
  method: HttpMethod;
  /** Full path with the `/api/v1` version prefix, e.g. `/api/v1/thresholds/:id/edit`. */
  path: string;
  controllerClass: string;
  sourceFile: string;
}

export type RouteExistence = 'exists' | 'missing';

export interface ProbeResult {
  route: RouteEntry | undefined;
  probedPath: string;
  status: number | undefined;
  existence: RouteExistence;
  error?: string;
}

/**
 * `confirmed` — route exists, action is fully REST-backed.
 * `gap` — a declared, justified deviation (one of the four FR16 candidates);
 *         does not fail the audit, but must be closed by a later story.
 * `unexpected-missing` — probed 404 with no declared justification; FAILS the
 *         audit (FR15 — "fail the build on any action with no mapped route").
 */
export type ActionOutcome = 'confirmed' | 'gap' | 'unexpected-missing';

export interface StagingAction {
  id: string;
  description: string;
  /** Which FR this action ultimately exists to satisfy — traceability, not enforced at runtime. */
  fr: string;
  method: HttpMethod;
  /** Path template with `:param` placeholders — resolved to dummy values before probing. */
  pathTemplate: string;
  /** Set only for the four known FR16 candidate gaps; the audit records these
   *  separately instead of failing the build on them. */
  knownGap?: {
    reason: string;
    closesInStory: string;
  };
}

export interface ActionAuditRow {
  action: StagingAction;
  probedPath: string;
  routeStatus: number | undefined;
  outcome: ActionOutcome;
  evidence: string;
}

export interface ActionAuditReport {
  generatedAt: string;
  baseUrl: string;
  totalActions: number;
  confirmed: number;
  gaps: number;
  rows: ActionAuditRow[];
  duplicateRouteFindings: string[];
  unresolvedBasePathFindings: string[];
  oq2: { question: string; answer: string; evidence: string };
}

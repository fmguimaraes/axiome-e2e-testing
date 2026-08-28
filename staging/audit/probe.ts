import type { RestClient } from '../client/RestClient';
import { resolvePathTemplate } from './actionCatalog';
import type { ActionAuditRow, ActionOutcome, StagingAction } from './types';

/**
 * Route-existence probing against a running instance (the "confirm each
 * against a running instance in AXI-1369" step). A MISSING route 404s; an
 * EXISTING one answers 401/403/400/200/etc for an unauthenticated dummy
 * call — the status code itself is the evidence, never the response body.
 */

function outcomeFor(action: StagingAction, status: number | undefined): ActionOutcome {
  const exists = status !== undefined && status !== 404;
  if (action.knownGap) return 'gap';
  return exists ? 'confirmed' : 'unexpected-missing';
}

function evidenceFor(action: StagingAction, status: number | undefined): string {
  const exists = status !== undefined && status !== 404;
  if (action.knownGap) return `${action.knownGap.reason} (live probe: ${describeStatus(status)})`;
  return exists ? `route exists (probe → ${status})` : `route missing (probe → ${describeStatus(status)})`;
}

function describeStatus(status: number | undefined): string {
  return status === undefined ? 'no response / network error' : String(status);
}

/** Probe one action's resolved route and classify the outcome. */
export async function probeAction(client: RestClient, action: StagingAction): Promise<ActionAuditRow> {
  const probedPath = resolvePathTemplate(action.pathTemplate);
  const status = await safeProbeStatus(client, action, probedPath);
  return {
    action,
    probedPath,
    routeStatus: status,
    outcome: outcomeFor(action, status),
    evidence: evidenceFor(action, status),
  };
}

async function safeProbeStatus(client: RestClient, action: StagingAction, probedPath: string): Promise<number | undefined> {
  try {
    const res = await client.probe(action.method, probedPath);
    return res.status;
  } catch {
    return undefined;
  }
}

/** Probe an entire action catalog, sequentially (route probing is cheap; sequential keeps NFR7 logs readable). */
export async function probeActions(client: RestClient, actions: StagingAction[]): Promise<ActionAuditRow[]> {
  const rows: ActionAuditRow[] = [];
  for (const action of actions) {
    rows.push(await probeAction(client, action));
  }
  return rows;
}

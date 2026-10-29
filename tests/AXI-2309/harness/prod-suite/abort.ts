/**
 * AXI-2318 — the ONE way a prod-suite phase stops the run. A phase that cannot
 * proceed safely throws a {@link ProdSuiteAbort}; the suite records it in the
 * report (status `aborted`, phase + code + a bounded message) and the run goes
 * red. There is no "skip and continue" path for an isolation or fixture fault:
 * EC9 makes that a hard failure, never a fallback.
 */

export type AbortPhase = 'config' | 'isolation' | 'fixtures' | 'plan' | 'cases';

export class ProdSuiteAbort extends Error {
  constructor(
    readonly phase: AbortPhase,
    readonly code: string,
    /** The human reason alone (the report already carries phase + code). */
    readonly detail: string,
  ) {
    super(`[${phase}/${code}] ${detail}`);
    this.name = 'ProdSuiteAbort';
  }
}

/** Bound an arbitrary error message for the report (NFR3: never a body dump). */
export function boundedMessage(err: unknown, max = 300): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

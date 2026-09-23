/**
 * Structured evidence `kind` for a writer that KNOWS what it is citing (AXI-1555 —
 * see `libs/contracts/src/view-analysis/view-analysis.patterns.ts` `EVIDENCE_KINDS`
 * / `EvidenceKind`, `apps/organization-service/src/view-analyses/evidence-kind.ts`
 * `EVIDENCE_KIND_BY_RUN_KIND`/`deriveEvidenceKind` on the backend, axiome-back).
 * `kind` on `POST /view-analyses/evidences` / `PATCH .../evidences/:id` is optional
 * — omitted, the server derives it from provenance (cited snapshot's rule run,
 * then chart/table/note by shape). This module exists so a caller that already
 * holds the structural fact (which rule run kind it just ran, whether it is
 * attaching a chart with no inferential run behind it) passes it explicitly,
 * instead of the server guessing OR a client regexing it out of `title`.
 *
 * `RUN_KIND_TO_EVIDENCE_KIND` mirrors the backend's `EVIDENCE_KIND_BY_RUN_KIND`
 * exactly — same precedence (a statistical run outranks a QC run when both are
 * cited), same `null` for DESCRIBE/LEGACY_AD_HOC (a result table with no
 * inferential claim — falls through to chart/table by shape, never guessed here
 * either). This repo does not depend on `@libs/contracts` (see `package.json` —
 * no axiome-back import anywhere in `staging/**`), so the run-kind strings are
 * declared locally rather than imported; keep this map in step with the backend
 * one if `RuleRunKindEnum` ever gains a member.
 */

/** Byte-identical to the backend `EvidenceKind` (`EVIDENCE_KINDS`). */
export const EVIDENCE_KINDS = ['qc_check', 'statistical_result', 'chart', 'table', 'note'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * The run-kind strings this repo actually sees on a trace's `ruleRuns[].kind`
 * (`run.runKind` off the live rule-run response — see `runRiazQuestions.ts`).
 * Mirrors backend `RuleRunKindEnum`.
 */
export type RunKind = 'DELTA' | 'STRATIFY' | 'STATISTICAL' | 'LEGACY_AD_HOC' | 'QC' | 'JOIN' | 'DESCRIBE';

/** Mirrors backend `EVIDENCE_KIND_BY_RUN_KIND` — total over `RunKind`. */
export const RUN_KIND_TO_EVIDENCE_KIND: Readonly<Record<RunKind, Extract<EvidenceKind, 'qc_check' | 'statistical_result'> | null>> = Object.freeze({
  DELTA: 'statistical_result',
  STRATIFY: 'statistical_result',
  STATISTICAL: 'statistical_result',
  LEGACY_AD_HOC: null,
  QC: 'qc_check',
  JOIN: 'statistical_result',
  DESCRIBE: null,
});

/**
 * The structural facts an explicit-kind writer holds. Pure — no defaulting to
 * `note`: when nothing here resolves, returns `undefined` and the caller must
 * leave `kind` off the request body, letting the server derive it (this module
 * never guesses from a title).
 */
export interface EvidenceKindFacts {
  /** `run_kind`/`runKind` of every rule run behind what this evidence cites. */
  runKinds: readonly string[];
  /** Whether the payload binds at least one chart artifact (`chartEntries`). */
  hasChartEntries: boolean;
  /** Whether the payload carries a citation context (a cited table/rows). */
  hasCitationContext: boolean;
}

function isKnownRunKind(kind: string): kind is RunKind {
  return kind in RUN_KIND_TO_EVIDENCE_KIND;
}

/**
 * Same precedence as backend `deriveEvidenceKind` minus the `explicitKind`
 * short-circuit (there is none to short-circuit here — this IS the explicit
 * value the caller is about to send): statistical_result outranks qc_check,
 * then chart, then table, then `undefined` (never `note` — a writer with none
 * of these facts does not structurally know "free text", it just doesn't know).
 */
export function deriveEvidenceKind(facts: EvidenceKindFacts): EvidenceKind | undefined {
  const fromRuns = new Set(
    facts.runKinds.filter(isKnownRunKind).map((k) => RUN_KIND_TO_EVIDENCE_KIND[k]).filter((k): k is Exclude<typeof k, null> => k !== null),
  );
  if (fromRuns.has('statistical_result')) return 'statistical_result';
  if (fromRuns.has('qc_check')) return 'qc_check';
  if (facts.hasChartEntries) return 'chart';
  if (facts.hasCitationContext) return 'table';
  return undefined;
}

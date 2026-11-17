/**
 * AXI-2601 (epic AXI-2598 — FR7, NFR3) — product defects this suite has already found and
 * reported, keyed by the stable `DefectRecord.code` the step records, each pinned to its STEP.
 *
 * The step's outcome is decided from this STATIC registry against what the step observed
 * ({@link stepVerdict}), code by code:
 *  - every registered code of the step observed, nothing else → EXPECTED failure (`test.fail`):
 *    green while the defects are open;
 *  - a registered code NOT observed (its fix landed) → the step FAILS naming that code — even when
 *    another registered code of the same step is still observed — so each fix is seen the run it
 *    lands, and the entry must be removed (a stale entry can never re-absorb a regression);
 *  - an observed code NOT registered (new defect) → the step FAILS; report it, then register it.
 * Pure; unit-tested.
 */
export interface KnownDefect {
  /** The step that observes it (`S4`, `S5`, …) — the static expectation is per step. */
  step: string;
  /** One line: what the product does wrong. */
  note: string;
  /** The Jira issue that tracks the fix, when one exists. */
  jira?: string;
}

export const KNOWN_DEFECTS: Readonly<Record<string, KnownDefect>> = {
  // Found by the AXI-2601 discovery runs of 2026-11-17 (front 79fd08c3/c677865b, back 0d015f28, compute 603ef0a).
  'cc7-exploratory-position-gap': {
    step: 'S4',
    note: 'S4: an exploratory question placed first (feature §10 order) leaves the confirmatory positions 2..n — CC7 fails and finalise answers 422; the suite renumbers (confirmatory first) to go on',
  },
  'duplicate-of-foreign-dataset': {
    step: 'S5',
    note: 'S5: the same data file cannot be uploaded to a second study of the same workspace, and no "use the existing upload" path is offered (workspace-scoped duplicate check, AXI-2538)',
  },
  'numeric-coded-grouping-not-bindable': {
    step: 'S6',
    note: 'S6: a grouping field coded 0/1 (atteinte_pancreatique) measures as continuous; only a dataset semantic declaration (governs_analysis_parameters, not an Investigator right) fixes it — the suite declares it with the provisioning identity to go on',
  },
  'child-status-running-after-settle': {
    step: 'S8',
    note: 'S8: every plan child run stays "running" (interpretation step AWAITING_APPROVAL) after the plan run completed with its verdicts',
  },
  'verdict-failed-to-run-Q1-heatmap': {
    step: 'S8',
    note: 'S8: the T5@0.3 heatmap question is reported "failed to run" although its child computed the full matrix (one main row expected, 42 cells produced)',
  },
  'chart-without-preset': {
    step: 'S9',
    note: 'S9: plan result charts carry no recorded chart preset, so no chart can be saved as evidence or restyled',
  },
  'download-404-rule-run-not-found': {
    step: 'S10',
    note: 'S10: every export (csv/svg/png/report) and client report (md/pdf/zip) of a plan result answers 404 "Rule run not found"; only the run report downloads',
  },
  'dataset-delete-refused': {
    step: 'S12',
    note: 'S12: after a full run the uploaded dataset cannot be deleted (409 DATASET_DELETE_REFUSED_CITED — the plan run\'s evidence cites it), so FR6 "no residue" cannot hold',
  },
};

/** Codes may end with `*` to match a family (e.g. `no-chart-*` for every question). */
export function matchesCode(registered: string, code: string): boolean {
  return registered.endsWith('*') ? code.startsWith(registered.slice(0, -1)) : registered === code;
}

export function knownDefect(code: string, registry: Readonly<Record<string, KnownDefect>> = KNOWN_DEFECTS): KnownDefect | null {
  if (registry[code]) return registry[code];
  for (const [k, v] of Object.entries(registry)) if (k.endsWith('*') && matchesCode(k, code)) return v;
  return null;
}

/**
 * How a step with defects is to be reported: `none` (no defect), `known` (every one is
 * registered → expected failure), `new` (at least one unregistered → the step fails).
 * `continueOnDefect` (discovery runs, `HANDOVER_CONTINUE_ON_DEFECT=1`) treats every defect as known.
 */
export function classifyDefects(
  codes: readonly string[],
  continueOnDefect = false,
  registry: Readonly<Record<string, KnownDefect>> = KNOWN_DEFECTS,
): { outcome: 'none' | 'known' | 'new'; unknown: string[] } {
  if (codes.length === 0) return { outcome: 'none', unknown: [] };
  const unknown = codes.filter((c) => !knownDefect(c, registry));
  if (unknown.length === 0 || continueOnDefect) return { outcome: 'known', unknown };
  return { outcome: 'new', unknown };
}

export interface StepVerdict {
  /** `pass`: nothing registered, nothing observed. `expected-fail`: test.fail. `fail`: red. */
  outcome: 'pass' | 'expected-fail' | 'fail';
  /** Registered for this step and observed. */
  stillPresent: string[];
  /** Registered for this step but NOT observed — the fix landed; remove the entry. */
  fixed: string[];
  /** Observed but not registered for this step — a new defect. */
  unknown: string[];
  /** Why, in one line (the failure message or the expected-failure note). */
  message: string;
}

/**
 * The step's outcome from the static registry vs the codes it observed (see the module comment).
 * `continueOnDefect` (discovery runs only) expects every observed code and ignores fixed entries.
 */
export function stepVerdict(
  stepId: string,
  observed: readonly string[],
  continueOnDefect = false,
  registry: Readonly<Record<string, KnownDefect>> = KNOWN_DEFECTS,
): StepVerdict {
  const seen = [...new Set(observed)];
  const registered = Object.entries(registry).filter(([, d]) => d.step === stepId).map(([code]) => code);
  const stillPresent = registered.filter((r) => seen.some((c) => matchesCode(r, c)));
  const fixed = registered.filter((r) => !seen.some((c) => matchesCode(r, c)));
  const unknown = seen.filter((c) => !registered.some((r) => matchesCode(r, c)));
  if (continueOnDefect) {
    return seen.length > 0
      ? { outcome: 'expected-fail', stillPresent: seen, fixed: [], unknown, message: `discovery: ${seen.join(', ')}` }
      : { outcome: 'pass', stillPresent: [], fixed: [], unknown: [], message: 'no defect observed' };
  }
  const problems: string[] = [];
  if (fixed.length > 0) problems.push(`registered defect(s) NO LONGER OBSERVED — the fix landed, remove from known-defects.ts: ${fixed.join(', ')}`);
  if (unknown.length > 0) problems.push(`NEW defect(s), not in known-defects.ts for ${stepId}: ${unknown.join(', ')}`);
  if (problems.length > 0) return { outcome: 'fail', stillPresent, fixed, unknown, message: problems.join(' | ') };
  if (stillPresent.length > 0) {
    return { outcome: 'expected-fail', stillPresent, fixed, unknown, message: `known product defect(s): ${stillPresent.map((c) => `${c} — ${registry[c].note}`).join('; ')}` };
  }
  return { outcome: 'pass', stillPresent, fixed, unknown, message: 'no defect registered or observed' };
}

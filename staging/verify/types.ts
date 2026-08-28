/**
 * FR18/AC1 (AXI-1380) — the `verify` gate's result shape. `rule` names the
 * Capture Spec section (+ Feature-doc AC id, where one exists) the check
 * enforces — dev-epic-context's "assertions are named after the Capture
 * Spec rule they enforce" convention, so a failure line points a reader at
 * the spec section without opening source.
 */
export interface RuleResult {
  rule: string;
  pass: boolean;
  detail: string;
}

export function pass(rule: string, detail: string): RuleResult {
  return { rule, pass: true, detail };
}

export function fail(rule: string, detail: string): RuleResult {
  return { rule, pass: false, detail };
}

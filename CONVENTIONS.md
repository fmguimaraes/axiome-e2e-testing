# Spec conventions (scenario ↔ spec binding)

These conventions bind the human-readable scenario library
(`axiome-docs/manual-e2e/<EPIC-KEY>-<Feature>.md`) to the executable Playwright
specs here, so traceability from Feature-doc acceptance criteria to an executed
test is greppable. They are enforced mechanically by `npm run lint:specs` and by
the `AXI-1265-spec-conventions` spec (which runs in CI), not merely documented.

## Scenario side (in `manual-e2e/`)

- Every scenario carries an `automation:` tag — **`playwright`** (default) or
  **`manual`** (with a one-line reason) (FR15). An untagged scenario reads as
  `manual` and is tagged when next touched (FR16).
- Every scenario names the acceptance-criterion IDs it verifies via `_ACs:_`
  (FR17). Requirement text stays in the Feature doc — scenarios reference IDs only.

## Spec side (here)

- **Test titles lead with the AC/FR/NFR IDs they verify** (FR18/AC10):
  `test('AC3 AC4 — filter persists across reload', …)`. This makes traceability
  recoverable from the report alone, and a failure line identifies the AC without
  opening the source (NFR10). The linter rejects a title that does not.
- **No fixed-duration sleeps** — use web-first assertions (`expect(locator)…`) and
  explicit waits on conditions (NFR4). `waitForTimeout` / `sleep` are errors.
- **Semantic selectors** — prefer `getByRole`/accessible name and
  `getByTestId`/`data-testid` over raw CSS classes/ids or XPath, so behaviour-
  preserving refactors do not break the suite (NFR5). Raw locators are flagged.
- File layout: `tests/<EPIC-KEY>/<story-key>-<slug>.spec.ts` (story) and
  `tests/<EPIC-KEY>/epic-<slug>.spec.ts` (Workflow-5 cross-story flows).
- Specs consume the auth `storageState` fixtures (AXI-1264) instead of logging in
  through the UI, and read origins from the `config/env` facade (AXI-1262).

## Enforcement

```bash
npm run lint:specs      # exits non-zero on any error-severity violation
```

`scripts/lint-specs.ts` exposes `lintSource(file, source)` and
`lintSpecs(testsDir)` for programmatic use; the coverage report (AXI-1266) maps
the AC IDs in titles to specs and flags gaps/orphans.

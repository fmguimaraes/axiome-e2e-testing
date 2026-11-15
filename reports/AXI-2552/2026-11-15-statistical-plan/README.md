# AXI-2552 — E2E report (2026-11-15)

Stack: W5 validation (`:5174` front, `:3001` gateway), main after the AXI-2552 squash-merge.
Command: `playwright test AXI-2552-run-plan-add-question.spec.ts AXI-2447-wizard-plan-mode.spec.ts --no-deps --project=chromium --trace=off`
Result: **13 / 13 passed**.

| Scenario | Result | Notes |
|---|---|---|
| AXI-2552.1 no plan: Run plan disabled, Add question offered | pass | |
| AXI-2552.2 finalised plan, no Ready dataset | pass | |
| AXI-2552.3 finalise v1, neutral checklist | pass | |
| AXI-2552.4 Run plan, confirm, run for v1 | pass | confirm lands on the run detail page; Runs tab then lists 1 run |
| AXI-2552.5 Add question on finalised plan starts v2 draft | pass | v1 still readable via `/saps` (paginated) |
| AXI-2552.6 Ready returns to plan with highlight | pass | |
| AXI-2447.1 .. .7 (7 scenarios) | pass | `sap(\?highlight=...)?$` anchors after plan-mode save |

## Spec fixes made while running (no product change)

- Investigator role cannot `POST /projects` (gateway investigator-deny): fixture now creates projects with a team editor and grants the investigator.
- `uploadArmScoreDataset`: two uploads in one workspace tripped the duplicate-content guard (AXI-2538); subject ids now carry the label.
- AXI-2447.4: newest T1 now supports a one-sided alternative; assertion follows the catalogue's `supportsOneSidedAlternative`.
- AXI-2552.4: confirm navigates to the run detail page; assertion updated. AXI-2552.5: `/saps` is a PaginatedResult (`.data`).
- First cold load of the investigator SAP page can exceed 5 s on a freshly restarted Vite; initial visibility timeout raised to 30 s (environment).

## Screenshots (investigator persona; admin cannot enter the investigator surface)

- `01-empty-draft.png`
- `02-draft-with-questions.png`
- `03-finalised-plan.png`

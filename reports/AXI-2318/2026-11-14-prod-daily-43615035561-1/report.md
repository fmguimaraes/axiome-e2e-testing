# Prod E2E daily report — 43615035561-1

- **Status:** completed
- **Target:** production · **Trigger:** workflow_dispatch · **Commit:** 6bc387e20db67aa9b83cfbdbcfba2f305d7fff66
- **Started:** 2026-11-14T16:20:29.048Z · **Finished:** 2026-11-14T16:20:31.812Z
- **Test org:** 188ceb99-0cf8-4086-9f47-24b062a99d7c · **Workspace:** 2268e749-a597-4c98-b073-b836765fa331
- **Outcomes:** pass 0 · fail 0 · error 0 · not-evaluated 26 (total 26)
- **Paul's methods missing from the active catalogue:** stats.dunn_posthoc, stats.mann_whitney_u, stats.kruskal_wallis, stats.correlation, stats.partial_correlation

## Fixtures (by ID)

| key | dataset id | rawFileHash |
| --- | --- | --- |
| tableau1 | 491b44dc-14b6-40b0-a4b0-19b735528be9 | sha256:bc98a928ef3bce6a44b8bb2a180e16fb24f20bb72710697dd1ef3169e3f64b36 |
| tableau2 | 36fce514-f6a5-460f-b9c6-62b5ef125e8c | sha256:42fede8a595e05f09589910d5ba91f1602d4a5762c4f834de075d472743e3cbc |

## Cases (plan order)

| # | phase | rule | operation | outcome | reason |
| --- | --- | --- | --- | --- | --- |
| 1 | catalogue | IMM-ACT-01 | — | not-evaluated | no recipe: INTERPRET rules carry no kernel operation the suite can run on the prod fixtures |
| 2 | catalogue | IMM-CMP-01 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 3 | catalogue | IMM-CMP-02 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 4 | catalogue | IMM-CMP-03 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 5 | catalogue | IMM-CMP-04 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 6 | catalogue | IMM-CMP-05 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 7 | catalogue | IMM-CMP-06 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 8 | catalogue | IMM-CMP-07 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 9 | catalogue | IMM-CMP-08 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 10 | catalogue | IMM-CMP-09 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 11 | catalogue | IMM-CMP-10 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 12 | catalogue | IMM-CMP-11 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 13 | catalogue | IMM-CMP-12 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 14 | catalogue | IMM-CMP-13 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 15 | catalogue | IMM-CMP-14 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 16 | catalogue | IMM-COMP-01 | — | not-evaluated | rule is not runnable on the platform (runnable=false) |
| 17 | catalogue | IMM-KNOW-01 | — | not-evaluated | no recipe: INTERPRET rules carry no kernel operation the suite can run on the prod fixtures |
| 18 | catalogue | IMM-KNOW-02 | — | not-evaluated | no recipe: INTERPRET rules carry no kernel operation the suite can run on the prod fixtures |
| 19 | catalogue | IMM-QC-01 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 20 | catalogue | IMM-QC-02 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 21 | catalogue | IMM-QC-03 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 22 | catalogue | IMM-RESP-01 | — | not-evaluated | no recipe: INTERPRET rules carry no kernel operation the suite can run on the prod fixtures |
| 23 | catalogue | IMM-SAFE-01 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 24 | catalogue | IMM-SAFE-02 | qc.rule_gate | not-evaluated | no recipe for qc.rule_gate on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture |
| 25 | catalogue | IMM-SUP-01 | — | not-evaluated | no recipe: INTERPRET rules carry no kernel operation the suite can run on the prod fixtures |
| 26 | catalogue | IMM-TEX-01 | — | not-evaluated | no recipe: INTERPRET rules carry no kernel operation the suite can run on the prod fixtures |

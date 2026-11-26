# AXI-2455 W5 acceptance run, 2026-11-26

Stack: demo, primaries at origin/main (verified: front/back/bio-compute clean, 0 ahead/behind). Recorded LLM transport only. Login admin@cro-one.com (platform USER, not platform ADMIN: see Blockers). Epic held In Review (it already was).

## 1. Completeness
38 Jira children: 35 Done, 3 To Do (AXI-2495, AXI-2526, AXI-2684) = out of scope, being re-parented to AXI-2733. Every other child Done. Existing tickets 2448/2449/2451/2452/2453/2454 (tracked by comment, parents 2422/2433) all Done.

| child | status |
|---|---|
| AXI-2456 | Record the docs-only owner rulings (6, 8, 10 doc, 11, 14) | Done |
| AXI-2457 | Composition model: ordering edge, post-hoc choice and comparison set | Done |
| AXI-2458 | Template draft keeps its nodeLibraryVersion on edit (AXI-2432 A1) | Done |
| AXI-2459 | Template versions declare their main result | Done |
| AXI-2460 | Node-library operation: matrix global test and new pinned library version | Done |
| AXI-2461 | T1 and T4 new versions: alternative parameter and main-result declaration | Done |
| AXI-2462 | T3 and T5 new versions: matrix global-test step, per-cell alternative, global_p  | Done |
| AXI-2463 | T2 new composition-backed version (post-hoc choice, comparison set) | Done |
| AXI-2464 | Audited approval of boot-seeded template versions (0.3 and later) | Done |
| AXI-2465 | Apply seed step 16 (template:write grants) on demo and add it to the deploy runb | Done |
| AXI-2466 | SAP one-sided questions: sidedness drives the template alternative | Done |
| AXI-2467 | SAP main result from the template declaration; matrix global test for T3/T5 | Done |
| AXI-2468 | Plan mode: one-sided sidedness, matrix global test and T2 post-hoc options | Done |
| AXI-2469 | Wizard compiles at the newest registry version of each template | Done |
| AXI-2470 | SAP_CONTENT_INVALID returns 422 on every SAP endpoint | Done |
| AXI-2471 | First structured finalise over a legacy free-text SAP: the system supplies the r | Done |
| AXI-2472 | Run SAP dialog: classification preview (back endpoint and dialog) | Done |
| AXI-2473 | Gateway investigator-deny coverage: classify WizardRunsProxyController POST stra | Done |
| AXI-2474 | SAP-run reference: index the StepSucceeded lookup and consolidate the client-rep | Done |
| AXI-2475 | Gateway POST /rule-runs: build the payload field by field | Done |
| AXI-2476 | AXI-2444 standards debt: split the SAP-run report helpers and dedupe role text | Done |
| AXI-2477 | AXI-2446 front debt: useSapRunStart hook, verdictRows split, last good run on po | Done |
| AXI-2478 | AXI-2432 front debt: header lock after partial save, component length, UT tag sp | Done |
| AXI-2479 | Template catalog: palette shows operation labels; recipe-kind rows can be versio | Done |
| AXI-2480 | Retire the skipped legacy SAP e2e specs; rewrite AXI-2311/2313 on a Run SAP chil | Done |
| AXI-2481 | E2E: pin the newest T1 in the AXI-2438/2439/2441 specs | Done |
| AXI-2482 | Reused-step sibling reads leak the source run across projects; document source_n | Done |
| AXI-2483 | Gateway glossary term update: a body id/workspaceId overrides the route params ( | Done |
| AXI-2484 | Gateway sweep: inline @Body() types skip the whitelist and spread the body into  | Done |
| AXI-2495 | SYSTEM-scope glossary terms are editable by any workspace editor (missing authz  | To Do |
| AXI-2526 | Guided-run engine: chain a second operation node reading a prior node's result ( | To Do |
| AXI-2531 | Role-edit UI has no toggle for sap:write | Done |
| AXI-2532 | Split sap:write into granular CRUD SAP permissions | Done |
| AXI-2566 | Analysis Templates nav + catalog read gated on template:read | Done |
| AXI-2577 | Investigator menu order + new rules:method-read permission (read-only Rules for  | Done |
| AXI-2578 | Investigator rules:method-read sees entitled published system rules (visibility  | Done |
| AXI-2582 | Workflow detail page: visual flow view (node graph, selection animation, header  | Done |
| AXI-2684 | figure-validation MSR cross-check: 'stats.matrix_global_test' exemption has no M | To Do |Traceability (epic-doc table vs the epic's own "Requirement References"): 0 unmapped IDs (72 expected IDs, 114 table rows, all mapped to Done stories). Gaps: Done children AXI-2483, 2484, 2531, 2566, 2577, 2578, 2582 appear in no Traceability or Child Stories row (2531/2532 partly). Doc drift: AXI-2650/2651 (epic AXI-2631) removed the SAP run model after this epic merged; the epic doc and feature doc FR/AC for Run SAP (AXI-2466 run leg, 2467 run leg, 2472, 2474, 2476, 2477, 2480, FR37/FR55-57/FR64-65/FR71/AC21/AC36) still read as live.

## 2. Integrated E2E (tests/AXI-2455, workers=1, chromium)
Final whole-folder run: 115 tests = 88 passed, 11 failed, 1 skipped, 15 not run (serial cascade). So 88/115 pass. Of the 11 failures: 0 confirmed product regressions; 7 are retired/stale specs, 2 fixture drift, 2 need a platform admin. 1 suspected product/UI item (AXI-2468.4, see D1).
Run 1 (original) was 66/111. I fixed 6 stale specs (no product code): 2448.A3 (missing pivot), 2452.1 (sapRun field removed by AXI-2650), 2457.1 (six checks since AXI-2459), 2466/2467 (no draft discard; 409 SAP_DRAFT_EXISTS), 2468 (URL now workspace-prefixed with ?highlight), 2466.1/.2 run leg dropped. 2464 needs E2E_SEED_APPROVAL_SCRIPT set to the primary back path (worktree path default absent).
Specs added: tests/AXI-2455/epic-template-sap-wizard-seam.spec.ts (4 tests, all pass): epic-1 registry newest = wizard version = SAP-catalog isNewest and declares mainResult for T1-T5; epic-2 immutable 0.2 declare no main result and T2 has no 0.4; epic-3 T3/T5 whole-matrix global_p + one-cell pins point at it; epic-4 (converted from manual AXI-2484.2) forged body key 400 / foreign workspaceId 403.
Failing/not-run in final run: AXI-2454 AC2 (+AC3, AC4 not run), AXI-2482.1, AXI-2465.A1, AXI-2467.4(+.5), AXI-2468.4 (+.5 not run), AXI-2471.3, AXI-2472.1-.4, AXI-2474.1-.2/.4, AXI-2477.1-.2, AXI-2479.C2 (+C3 needs platform admin), AXI-2532.1-.6. Passing in targeted re-runs: 2466.3-.5, 2467.1-.3, 2468.1-.3/.5.

Manual-tag reasons re-verified:
| scenario | reason | verdict |
|---|---|---|
| 2532.7 role-editor six rows | "no test ids" (harness choice, not a gap) | CONVERTIBLE; not converted: needs platform admin identity (System Admin) to open the role editor. Residue below |
| 2532.8 New analysis without sap:read | "no wizard harness" | STALE: AXI-2308 new-analysis harness exists. CONVERTIBLE; blocked: custom role needs platform admin |
| 2474.3 index on StepSucceeded lookup | DB fact | KEPT manual; I walked it: index governed_run_events_step_output_rule_run_id_idx exists, EXPLAIN uses Bitmap Index Scan. PASS |
| 2482.3 chart-evidence 409 | hand-built request | KEPT (UT-GOVEXEC-7663) |
| 2482.4 SAP child reuse elsewhere | FR37 | OBSOLETE: SAP children removed (AXI-2650) |
| 2464.M1 runbook bullet | doc review | KEPT; walked: deploy-procedure.md lines 124-150 list both scripts. PASS |
| 2484.1 regression smoke | duplicate of feature specs | KEPT |
| 2484.2 forged body key | "API probe, no UI" | CONVERTED to epic-4 (passes) |
| 2448.A2 drift cannot be induced | no request shapes columns | KEPT (UT-RULES-7260..7265) |

## 3. Per-SI verification (E2E @SI specs on merged code; UT sets were not re-run here, per story gates)
| SI | E2E evidence | result |
|---|---|---|
| SI-002 | 2457, 2459, 2461-63, 2466, 2467 specs, epic-1..3 | green (run legs: see D2) |
| SI-010 | 2475, 2483, 2532.*, epic-4 | 2475/2483 green; 2532 blocked (platform admin) |
| SI-011 | 2465.A2 | green; 2465.A1 stale (see D3) |
| SI-013 | 2454 | AC1 green; AC2-4 blocked by fixture drift (D4) |
| SI-016, SI-047 | 2474 | retired feature (D2) |
| SI-017 | 2448, 2451, 2452, 2482 | 2448/2451/2452 green after spec fix; 2482.1 fixture drift (D4), 2482.2 green |
| SI-021, SI-052 | 2448, 2460 bio-compute op via T3/T5 resolve | green |
| SI-030/031 | 2471.1-.2/.4, 2477, 2472 | 2471.3/2472/2477 stale UI/retired (D2, D5) |
| SI-035 | 2458, 2478, 2479.C1 | green; 2479.C2/C3 blocked (platform admin) |
| SI-041 | 2464 | green (with env var) |
| SI-042 | 2480/2481 (retire/pin) | covered by the runs above; no declared-but-skipped tests left |
| SI-045, SI-069, SI-070 | 2453, 2457, 2459, 2461-63, 2469, epic-1..3 | green |
| SI-065, SI-071 | 2466.3-.5, 2467.1-.3, 2470, 2471.1/.2/.4 | green; run legs retired |
| SI-066 | 2468.1-.3/.5, 2469 | green; 2468.4 D1 |
Segregation: no touched-but-undeclared SI found in this pass (diff not re-audited; spec tags only).

## 4. DEFECTS (for AXI-2733)
D1 (suspected, needs product ruling) T5 question edit: after "use whole-matrix version" the Analysis step re-asks "Which measures do you correlate from?" (pick two or more, "cannot run without it") with nothing pre-selected, so Next cannot reach Ready. Repro: seed a draft with a primary T5 question on the one-cell version with references=score,crp and y=il6,alb; open /projects/:id/sap/questions/:qid, Back to parameters, click "use whole-matrix version"; Next. Expected: stored bindings carried over and Ready reached (spec AXI-2468.4, SAP AC40 FR74 EC36). Actual: blocked at step 3 (screenshot reports/AXI-2455/2026-11-26-w5/screenshots/*691ba*.png). Feature doc SAP BACKLOG AC40/FR74. Severity: medium (T3 analogue AXI-2468.3 passes).
D2 (test/doc debt) Specs for the removed SAP run model still in suite and fail: 2466 run leg (removed here), 2467.4/.5, 2472.1-.4, 2474.*, 2477.*. Routes POST /saps/:id/runs and GET /saps/:id/run-classification-preview return 404 since AXI-2650. Expected: retired or rewritten with the epic and feature docs marked superseded by AXI-2631. Severity: low (hygiene), but epic doc claims FR71/AC36/AC21 are delivered.
D3 (spec/doc drift) AXI-2465.A1 fails: seeded Investigator role holds template:write (seed_workspace_roles.sql, AXI-2680 save-as-workflow) while TPL FR43/AC12/AC27 and the AXI-2465 scenario say only Admin holds it. Ruling needed: amend doc+spec or remove the grant. Low.
D4 (fixture drift, not a product bug) AXI-2454 AC2-AC4 and AXI-2482.1 fail: the demo DB Investigator role (version 11, 2026-11-23, edited by a person via the role editor) holds project:manage_access, so the "investigator who cannot open source project A" can open it and reads the reused result. Product behaves per the access predicate. Specs must stop using the seeded Investigator role as the no-access reader (use a custom/Viewer role). Also: check the owner intends Investigator to hold project:manage_access (it bypasses private projects; seed step 13 says Admin only). Medium if unintended.
D5 (stale UI spec) AXI-2471.3 fails: team /projects/:id/sap now renders the Investigator page (FR99, owner ad-hoc 2026-11-24); testid sap-finalise gone. Rewrite on the new page. Low.
D6 (env) Specs needing a platform ADMIN fail as the default login admin@cro-one.com is a platform USER: 2479.C2/C3, 2532.* (create role -> 403 "Only System Admins"). Needs the owner-provided E2E_TEST_PASSWORD for test@axiomebio.com, then rerun. Not a product defect.

## 5. Human-only residue
- AXI-2532.7 / W5 walkthrough scenario 1 (needs a System Admin): System > Roles > Super Admin > Edit: six rows under SAP Management (View/Create/Edit/Discard/Finalise/Run SAP), no sap:write, Run SAP text mentions governed_execution:submit; Editor all six ticked, Viewer only View SAP.
- Walkthrough (axiome-docs/manual-e2e/AXI-2433-AXI-2455-W5-walkthrough.md) scenarios 6-7 (template save failure, catalog labels, New-version icon) need platform admin; Scenarios 9-11 (Run SAP dialog) are obsolete after AXI-2650. Scenarios 12-17 (investigator page, visual judgement) were not walked by me: owner eyes.
- Visual judgement: T5 edit flow (D1) read-through of the wizard wording.

## 6. Branch
AXI-2455-validation, worktree /home/felipe/dev/axiome/_worktrees/axiome-e2e-testing-AXI-2455-validation, commit SHA: 95345b0. Reports: reports/AXI-2455/2026-11-26-w5/ (logs, junit, results.json, screenshots; traces not committed). Scenario text for epic-1..4 was NOT written into axiome-docs/manual-e2e (outside the allowed write set); epic-1..4 are described above.

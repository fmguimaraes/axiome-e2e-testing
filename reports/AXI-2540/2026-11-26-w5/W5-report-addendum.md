# AXI-2540 W5 acceptance (FULL), 2026-11-26

## 1. Completeness
17 children: 12 Done (2541, 2542, 2543, 2548, 2549, 2550, 2551, 2559, 2560, 2561, 2563, 2565), 5 To Do and out of scope (2544, 2545, 2546, 2547, 2593; moved to AXI-2733). Every in-scope child is Done. Epic held In Review (set early, while 2455 was still in progress; not reverted).
Traceability: FR69-FR75, FR81, AC47, AC66-AC69, EC40 map only to the moved stories (they move with them). Done children 2559, 2560, 2561, 2563, 2565 (and 2593) are absent from the traceability table: doc gap.

## 2. Integrated E2E
tests/AXI-2540 whole folder: 31 = 14 passed, 4 failed, 3 skipped, 10 did not run (serial cascade). Spec added: tests/AXI-2540/epic-upload-failure-retry-and-seeded-grants.spec.ts (epic-1 pass; epic-2 skips for a non-System-Admin).
Manual reasons: 2550 sc.3 (seeded roles hold chart_style:write) converted (epic-2) and walked by read-only DB query: PASS for Editor, Approver, Admin, Investigator. 2550 sc.2 is tagged playwright but has no spec (coverage gap). 2561 UI reaction is unit-only.

## 3. Per-SI
| SI | Specs | Result |
| 2548 | 2548.1/.2/.2b pass; failed-row capture fails; ready-row skipped | partial, see D3 |
| 2549 | 5.2, 5.3 pass; 4.1/4.2 skipped | partial, see D4 |
| 2560 | all pass; epic-1 pass | green |
| 2550, 2551 | blocked "Only System Admins can create roles" (+ cascade) | unverified (D1) |
| 2561 | 2561.1 403 sap:suggested_questions | unverified (D2) |
| 2541-2543 | no E2E in this folder | not run here |

## 4. DEFECTS (for AXI-2733)
D1 (env) 2550 and 2551 specs need a platform ADMIN; admin@cro-one.com is a platform USER, so role creation returns 403 and the remaining 2551.2-.6 and 2550 test 2 did not run. Needs the owner-provided E2E_TEST_PASSWORD for test@axiomebio.com. Not a product defect.
D2 (suspected spec/seed gap) 2561.1 GET suggestions returns 403 "Permission 'sap:suggested_questions' required": no workspace role holds it, works only for platform admin (the Investigator gate lift is AXI-2547, moved). Expected per spec: kill switch testable by workspace admin. Evidence run-2540-final.log. Low/medium, ruling needed.
D3 (unresolved, possibly flaky or product) 2548 "failed row" capture: upload row [data-upload-name=...] not visible within 120s (screenshot test-failed-1.png in the worktree test-results, not committed). Expected: failed upload row with plain-language reason (AXI-2548). Note epic-1 (NUL CSV failing with readable reason + Retry) passes via API/UI, so reproduce manually before ruling. Medium.
D4 (env) 2549 4.1/4.2 skipped: stack watchdog window exceeds ingestion time or the scheduler is not running; rerun with AXI_2549_WATCHDOG_TIMEOUT_MINUTES lowered on the stack.
D5 (doc) traceability table lacks 2559/2560/2561/2563/2565/2593.

## 5. Human-only residue
- 2550 scenario 2 (revoke a seeded-role permission, expect effect within the cache window) as a System Admin: System > Roles > edit Editor, untick a permission, then confirm the user loses it immediately.
- 2551 hub visual check as a sap:read holder vs not (needs platform admin to build the roles).
- 2548 failed-row and ready-row visual check on Investigator uploads page.

## 6. Branch
AXI-2540-validation (pushed, not merged), worktree /home/felipe/dev/axiome/_worktrees/axiome-e2e-testing-AXI-2540-validation, head 11e252c. Reports: reports/AXI-2540/2026-11-26-w5/.

## 7. ADDENDUM 2026-11-27 — re-run with the platform-admin login (test@axiomebio.com, ADMIN)
Whole-folder run (31+1 tests) = 24 passed, 2 failed, 2 skipped, 4 not run; composite after fixes: 28 passed, 1 failed, 2 skipped, 1 not run (32 incl. 2 setup). Logs: reports/AXI-2540/2026-11-26-w5/run-2540-admin*.log.
- 2550: both existing tests PASS. Scenario 2 (tagged playwright, no spec) AUTHORED: tests/AXI-2540/AXI-2550-resolver-fallback-on-miss.spec.ts PASSES: a membership whose roleId cannot be resolved falls back to the legacy tier grants (stored enum column = viewer for an unknown roleId, so exactly the seeded Viewer grants, not empty/500); a fetched empty role gets none. Note for the docs: "legacy fallback for his role" is the stored tier, not the intended one.
- 2551.1-.3, .5, .6 PASS. 2551.4 (Runs tab) is retired by AXI-2650 (route 404): rewritten to assert the route and tab are gone; the manual doc/scenario AXI-2551.4 should be amended.
- epic-2 (converted manual 2550 sc.3) now runs on admin and PASSES (read by role id, GET /roles/:id: Editor, Approver, Admin, Investigator all hold chart_style:write). epic-1 passes (uses a fresh fixture workspace when the identity is not a member of the demo one).
- 2561: PASSES after spec fix. Product: sap:suggested_questions is seeded on NO role (AXI-2539 owner ruling) and a platform admin has no shortcut, so the read endpoint needs a member of a role holding sap:suggested_questions + guided_analysis:view. The old spec called it as the platform admin (403). D2 closed as spec drift.
- 2549 4.1/4.2 still skip (env: watchdog window), 2548 failed-row capture still fails (row [data-upload-name] never visible in 120s for the second UI upload in the screenshots spec; the AC-level AXI-2548 spec passes), so D3 stays open as unresolved capture-spec failure (reproduced 3 times, 2 identities), ready-row capture did not run. The capture spec overwrote tracked reports/AXI-2548 PNGs: reverted.
NEW DEFECTS
D6 (fixture break caused by AXI-2735, same as AXI-2455 D7): 400 "user does not belong to any organization" in PrivateProjectsWorld.addMember; observed as 8 failures in the first admin whole-folder run (2548, 2549 5.3, 2550, 2551). Fixed on this branch in tests/AXI-2265/private-projects-fixtures.ts (add user to the org first). Every other suite still using the old helper will break on main.
Branch AXI-2540-validation: head in section 6 (updated below).

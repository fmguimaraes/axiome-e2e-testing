# AXI-2540 W5 (FULL) report, 2026-11-26
Whole-folder run (tests/AXI-2540, chromium + axi-2549-api, workers=1, recorded LLM): 31 tests = 14 passed, 4 failed, 3 skipped, 10 did not run (serial cascade after identity failures).
Failures: 2548 failed-row screenshot capture (upload row not visible 120s), 2550 first test, 2551.1 ("Only System Admins can create roles"), 2561.1 (403 sap:suggested_questions needs platform admin).
Skipped: 2549 4.1/4.2 (watchdog window longer than ingestion time), 2548 ready row, epic-2 (roles not listed for non-admin).
Added: epic-upload-failure-retry-and-seeded-grants.spec.ts (epic-1 pass, epic-2 converted manual AXI-2550 sc.3, skips without System Admin; DB-walked PASS for Editor/Approver/Admin/Investigator chart_style:write).
Logs: run-2540-*.log in this folder.

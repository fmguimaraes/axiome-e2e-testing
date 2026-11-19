# AXI-2659 — resume status 2026-11-19

Correction: the earlier commit "record blocker: HANDOVER_PROVISIONER credentials do not
authenticate on w5val (401)" (be4f91c) was my own password-transcription bug (a stray
trailing period), not a real credential or environment defect. HANDOVER_PROVISIONER_PASSWORD
has no trailing punctuation; both E2E_INVESTIGATOR and HANDOVER_PROVISIONER logins work as
given. Leaving that commit in history (never rewriting pushed history) but recording the
correction here.

AXI-2673 (axiome-back PR #99, opening-templates/match 404 on a draft with an unplanned
question) is merged to main (1513a1a5) and w5val was restarted to serve it.

Confirmed LIVE in the real browser, fresh after restart: w5val's demo project state was reset
by the restart (fresh "No protocol yet" state on project f212fd26-4297-4d72-91b6-e06136a2eab4).
Re-did: saved the Protocol (title/objective/study population), added Q1 (primary question
text re: reference-microbiota coating % across HD/IgG4-RD/SD groups), opened its analysis
page. The T1-T5 workflow section NOW renders its normal server-computed eligibility reasons
("Needs a group variable with 2 levels and a measurement.", etc.) instead of the AXI-2673
failure banner ("Could not check which workflows fit your variables.") — the fix is confirmed
working in the real browser, not just via curl/unit tests.

Remaining work (NOT done — out of budget this session): declare the full field set via the
standard-fields drawer, bind Q1 to template T2, repeat for Q2 (T2)/Q3 (T1)/Q4 (T5), finalize
the plan, upload+link both reference files (T1_LONG, T2), launch all 4, verify 4 finished
results with correct charts, verify the Investigator study home shows all 4 images, reload and
re-verify. No Playwright spec authored yet pending that walk. AC1-5: NOT YET VERIFIED
end-to-end — do not treat as e2e-pass.

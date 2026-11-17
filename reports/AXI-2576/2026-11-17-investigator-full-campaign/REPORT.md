# Investigator Surface — Upload-to-Results E2E Campaign

- **Date:** 2026-11-17
- **Stack:** w5val validation containers, `axiome-front` on `localhost:5174`
- **Login:** `investigator@axiomebio.com` (investigator role), project "Microbiome" (Mag4 synthetic cohort)
- **Method:** manual, browser-scripted (DOM/native-setter interaction — the browser's
  viewport was stuck at ~500×56px for this whole session; screenshots were not
  reliably capturable, so findings below are evidenced by `document.body.innerText`
  snapshots and `GET`/`POST` network request status instead)

## Scope

Full lifecycle walk on the investigator surface: Study → Datasets → Statistical Plan
(Protocol → Data Specification → Questions → Completeness → Finalise) → Run SAP →
Results, plus Methods (Rule Library), Workflows (Analysis Template Library), Settings,
and SAP management.

## Confirmed defects

### 1. [AXI-2594] T3 ("Correlation") template cannot be run by the compiled analysis engine for a single x/y pair

`Correlation` (T3@0.4) is a **Published** built-in template whose validator reports
**PASS** on every check, including `main_result_declared` — its recipe declares a
two-step pipeline: `correlate` (`stats.correlation_matrix`) then `globalTest`
(`stats.matrix_global_test`), with `global_p` as the template's declared main result.

At SAP-run time, binding a question to T3 with one `x` and one `y` column blocks the
run with: *"Template T3@0.4 declares its main result on stats.matrix_global_test,
which the compiled analysis does not run, so the run could not compute this
question's main p-value."*

This is a genuine contract gap between the template registry (which validates and
publishes T3 as runnable) and the compiled-analysis execution engine (which evidently
never executes `matrix_global_test` for a single-pair binding — only, presumably, for
a true one-vs-many matrix). It reproduced identically across two independently
finalised plan versions (v2, v3) on the same question, is unaffected by anything an
investigator can change in a question's own binding, and left the SAP permanently
**1 of 2 questions can run** with no available workaround (there is no partial-run
capability on this surface — confirmed out of scope per
`AXI-2433-AXI-2576-Investigator-Study-Page.md` §3, AXI-2576.1 note on
`allowPartialRuns`).

**Impact:** any SAP whose only applicable template for a continuous-x/continuous-y
primary question is T3 can never reach a run, state 6, or state 7 (Results) at all.

### 2. [AXI-2595] State-4 "Data check" block miscategorizes a template/compiler defect as a data problem

The same T3 blocker above surfaces to the investigator as **"Data · blocking issue"**
with the remedy **"Upload a corrected file"** / **"Upload corrected file"** button.
No uploaded file can possibly fix a template-registry/compiler mismatch — the data
mapping for the question (`x`, `y` both bound to real, valid continuous columns) is
correct. The investigator is given a false, unfollowable remedy for what is actually
a template/engine defect, not a data defect.

### 3. [AXI-2596] Completeness panel can show "N of N checks met" while a real server check silently fails and blocks Finalise

(Confirmed earlier in this campaign via source read + reproduction.) `canFinalise()`
evaluates every row of the raw completeness report, but the visible "Completeness
checks" panel only renders rows matching a fixed `SPEC_CHECK_LABELS`/`CHECK_LABELS`
id set in `axiome-front/src/lib/projectSap/completenessModel.ts`. In the live case, a
v2/v3 question's Data Specification CC15 check ("Grouping fields declare their
levels") failed server-side and blocked Finalise, while the panel still showed
**13 of 13 checks met** and never rendered a CC15 row. Root cause and fix location
were verified in source; not re-verified again this stretch beyond reproducing the
same panel behavior while building the Q2/exploratory question.

### 4. [AXI-2597] `GET /api/v1/sap-management/saps` and `/sap-management/runs` return 404

The "SAP management → Plans" page (`/investigator/sap-management`) renders
**"No SAPs are visible to you yet"** for the Microbiome project even though that
project has a real, finalised SAP (plan v3, 2 questions) at the time of the check.
Network inspection shows both backing calls —
`GET /api/v1/sap-management/saps?page=1&limit=20` and
`GET /api/v1/sap-management/runs?page=1&limit=20` — return **404**, not an empty
200 list. This is a broken/unimplemented (or unmounted) backend route, not a genuine
empty state; the page's own project-scope `<select>` also offers only "All projects"
with no other options, so the page cannot be re-scoped to work around it either.

## Not bugs — confirmed intentional/documented behavior

- A v2/v3 question's plan, once written ("Complete"), cannot be re-opened via the
  question wizard route (`usePlanModeSource.ts`'s `v2PlanSourceOf` returns
  `no_question` once the stub is gone) — must be removed and re-added. No reachable
  "remove question" control was found on the investigator surface itself (the only
  one in source, `ProjectSapDraftPanel`'s `onRemove`, lives on `ProjectSapPlanTab`,
  a different component than the one the investigator surface actually mounts).
  Worked around by discarding and recreating the whole draft instead.
- "A question first introduced after data was mapped to this SAP must have role
  exploratory" is a deliberate Finalise-time business rule (AXI-2569 doctrine), not
  a bug — reproduced once with Q2 set to Secondary (correctly rejected), then
  resolved by setting Q2's role to Exploratory at creation time.

## Campaign path actually exercised (evidence, no screenshots — see header)

1. **Datasets** — uploaded dataset `final_tableau2_synthetic.csv` (23×21, Mag4
   synthetic cohort) already present; previewed raw rows to confirm actual column
   encodings (`sexe` is `M`/`F`, not `Male`/`Female` — caught and corrected my own
   setup error here, see v3 amendment below).
2. **Statistical plan** — Protocol (title/objective/population, locked); Data
   Specification (3 fields: `score_histo` continuous, `microbiote_igg4_cer_228`
   continuous, `sexe` grouping-2-levels); Questions — Q1 primary/T3 (pre-existing,
   blocked per finding #1), Q2 new exploratory/T1 (`groupingColumn=sexe`,
   `outcome=score_histo`, full estimand filled in); Completeness checks (CC1–CC18,
   13 of 13 met after fixing CC15's levels value); **Finalise v2** (rejected once
   for Q2=Secondary, see above), **Finalise v3** (accepted, correcting `sexe`'s
   declared levels from `Male, Female` to `M, F` to match the real data).
3. **Run SAP** — version/dataset/column-mapping dialog, auto-populated bindings
   confirmed correct; blocked at `Start SAP run` by finding #1 (Q1/T3) on both v2
   and v3 — never reached state 6/7 (Results) for this project. **FR98's read-only
   Results screen was not reachable this campaign** due to finding #1; FR96 state 4
   and state 5 ("Ready to run plan v{n}") were both reached and observed correctly
   transitioning as blockers were fixed one at a time.
4. **Methods** (`/investigator/rules`, labelled "Rule Library" in-app) — 78 rules
   listed, filterable by scope/status/category/protocol type; opened fine.
5. **Workflows** (`/investigator/analysis-templates`, labelled "Analysis Template
   Library" in-app) — T1–T5 built-in templates listed, all Published/PASS; opened
   T3's detail view (recipe graph, parameters, validator report) as the direct
   evidence for finding #1.
6. **Settings** (`/investigator/settings`) — default chart styling preset page
   loads correctly.
7. **SAP management** (`/investigator/sap-management`) — Plans tab broken, see
   finding #4; Templates tab is just a link back to the Analysis Template Library.
8. **Results, Review Center, signing** — not reached (state 7/8 never achieved,
   and review/signing is explicitly out of scope for AXI-2576 per its own spec).

## Residue / not done

- No screenshots (dark/light, per AXI-2576.3) — browser viewport could not be
  resized or restarted this session (standing constraint, user declined to fix).
- Results page (state 7, FR98) not reached on this project — blocked by finding #1.
  A fresh project with only T1/T2-class questions would be needed to reach it.
- Finding #4 (`sap-management` 404s) was observed but not root-caused in source —
  flagging for a developer with backend access to `axiome-back`'s
  `sap-management` module/router registration.

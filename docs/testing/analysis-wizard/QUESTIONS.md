# Analysis wizard — test questions

The questions used to test the New analysis wizard's first step (epic AXI-2308, FR54 "the
question pre-fills the wizard"). Type one into **What do you want to find out?** and check what
the wizard pre-selects. Each row says which dataset it targets and what a correct read looks like.

**What the suggestion call returns** (`POST /api/v1/guided-analysis/intent-prefill/suggest`):
`{ status, intent, slots[], contradictions[], callId }`. `intent` is one of the closed set
(`compare_groups`, `find_validate_biomarkers`, `follow_patients_over_time`,
`reproduce_published_analysis`). Each slot is `{ slot, value, sourceSpan }`: a value is served
only if it is in the dataset's vocabulary (column names / levels) AND carries the words of the
question it came from. Anything else is dropped to null (EC21). AXI-2360 adds the dataset id(s)
the question is about and tags each slot with its dataset (FR54, D21).

**Dataset used by most rows:** the Paul header fixture
[`opening-templates-paul-header.csv`](../../../tests/AXI-2308/fixtures/opening-templates-paul-header.csv):
`igg4_g_l`, `sexe` (F/M), `age`, `cluster_selon_acr_eular_2019` (C1/C2/C3),
`atteinte_pancreatique`, `microbiote_igg4_cer_228`, `microbiote_igg4_mag4_27/22/13`.

**Deep link:** the wizard is [`/new-analysis`](http://localhost:5173/new-analysis) on the
shared demo stack (open a project first), or `<worktree Vite>/new-analysis` on an isolated stack.

## Wizard / e2e questions

| Title | Question | Description (expected read) | Deeplink | Used by |
|---|---|---|---|---|
| Plain-language sex comparison | `Does IgG4 differ by sex?` | `compare_groups`; outcome `igg4_g_l` from "IgG4", groupingColumn `sexe` from "by sex". Golden path to Ready → Run. | [/new-analysis](http://localhost:5173/new-analysis) | `tests/AXI-2308/AXI-2328-guided-setup-wizard.spec.ts`, `AXI-2356-*`, `AXI-2327-*`, `AXI-2343-*` |
| Groups not named | `Does IgG4 differ between groups?` | `compare_groups`, outcome only; no grouping column is guessed, so the wizard **asks** for it (Must be decided). | [/new-analysis](http://localhost:5173/new-analysis) | `AXI-2356-wizard-sap-read-and-pairs.spec.ts` |
| Cluster pair, column names | `Does igg4_g_l differ between clusters C1 and C3?` | `compare_groups`; outcome `igg4_g_l`, groupingColumn `cluster_selon_acr_eular_2019` from "clusters", groups C1, C3; no contradictions. Recorded answer exists. | [/new-analysis](http://localhost:5173/new-analysis) | `AXI-2345-question-suggestion.spec.ts` (.4), back `intent-prefill.recorded.spec.ts` |
| Words outside the vocabulary | `Is igg4_g_l higher in cluster C2 patients than in healthy donors?` | "healthy donors" is not a level of any column → never served as a value; only in-vocabulary values (outcome, C2) survive. | [/new-analysis](http://localhost:5173/new-analysis) | `AXI-2345-question-suggestion.spec.ts` (.5) |
| Raw column name for the group | `Does igg4_g_l differ by sexe?` | `compare_groups`, groupingColumn `sexe`. Also the tenancy probe: a body-supplied `caller` or a foreign project is refused. | — (API only) | `AXI-2345-question-suggestion.spec.ts` (.8), back `intent-prefill.message.controller.spec.ts` |
| Microbiote feature, both levels | `Does microbiote_igg4_mag4_27 differ between F and M of sexe?` | `compare_groups`; outcome `microbiote_igg4_mag4_27`, groupingColumn `sexe`, groups F, M. The Automatic-mode charter question. | [/new-analysis](http://localhost:5173/new-analysis) | `AXI-2335-full-testing-charter.spec.ts` |
| A column the dataset lacks | `Does CCL19 differ across clusters?` | Asked against a dataset with no CCL19: outcome contradicted → the wizard asks one parameter at a time and quotes the contradicted words (AC45, EC22). | [/new-analysis](http://localhost:5173/new-analysis) | `AXI-2328-guided-setup-wizard.spec.ts` (.10) |
| Personal names as levels | `Does ccl19 differ by referent?` | The `referent` column's levels are people's names → the call is **not made** (`status: skipped_identifying`, no slots). | — (API only) | `AXI-2355-personal-name-levels.spec.ts` |
| SAP-bound project | `Does value differ between group A and group B?` | Synthetic `value` / A,B dataset for the SAP binding; the plan question shows before Intent. | — (API only) | `AXI-2338-project-sap-binding.spec.ts` |

## Back-end unit questions (organization-service, recorded or stubbed)

| Title | Question | Description (expected read) | Used by |
|---|---|---|---|
| F vs M by column name | `Does igg4_g_l differ between F and M?` | service path: model call, out-of-set intent → null, recorded-transport miss, timeout, identifying level skips the call (UT-GUIDED-6229..6233). | `intent-prefill.service.spec.ts` |
| Cohort phrasing | `In my cohort, does microbiote_igg4_mag4_27 differ between F and M?` | each call writes one call-log row; Bedrock model pinning / EU region fail closed (UT-GUIDED-6680..6686). | `suggestion-call.spec.ts` |
| Accepted value spelling | `Is ccl19 higher in Sepsis than in healthy donors?` | an accepted value takes the vocabulary's spelling and the question's span (UT-GUIDED-6223). | `suggestion-acceptance.spec.ts` |
| No / foreign span | `Is CCL19 different by sex?` | a value with no span, an empty span, or a span not in the question is dropped (EC21, UT-GUIDED-6224). | `suggestion-acceptance.spec.ts` |
| Spanned but out of vocabulary | `Is CCL19 higher in sepsis vs healthy donors?` | becomes a contradiction, not a value (EC22, UT-GUIDED-6225). | `suggestion-acceptance.spec.ts` |
| Two values for one slot | `Does CCL19 or age differ, CCL19 especially?` | both are ambiguous — the wizard asks, never silently picks (UT-GUIDED-6226). | `suggestion-acceptance.spec.ts` |

## To add with D21 (every dataset sent, AXI-2360 / AXI-2361)

Not recorded yet; the expected reads follow EC28/EC29 in the feature doc.

| Title | Question | Description (expected read) |
|---|---|---|
| Names its dataset | a question naming a column only one dataset has | that dataset is returned and used as `only`; no pair choice needed. |
| Same column in two datasets | `Does IgG4 differ by sex?` on a project with two datasets both holding `igg4_g_l` / `sexe` | ambiguous → the wizard offers (template, dataset) pairs; each slot is tagged with its dataset; changing the pair re-derives values (EC29). |
| Names no dataset | `Does it differ between groups?` | no dataset id; pairs ranked by intent only (EC28). |

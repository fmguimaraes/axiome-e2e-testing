# SAP-run report — MAG4 Tableau 2 — statistical analysis plan, version 1

Project: E2E AXI-2601 handover rehearsal 20261117T130922-6pqt (8868cf7a-bb0a-4978-845f-2345a96e370c) · SAP run 24562cee-4af4-4ed2-821c-c8538cee02b9
Generated: 17/11/2026 13:09 UTC — automatically, when the SAP run completed
Report SHA-256: sha256:613a007d6ddbccca544653033508419ce1990b60e1663310d55c7cd08146dfa2
Language: English. No text in this report is AI-written: every value is a stored record or a fixed template.
Research Use Only. Not for use in diagnostic procedures.

## Statistical Analysis Plan — version 1

Title, verbatim:

```
MAG4 Tableau 2 — statistical analysis plan
```

- SAP: fe4af33c-3be4-49bb-990b-ee64520b2d75 · version 1 (d2381631-2e9e-496c-8229-1af39154c427)
- Content hash: sha256:307b61d58a5ecf50eeaa18e7463f21ba920d98ea9207a1e109b7e5c45d62067b (hash version 3)
- Finalised: 17/11/2026 13:09 UTC by user bfbff2ac-054a-4db7-a836-4de3fb3c34d9
- Plan timing: before data — no data binding existed when this version was finalised
- Data uploaded before this version was finalised: no — informational only; it never changes the plan timing above

## Amendment history

- Version 1 (final, finalised 17/11/2026 13:09 UTC, plan timing: before data — no data binding existed when this version was finalised): no amendment reason recorded

## SAP run

- Status: completed
- Started: 17/11/2026 13:09 UTC by user bfbff2ac-054a-4db7-a836-4de3fb3c34d9
- Completed: 17/11/2026 13:09 UTC
- Dataset version: 9b3562ae-f591-4bc1-9b20-ffa9e1c68d25 (dataset d4f494f2-6933-4e9b-8fdf-ee9b8b436fef)
- Classification: planned final look — no earlier SAP run of this project made this a reproduction, an amendment after results or an unplanned look
- SAP analysis: 26acc29b-95e7-4d1b-baeb-f76aa9c08a18

## Data mapping

- Dataset: d4f494f2-6933-4e9b-8fdf-ee9b8b436fef · dataset version (ingestion): 9b3562ae-f591-4bc1-9b20-ffa9e1c68d25
- Binding hash: sha256:6b080a5440e494ecdaf982001b984b994865c9e9195d020af51ea88030491d6f
- Confirmed: 17/11/2026 13:09 UTC by user bfbff2ac-054a-4db7-a836-4de3fb3c34d9
- Conformance outcome: pass

| Field | Column |
| --- | --- |
| 0a840225-ebcd-4940-a93b-d6a9702cf9b1 | cluster_selon_acr_eular_2019 |
| 1f357506-8305-4993-bb92-779b5365bf90 | tfh_cxcr5_pd1_cd4 |
| 2378783c-cbbb-47a6-b82d-e41e25566350 | microbiote_igg4_ent_059 |
| 30a1254b-4526-43d9-ae2e-fb4fb8672ab0 | microbiote_igg4_cer_215_et_234 |
| 549dccb5-783c-458e-a36d-2b1a83761e7b | igg4_rd_ri |
| 70278c99-edb1-469c-a518-fdb580eb8589 | microbiote_igg4_mag4_27 |
| 809bc2a0-6099-4f4f-849c-d38dd5981b02 | plasmablasts_cd19_cd38_cd27_mm3 |
| 87310e95-a0a1-4048-b264-97c90d04d6f7 | atteinte_pancreatique |
| 8d037c06-8461-4122-8226-8d1c27a6a901 | microbiote_igg4_cer_229 |
| 970a9064-d40e-479c-b208-0fd642fc510e | microbiote_igg4_mag4_22 |
| aadb303a-a252-46e8-9400-6629313e87aa | igg4_g_l |
| b2193b87-b6a6-4110-8a12-830e3f82bae6 | microbiote_igg4_cer_228 |
| cdd5edfd-0764-42cc-9ea7-2827b7844006 | microbiote_igg4_mag4_13 |
| f0a7e0d9-8277-4f3a-8ebf-20d2161f7b8b | eosinophils |
| feddb804-6edd-4c66-b683-cf65a6fc1133 | igg4_hpf |

## Multiplicity procedure

Confirmatory questions (primary, key secondary, secondary) were tested by fixed-sequence testing across families in ascending position, with Holm's step-down procedure within each family, at the common alpha 0.05. A family is tested only when every hypothesis of every earlier family was rejected; a question whose child run failed counts as p = 1 in Holm and stops the sequence after its family. A rejected hypothesis is Met only when the effect sign matches the declared direction, if one is declared.

Exploratory questions are outside the procedure: each is judged on its own main p-value against its own alpha, and the direction if one is declared.

Sensitivity analyses are reported beside their question and affect no verdict and no step of the procedure.

Families, in testing order:

- Family 1 (position 2): Q2
- Family 2 (position 3): Q3
- Family 3 (position 4): Q4

## Verdicts

| Question | Role | Position | Main p-value | Effect sign | Verdict |
| --- | --- | --- | --- | --- | --- |
| Q1 | exploratory | 1 | not recorded | not recorded | Not tested |
| Q2 | primary | 2 | 0.3705118456507039 | positive | Not met |
| Q3 | secondary | 3 | 0.1815048344896971 | not recorded | Not tested |
| Q4 | secondary | 4 | 0.5126480774194776 | positive | Not tested |

- Met: the pre-specified criterion was met under the declared procedure.
- Not met: the pre-specified criterion was not met under the declared procedure.
- Not tested: not tested: the fixed sequence stopped before this family was reached; its numbers are descriptive only.
- Failed to run: failed to run: the child run did not complete or produced no main p-value.

## Q1 — exploratory, position 1

Question, verbatim:

```
How does each IgG4 anti-microbiota reference correlate with the clinical and biological variables?
```

Estimand (ICH E9(R1)), verbatim:

```
Population: Patients with IgG4-related disease in the MAG4 cohort
Variable: IgG4 anti-microbiota references and clinical variables
Intercurrent events: None anticipated (cross-sectional measurement)
Population-level summary: Spearman correlation coefficient per reference-variable pair, Benjamini-Hochberg adjusted
Treatment comparison: Not a group comparison: correlation across patients
```

- Question id: 78139227-b115-4023-a7a9-d0805d276e7c
- Post-data question: no
- Template: T5 version 0.3
- Bindings:
  - references → column microbiote_igg4_cer_228 (continuous)
  - references → column microbiote_igg4_mag4_27 (continuous)
  - references → column microbiote_igg4_mag4_22 (continuous)
  - references → column microbiote_igg4_mag4_13 (continuous)
  - references → column microbiote_igg4_cer_215_et_234 (continuous)
  - references → column microbiote_igg4_cer_229 (continuous)
  - references → column microbiote_igg4_ent_059 (continuous)
  - y → column igg4_g_l (continuous)
  - y → column igg4_rd_ri (continuous)
  - y → column igg4_hpf (continuous)
  - y → column eosinophils (continuous)
  - y → column plasmablasts_cd19_cd38_cd27_mm3 (continuous)
  - y → column tfh_cxcr5_pd1_cd4 (continuous)
- Parameters:
  - alpha: 0.05
  - sidedness: two_sided
- Decision criterion: main p-value at or below alpha 0.05 (two_sided)
- Main p-value: not recorded
- Effect sign: not recorded
- Multiplicity procedure: outside the procedure (exploratory)
- Verdict: Not tested — not tested: the fixed sequence stopped before this family was reached; its numbers are descriptive only
- Child run: GR-0b8d9cdd
- Sensitivity analyses: none declared

## Q2 — primary, position 2

Question, verbatim:

```
Does the IgG4 anti-microbiota reference ENT-059 differ with pancreato-biliary involvement?
```

Estimand (ICH E9(R1)), verbatim:

```
Population: Patients with IgG4-related disease in the MAG4 cohort
Variable: IgG4 anti-microbiota reference ENT-059
Intercurrent events: None anticipated (cross-sectional measurement)
Population-level summary: Difference in distributions (Mann-Whitney)
Treatment comparison: Pancreato-biliary involvement (1) vs none (0)
```

- Question id: 9c8e492b-108f-4217-90b8-97e00be81af1
- Post-data question: no
- Template: T1 version 0.4
- Bindings:
  - groupingColumn → column atteinte_pancreatique (grouping_two_levels)
  - outcome → column microbiote_igg4_ent_059 (continuous)
- Parameters:
  - alpha: 0.05
  - sidedness: two_sided
- Decision criterion: main p-value at or below alpha 0.05 (two_sided)
- Main p-value: 0.3705118456507039
- Effect sign: positive
- Multiplicity procedure: hypothesis not rejected
- Verdict: Not met — the pre-specified criterion was not met under the declared procedure
- Child run: GR-817437b5
- Sensitivity analyses: none declared

## Q3 — secondary, position 3

Question, verbatim:

```
Does the IgG4 anti-microbiota reference ENT-059 differ between ACR/EULAR 2019 clusters?
```

Estimand (ICH E9(R1)), verbatim:

```
Population: Patients with IgG4-related disease in the MAG4 cohort
Variable: IgG4 anti-microbiota reference ENT-059
Intercurrent events: None anticipated (cross-sectional measurement)
Population-level summary: Difference in distributions across clusters (Kruskal-Wallis, Dunn post-hoc)
Treatment comparison: Clusters C1, C2, C3, C4
```

- Question id: 96b377c4-5547-486f-87b5-bc585accc3c7
- Post-data question: no
- Template: T2 version 0.3
- Bindings:
  - groupingColumn → column cluster_selon_acr_eular_2019 (grouping_three_plus_levels)
  - outcome → column microbiote_igg4_ent_059 (continuous)
- Parameters:
  - alpha: 0.05
  - sidedness: two_sided
- Decision criterion: main p-value at or below alpha 0.05 (two_sided)
- Main p-value: 0.1815048344896971
- Effect sign: not recorded
- Multiplicity procedure: hypothesis not rejected
- Verdict: Not tested — not tested: the fixed sequence stopped before this family was reached; its numbers are descriptive only
- Child run: GR-72ba7f1e
- Sensitivity analyses: none declared

## Q4 — secondary, position 4

Question, verbatim:

```
Is the IgG4 anti-microbiota reference ENT-059 associated with the IgG4-RD responder index independently of serum IgG4?
```

Estimand (ICH E9(R1)), verbatim:

```
Population: Patients with IgG4-related disease in the MAG4 cohort
Variable: IgG4 anti-microbiota reference ENT-059 and IgG4-RD responder index
Intercurrent events: None anticipated (cross-sectional measurement)
Population-level summary: Partial Spearman correlation adjusted for serum IgG4
Treatment comparison: Not a group comparison: association adjusted for serum IgG4
```

- Question id: d069bd93-6ed1-4255-b8db-36e2df523d7e
- Post-data question: no
- Template: T4 version 0.4
- Bindings:
  - x → column microbiote_igg4_ent_059 (continuous)
  - y → column igg4_rd_ri (continuous)
  - adjustFor → column igg4_g_l (continuous)
- Parameters:
  - alpha: 0.05
  - sidedness: two_sided
- Decision criterion: main p-value at or below alpha 0.05 (two_sided)
- Main p-value: 0.5126480774194776
- Effect sign: positive
- Multiplicity procedure: hypothesis not rejected
- Verdict: Not tested — not tested: the fixed sequence stopped before this family was reached; its numbers are descriptive only
- Child run: GR-36bca4ef
- Sensitivity analyses: none declared

## Record

- SAP run: 24562cee-4af4-4ed2-821c-c8538cee02b9 · SAP version d2381631-2e9e-496c-8229-1af39154c427 · version 1 · content hash sha256:307b61d58a5ecf50eeaa18e7463f21ba920d98ea9207a1e109b7e5c45d62067b
- Decision engine version: 1.3.0
- Report hash: SHA-256 of this file without its "Generated" and "Report SHA-256" header lines.

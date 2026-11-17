# SAP-run report — MAG4 Tableau 2 — statistical analysis plan, version 1

Project: E2E AXI-2601 handover rehearsal 20261117T122543-05l4 (6959f82e-10e3-4c20-9530-5eb7364dcf62) · SAP run c6293b21-cebf-48d8-a70a-1ba5928c2668
Generated: 17/11/2026 12:25 UTC — automatically, when the SAP run completed
Report SHA-256: sha256:efafe9d4319f535b652f52019aa369884a701a14294ac87c3504fe100e5c4413
Language: English. No text in this report is AI-written: every value is a stored record or a fixed template.
Research Use Only. Not for use in diagnostic procedures.

## Statistical Analysis Plan — version 1

Title, verbatim:

```
MAG4 Tableau 2 — statistical analysis plan
```

- SAP: 7a382be6-e409-460f-aed8-3d0227bd287e · version 1 (97a269e6-9d4a-4e8a-8a36-f4091cd18950)
- Content hash: sha256:e0fb36c813d29451115833de222b51be46cb249c3feec8fb00155238503ae03c (hash version 3)
- Finalised: 17/11/2026 12:25 UTC by user bfbff2ac-054a-4db7-a836-4de3fb3c34d9
- Plan timing: before data — no data binding existed when this version was finalised
- Data uploaded before this version was finalised: no — informational only; it never changes the plan timing above

## Amendment history

- Version 1 (final, finalised 17/11/2026 12:25 UTC, plan timing: before data — no data binding existed when this version was finalised): no amendment reason recorded

## SAP run

- Status: completed
- Started: 17/11/2026 12:25 UTC by user bfbff2ac-054a-4db7-a836-4de3fb3c34d9
- Completed: 17/11/2026 12:25 UTC
- Dataset version: ef8eaae1-e921-4012-bb84-d255092cfb54 (dataset 98371980-ff35-47bc-9543-7c48b7bcd94c)
- Classification: planned final look — no earlier SAP run of this project made this a reproduction, an amendment after results or an unplanned look
- SAP analysis: bca129b9-a399-4597-9eef-9c1a8dcdc6d5

## Data mapping

- Dataset: 98371980-ff35-47bc-9543-7c48b7bcd94c · dataset version (ingestion): ef8eaae1-e921-4012-bb84-d255092cfb54
- Binding hash: sha256:553349a89dff37516235bd68e3f1d272a32c6a7c6cd0d3c7ba1edb53b91c405f
- Confirmed: 17/11/2026 12:25 UTC by user bfbff2ac-054a-4db7-a836-4de3fb3c34d9
- Conformance outcome: pass

| Field | Column |
| --- | --- |
| 0e9917a7-77ec-4906-9dfe-5502b2d1639d | tfh_cxcr5_pd1_cd4 |
| 1a4d9031-97a5-4cf5-a798-8df2631ebfe1 | igg4_g_l |
| 1a65847a-fbb0-4645-aae0-c231c355419c | igg4_rd_ri |
| 1e1fa94a-2d8b-4704-99d7-d2adfcd6c810 | eosinophils |
| 27a02a20-ed81-48ef-8ba8-e6fbedbd2c9c | microbiote_igg4_mag4_22 |
| 38731550-0e49-4b45-a93c-6c7bfe15a7c6 | cluster_selon_acr_eular_2019 |
| 485ccefe-7f02-43d4-a174-d9a1298394a4 | microbiote_igg4_mag4_13 |
| 4ab64c69-bb5a-4703-996f-95ada794fa3f | igg4_hpf |
| 56004d29-11a8-4fe6-bdf1-d82e62440751 | microbiote_igg4_cer_215_et_234 |
| 942b0fa3-2456-4864-9a79-e04638087501 | microbiote_igg4_ent_059 |
| 9abb28fd-0bb4-4305-a28d-aa97a4d680d5 | microbiote_igg4_mag4_27 |
| 9ef55b90-8b44-4685-b498-9eb643c1801d | atteinte_pancreatique |
| bbf41619-8a96-47af-b4bb-7b5dca285304 | plasmablasts_cd19_cd38_cd27_mm3 |
| d1bcfee7-0c2a-41d0-8212-64e4dd97693f | microbiote_igg4_cer_228 |
| f77e4c66-c67a-4361-8c31-07686807bfc3 | microbiote_igg4_cer_229 |

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
| Q1 | exploratory | 1 | not recorded | not recorded | Failed to run |
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

- Question id: 0fd3672c-08d4-4f82-9517-ab6e82343c8d
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
- Verdict: Failed to run — failed to run: the child run did not complete or produced no main p-value
- Child run: GR-3a4d55a5
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

- Question id: c1f055a7-0189-4cf2-aafb-1063d4ccf041
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
- Child run: GR-e8136640
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

- Question id: 645d1af5-bce6-446f-893c-48c8945b080e
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
- Child run: GR-51862031
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

- Question id: 7dac79e7-19f6-4f72-9554-81eb987b5849
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
- Child run: GR-c7dd4203
- Sensitivity analyses: none declared

## Record

- SAP run: c6293b21-cebf-48d8-a70a-1ba5928c2668 · SAP version 97a269e6-9d4a-4e8a-8a36-f4091cd18950 · version 1 · content hash sha256:e0fb36c813d29451115833de222b51be46cb249c3feec8fb00155238503ae03c
- Decision engine version: 1.3.0
- Report hash: SHA-256 of this file without its "Generated" and "Report SHA-256" header lines.

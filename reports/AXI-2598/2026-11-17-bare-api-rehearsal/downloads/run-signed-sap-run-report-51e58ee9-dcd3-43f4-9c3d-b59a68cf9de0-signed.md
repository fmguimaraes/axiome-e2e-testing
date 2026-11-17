# SAP-run report — MAG4 Tableau 2 — statistical analysis plan, version 1

Project: E2E AXI-2601 handover rehearsal 20261117T124011-yjr8 (53a619fe-02dc-40d8-a578-5748162601aa) · SAP run 51e58ee9-dcd3-43f4-9c3d-b59a68cf9de0
Generated: 17/11/2026 12:40 UTC — automatically, when the SAP run completed
Report SHA-256: sha256:9bb6c6ecbf001d13b0063a0c1fa62d353b7e2c22edc1b26129e281fd596db870
Language: English. No text in this report is AI-written: every value is a stored record or a fixed template.
Research Use Only. Not for use in diagnostic procedures.

## Statistical Analysis Plan — version 1

Title, verbatim:

```
MAG4 Tableau 2 — statistical analysis plan
```

- SAP: ef9c68c9-e940-466b-9049-47290045ae7b · version 1 (0ef47aec-e041-45bb-8546-2948e664d24b)
- Content hash: sha256:1b27d2e8b76c63fea633b913efbbe9427a4b931fa380efd3d6adf7fca8a8b91b (hash version 3)
- Finalised: 17/11/2026 12:40 UTC by user bfbff2ac-054a-4db7-a836-4de3fb3c34d9
- Plan timing: before data — no data binding existed when this version was finalised
- Data uploaded before this version was finalised: no — informational only; it never changes the plan timing above

## Amendment history

- Version 1 (final, finalised 17/11/2026 12:40 UTC, plan timing: before data — no data binding existed when this version was finalised): no amendment reason recorded

## SAP run

- Status: completed
- Started: 17/11/2026 12:40 UTC by user bfbff2ac-054a-4db7-a836-4de3fb3c34d9
- Completed: 17/11/2026 12:40 UTC
- Dataset version: 4f672aa1-80f4-467d-bd35-1157fea5381f (dataset d9b146fd-49bd-48f3-857e-c3c1d5562933)
- Classification: planned final look — no earlier SAP run of this project made this a reproduction, an amendment after results or an unplanned look
- SAP analysis: 6ba46016-1fbb-4ee0-80bf-905b53873459

## Data mapping

- Dataset: d9b146fd-49bd-48f3-857e-c3c1d5562933 · dataset version (ingestion): 4f672aa1-80f4-467d-bd35-1157fea5381f
- Binding hash: sha256:a4eb52af5279325d80c974ba0b1509811a5e87dca9b1629e4e9c2c5c4a6e4a26
- Confirmed: 17/11/2026 12:40 UTC by user bfbff2ac-054a-4db7-a836-4de3fb3c34d9
- Conformance outcome: pass

| Field | Column |
| --- | --- |
| 011ecf3c-d8a1-433d-a1a4-4f14c81385ae | atteinte_pancreatique |
| 28135660-87d5-4260-982e-97fbdb5261fb | microbiote_igg4_mag4_27 |
| 4149aa91-a074-4707-860b-335749d27016 | microbiote_igg4_cer_229 |
| 48b72ec5-a03c-465f-90cc-b57b01689f31 | igg4_g_l |
| 5579e079-8813-4d9c-a42a-05c5792fb931 | igg4_rd_ri |
| 61d38387-b7e8-4d5c-9a3a-7b37b0fa2b1b | tfh_cxcr5_pd1_cd4 |
| 812aef6b-fcda-4bac-a4f5-23150c6a0e88 | microbiote_igg4_ent_059 |
| 917ee168-a947-4b3c-9016-cef81adb4a0f | microbiote_igg4_mag4_13 |
| 962b724b-02a4-4490-add9-e85384fa4961 | eosinophils |
| a91f036c-0515-4265-973a-c2e20b6278ce | microbiote_igg4_cer_215_et_234 |
| b54ca2f5-011f-4226-8809-b39bdb675bf9 | igg4_hpf |
| bd5914ca-511c-4488-bc42-a668eae09feb | microbiote_igg4_mag4_22 |
| c70ef94e-a537-42b9-b92d-335eee0d6c5f | microbiote_igg4_cer_228 |
| d1b87814-5f45-4965-bff6-27f7fc7e3ae4 | cluster_selon_acr_eular_2019 |
| d1ceca4d-843a-460a-aa08-beb672160e69 | plasmablasts_cd19_cd38_cd27_mm3 |

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

- Question id: c7bae8d7-0421-428e-948a-4e6e1062b77b
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
- Child run: GR-628cf27a
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

- Question id: 13a95aee-4eac-4979-8722-414fb1a98c03
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
- Child run: GR-22267536
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

- Question id: 4f73610a-048b-4998-8971-301131bc21bd
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
- Child run: GR-57e80384
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

- Question id: b7e67d1f-936d-492a-a2ea-b593dfebbe86
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
- Child run: GR-d98cb273
- Sensitivity analyses: none declared

## Record

- SAP run: 51e58ee9-dcd3-43f4-9c3d-b59a68cf9de0 · SAP version 0ef47aec-e041-45bb-8546-2948e664d24b · version 1 · content hash sha256:1b27d2e8b76c63fea633b913efbbe9427a4b931fa380efd3d6adf7fca8a8b91b
- Decision engine version: 1.3.0
- Report hash: SHA-256 of this file without its "Generated" and "Report SHA-256" header lines.

# SAP-run report — MAG4 Tableau 2 — statistical analysis plan, version 1

Project: E2E AXI-2601 handover rehearsal 20261117T115823-zpdv (57e9083e-a341-41fd-a09f-c26a75fbbbe9) · SAP run 09bd9078-c194-4b11-8eb7-b170147452b1
Generated: 17/11/2026 11:58 UTC — automatically, when the SAP run completed
Report SHA-256: sha256:529e12ca13cb50abd9a382358676f384862bd478aee3e012c8bcbdb0f8c956ef
Language: English. No text in this report is AI-written: every value is a stored record or a fixed template.
Research Use Only. Not for use in diagnostic procedures.

## Statistical Analysis Plan — version 1

Title, verbatim:

```
MAG4 Tableau 2 — statistical analysis plan
```

- SAP: c963329e-3d58-4a63-b363-5564719bcb2f · version 1 (6f9dc016-eae0-428b-a7a3-df9ec794bb3c)
- Content hash: sha256:312d4ec9c427252c93dcddb1378a582e768bcb8297ce7b15eb6b09f8e642c887 (hash version 3)
- Finalised: 17/11/2026 11:58 UTC by user bfbff2ac-054a-4db7-a836-4de3fb3c34d9
- Plan timing: before data — no data binding existed when this version was finalised
- Data uploaded before this version was finalised: no — informational only; it never changes the plan timing above

## Amendment history

- Version 1 (final, finalised 17/11/2026 11:58 UTC, plan timing: before data — no data binding existed when this version was finalised): no amendment reason recorded

## SAP run

- Status: completed
- Started: 17/11/2026 11:58 UTC by user bfbff2ac-054a-4db7-a836-4de3fb3c34d9
- Completed: 17/11/2026 11:58 UTC
- Dataset version: 905fc8ec-5792-44ba-8d04-96c1fdca69f7 (dataset 8f784005-4e9b-454f-9983-48cd2d77f347)
- Classification: planned final look — no earlier SAP run of this project made this a reproduction, an amendment after results or an unplanned look
- SAP analysis: eafc7faf-b786-4a9a-ac04-4076fdd75e4d

## Data mapping

- Dataset: 8f784005-4e9b-454f-9983-48cd2d77f347 · dataset version (ingestion): 905fc8ec-5792-44ba-8d04-96c1fdca69f7
- Binding hash: sha256:6f43bacba07a09a9d78e4fcac0ed3b5848124be4f8f7c975f38d8696015b0740
- Confirmed: 17/11/2026 11:58 UTC by user bfbff2ac-054a-4db7-a836-4de3fb3c34d9
- Conformance outcome: pass

| Field | Column |
| --- | --- |
| 04859270-29cd-4e87-a7a8-abf5b2955fbd | igg4_hpf |
| 0e9c620d-f972-4be7-8dfe-406423ec32a8 | microbiote_igg4_cer_229 |
| 1702c10b-96c5-44a0-8a2a-13c06aa0614f | atteinte_pancreatique |
| 24614e4a-8105-4809-b726-bd653c10d252 | microbiote_igg4_mag4_13 |
| 29b10d47-19ca-495f-8fe0-adeb0491d58d | microbiote_igg4_cer_215_et_234 |
| 460d2733-4b0c-4edd-b273-bcfbf5e2185d | eosinophils |
| 487eb319-669e-4b0b-bfee-da7888d8eff6 | microbiote_igg4_ent_059 |
| 48a4b7a5-7984-4762-9919-8c06b5fa8a1c | plasmablasts_cd19_cd38_cd27_mm3 |
| 5eb367bd-14c8-4778-a522-3d109786bca7 | tfh_cxcr5_pd1_cd4 |
| 8693299b-0cf1-454a-93d3-76e02b16a2fb | microbiote_igg4_cer_228 |
| 92775330-76b1-4412-b5f5-91f250cb7dda | igg4_g_l |
| 9314aed1-77fd-4261-b5cb-7247ae820394 | microbiote_igg4_mag4_27 |
| a028ef32-a957-4c13-8982-0ede4ff6edfb | cluster_selon_acr_eular_2019 |
| ad302bc5-ce57-4a9a-8232-047d96358601 | microbiote_igg4_mag4_22 |
| ae844902-2fb4-46e3-aac6-99c6e95ae3d2 | igg4_rd_ri |

## Multiplicity procedure

Confirmatory questions (primary, key secondary, secondary) were tested by fixed-sequence testing across families in ascending position, with Holm's step-down procedure within each family, at the common alpha 0.05. A family is tested only when every hypothesis of every earlier family was rejected; a question whose child run failed counts as p = 1 in Holm and stops the sequence after its family. A rejected hypothesis is Met only when the effect sign matches the declared direction, if one is declared.

Exploratory questions are outside the procedure: each is judged on its own main p-value against its own alpha, and the direction if one is declared.

Sensitivity analyses are reported beside their question and affect no verdict and no step of the procedure.

Families, in testing order:

- Family 1 (position 1): Q1
- Family 2 (position 2): Q2
- Family 3 (position 3): Q3

## Verdicts

| Question | Role | Position | Main p-value | Effect sign | Verdict |
| --- | --- | --- | --- | --- | --- |
| Q1 | primary | 1 | 0.3705118456507039 | positive | Not met |
| Q2 | secondary | 2 | 0.1815048344896971 | not recorded | Not tested |
| Q3 | secondary | 3 | 0.5126480774194776 | positive | Not tested |
| Q4 | exploratory | 4 | not recorded | not recorded | Failed to run |

- Met: the pre-specified criterion was met under the declared procedure.
- Not met: the pre-specified criterion was not met under the declared procedure.
- Not tested: not tested: the fixed sequence stopped before this family was reached; its numbers are descriptive only.
- Failed to run: failed to run: the child run did not complete or produced no main p-value.

## Q1 — primary, position 1

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

- Question id: c2c84e56-56dc-4561-bb19-2e25f98d3bbc
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
- Child run: GR-bb37a171
- Sensitivity analyses: none declared

## Q2 — secondary, position 2

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

- Question id: a23c25dd-ad5c-4461-9b62-af7ffd8747f5
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
- Child run: GR-226d4ed0
- Sensitivity analyses: none declared

## Q3 — secondary, position 3

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

- Question id: 4927c628-dc4b-45aa-a34c-18ae525bff43
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
- Child run: GR-771af7cf
- Sensitivity analyses: none declared

## Q4 — exploratory, position 4

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

- Question id: b00a1bcb-bc99-4e82-bb77-4f3f724c01e7
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
- Child run: GR-39b359f8
- Sensitivity analyses: none declared

## Record

- SAP run: 09bd9078-c194-4b11-8eb7-b170147452b1 · SAP version 6f9dc016-eae0-428b-a7a3-df9ec794bb3c · version 1 · content hash sha256:312d4ec9c427252c93dcddb1378a582e768bcb8297ce7b15eb6b09f8e642c887
- Decision engine version: 1.3.0
- Report hash: SHA-256 of this file without its "Generated" and "Report SHA-256" header lines.

# SAP-run report — MAG4 Tableau 2 — statistical analysis plan, version 1

Project: E2E AXI-2601 handover rehearsal 20261117T115845-2mdu (ec6c4a27-bb22-4969-9c4c-e13953ba1820) · SAP run e84aea05-c30c-4261-9709-d4c0a477695b
Generated: 17/11/2026 11:58 UTC — automatically, when the SAP run completed
Report SHA-256: sha256:8d3abce1a1994fb28edc755a793b4d9eda213f0c4d018d0e8439ff8ad02a90da
Language: English. No text in this report is AI-written: every value is a stored record or a fixed template.
Research Use Only. Not for use in diagnostic procedures.

## Statistical Analysis Plan — version 1

Title, verbatim:

```
MAG4 Tableau 2 — statistical analysis plan
```

- SAP: 7944a66c-d030-4f1d-a0fd-d948e5fd52e4 · version 1 (d8efd6bb-30b4-4471-9ef3-9087535398fb)
- Content hash: sha256:e50410c46404f1be865818e940bcf2daab2520401dceff62e1ab242edaa51635 (hash version 3)
- Finalised: 17/11/2026 11:58 UTC by user bfbff2ac-054a-4db7-a836-4de3fb3c34d9
- Plan timing: before data — no data binding existed when this version was finalised
- Data uploaded before this version was finalised: no — informational only; it never changes the plan timing above

## Amendment history

- Version 1 (final, finalised 17/11/2026 11:58 UTC, plan timing: before data — no data binding existed when this version was finalised): no amendment reason recorded

## SAP run

- Status: completed
- Started: 17/11/2026 11:58 UTC by user bfbff2ac-054a-4db7-a836-4de3fb3c34d9
- Completed: 17/11/2026 11:58 UTC
- Dataset version: 013d389d-1887-44f8-82db-19f67e11c7f6 (dataset 87c79dfb-fcd3-41f4-9604-66a8df070c05)
- Classification: planned final look — no earlier SAP run of this project made this a reproduction, an amendment after results or an unplanned look
- SAP analysis: 6b27041c-3252-46a3-9205-cfda0f950fa3

## Data mapping

- Dataset: 87c79dfb-fcd3-41f4-9604-66a8df070c05 · dataset version (ingestion): 013d389d-1887-44f8-82db-19f67e11c7f6
- Binding hash: sha256:a628720ef608d704c17080ec1b79945ca99335362a0b557faf9fe22f5f675667
- Confirmed: 17/11/2026 11:58 UTC by user bfbff2ac-054a-4db7-a836-4de3fb3c34d9
- Conformance outcome: pass

| Field | Column |
| --- | --- |
| 0610e693-4b1e-4934-8056-a80155f40835 | microbiote_igg4_cer_229 |
| 2c596238-8051-42b8-ad65-559cdc57d4b3 | tfh_cxcr5_pd1_cd4 |
| 419052e2-6cc5-4687-b6a0-854b14dab643 | atteinte_pancreatique |
| 54df4c26-a88d-40ff-b690-a160be807f35 | eosinophils |
| 61dd9bff-bf75-4f71-a268-1a5bd84e7623 | microbiote_igg4_mag4_13 |
| 647be9b7-f915-42b2-9812-bd3b8ce4528a | microbiote_igg4_mag4_22 |
| 6bd13ee8-9a84-4327-8dd1-51ff7d40ea07 | igg4_hpf |
| 86646f27-7c82-4b0d-a193-3d7654bcdce9 | cluster_selon_acr_eular_2019 |
| a07c58ee-8e26-405b-bee1-12cab0d5b86b | microbiote_igg4_mag4_27 |
| ade52f1a-ba14-496f-9b59-952b48ba0b28 | igg4_g_l |
| c49e32ae-b940-4da3-819a-0f690b277ceb | microbiote_igg4_cer_215_et_234 |
| c556cdd7-e9ca-4489-afba-3e27aaf408b6 | microbiote_igg4_ent_059 |
| d026e042-201c-4412-9386-f0147b63d21c | microbiote_igg4_cer_228 |
| f2ee4207-ebb9-4920-882f-034098ce9dfd | igg4_rd_ri |
| f89a73f2-afdb-4a8f-9d7a-2a94362d5f8c | plasmablasts_cd19_cd38_cd27_mm3 |

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

- Question id: 1a08c813-42f5-4e3c-953b-3ddeb29c6f41
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
- Child run: GR-4dbe8226
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

- Question id: fb62f855-2f82-4013-9dbc-f9934cf4eebc
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
- Child run: GR-3cee6497
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

- Question id: c0fb2ee2-c359-4d73-b685-70cb8523401c
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
- Child run: GR-bb7957a8
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

- Question id: 842c3cdb-d402-4bf9-aaac-0831562d81a2
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
- Child run: GR-f73fa128
- Sensitivity analyses: none declared

## Record

- SAP run: e84aea05-c30c-4261-9709-d4c0a477695b · SAP version d8efd6bb-30b4-4471-9ef3-9087535398fb · version 1 · content hash sha256:e50410c46404f1be865818e940bcf2daab2520401dceff62e1ab242edaa51635
- Decision engine version: 1.3.0
- Report hash: SHA-256 of this file without its "Generated" and "Report SHA-256" header lines.

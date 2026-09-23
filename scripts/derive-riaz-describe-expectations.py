#!/usr/bin/env python3
"""
AXI-1565 (epic AXI-1555 — FR35) — re-derives, from the Riaz 2017 SOURCE CSVs
alone, every number `staging/steps/riazDescribeExpectations.ts` asserts for
Q12–Q21.

Why a second implementation exists at all: an E2E that checks the platform
against the platform proves nothing. The expectations in the TS module are the
independent answer; this script is how that answer was obtained and how a
reviewer reproduces it. It reads only the three CSVs the demo project ingests —
it never calls the API, never reads a trace, never opens the database.

    python3 scripts/derive-riaz-describe-expectations.py [--data-dir DIR]

Default data dir: $RIAZ_DATA_DIR, else /home/felipe/dev/axiome/riaz_de.

Two deliberate deviations from `Riaz-Guided-Questions.md`, both printed by the
script so they cannot be forgotten:
  * Q20 uses POPULATION sd (ddof=0), which is what bio-compute's `std`
    aggregation computes (AXI-1557); the doc quotes the sample sd.
  * Q16 reads "25 up / 33 down" as the group count of two `describe.count`
    branches, because the DE table carries no direction column and a describe
    node may not mint one (P11).
"""
from __future__ import annotations

import argparse
import os

import pandas as pd

PANEL_LONG = "riaz2017_immune_paired_log2cpm_long.csv"
DE_POOLED = "riaz_pre_therapy_responders_vs_nonresponders.csv"
DE_STRATIFIED = "riaz_stratified_pre_R_vs_NR_by_prior_ipi.csv"


def show(question: str, derivation: str, frame: pd.DataFrame, head: int = 5) -> None:
    print(f"\n=== {question} — {derivation}")
    print(frame.head(head).to_string(index=False))
    if len(frame) > head:
        print(f"... ({len(frame)} rows; tail)")
        print(frame.tail(2).to_string(index=False))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default=os.environ.get("RIAZ_DATA_DIR", "/home/felipe/dev/axiome/riaz_de"))
    args = parser.parse_args()

    long = pd.read_csv(os.path.join(args.data_dir, PANEL_LONG))
    de = pd.read_csv(os.path.join(args.data_dir, DE_POOLED))
    strat = pd.read_csv(os.path.join(args.data_dir, DE_STRATIFIED))
    panel = sorted(long["gene"].unique())

    pre = long[long["timepoint"] == "Pre"]

    # Q12 — mean log2 CPM per gene at Pre, ranked desc.
    q12 = pre.groupby("gene")["log2_cpm"].agg(["mean", "count"]).sort_values("mean", ascending=False).round(4).reset_index()
    show("Q12", "groupby(gene).mean(log2_cpm) over timepoint == Pre, desc", q12)

    # Q13 — gene x timepoint mean.
    q13 = long.groupby(["gene", "timepoint"])["log2_cpm"].agg(["mean", "count"]).round(4).reset_index()
    show("Q13", "groupby(gene, timepoint).mean(log2_cpm)", q13[q13["gene"].isin(["CXCL9", "PRF1", "HLA-DRA"])], head=6)

    # Q14 — DISTINCT PATIENTS per response x prior_ipi (EC6: rows != patients).
    cd8a_pre = long[(long["gene"] == "CD8A") & (long["timepoint"] == "Pre")]
    q14 = cd8a_pre.groupby(["response", "prior_ipi"])["patient_id"].nunique().reset_index(name="patients")
    q14_rows = long.groupby(["response", "prior_ipi"]).size().reset_index(name="rows")
    show("Q14", "nunique(patient_id) per response x prior_ipi (gene CD8A, Pre)", q14)
    show("Q14 (EC6 trap)", "unfiltered ROW counts — what a naive count would report", q14_rows)

    # Q15 — top 10 genes by log2FoldChange among padj < 0.05.
    q15 = de[de["padj"] < 0.05].sort_values("log2FoldChange", ascending=False).head(10)[["gene", "log2FoldChange", "padj"]].round(4)
    show("Q15", "padj < 0.05, top 10 by log2FoldChange desc", q15, head=10)

    # Q16 — significant genes per direction, as two count branches.
    sig = de[de["padj"] < 0.05]
    print("\n=== Q16 — count(padj < 0.05) by direction, as two describe.count branches")
    print(f"up   (log2FoldChange > 0): n_groups = {sig[sig['log2FoldChange'] > 0]['gene'].nunique()}")
    print(f"down (log2FoldChange < 0): n_groups = {sig[sig['log2FoldChange'] < 0]['gene'].nunique()}")

    # Q17 — responders only, gene x timepoint.
    q17 = long[long["response"] == "R"].groupby(["gene", "timepoint"])["log2_cpm"].agg(["mean", "count"]).round(4).reset_index()
    show("Q17", "response == R, groupby(gene, timepoint).mean(log2_cpm)", q17[q17["gene"].isin(["PDCD1", "PRF1", "CXCL11"])], head=6)

    # Q18 — CXCL9 only, response x timepoint.
    q18 = long[long["gene"] == "CXCL9"].groupby(["response", "timepoint"])["log2_cpm"].agg(["mean", "count"]).round(4).reset_index()
    show("Q18", "gene == CXCL9, groupby(response, timepoint).mean(log2_cpm)", q18, head=4)

    # Q19 — On-treatment only, gene x response.
    q19 = long[long["timepoint"] == "On"].groupby(["gene", "response"])["log2_cpm"].agg(["mean", "count"]).round(4).reset_index()
    show("Q19", "timepoint == On, groupby(gene, response).mean(log2_cpm)", q19[q19["gene"].isin(["CD8A", "LCK", "CD3E"])], head=6)

    # Q20 — POPULATION sd per gene at Pre (ddof=0 — what bio-compute computes).
    q20 = pre.groupby("gene")["log2_cpm"].agg(std=lambda s: s.std(ddof=0), n="count").sort_values("std", ascending=False).round(4).reset_index()
    q20_sample = pre.groupby("gene")["log2_cpm"].std(ddof=1).sort_values(ascending=False).round(4)
    show("Q20", "timepoint == Pre, groupby(gene).std(log2_cpm, ddof=0) — POPULATION sd, desc", q20)
    print("  doc (sample sd, ddof=1) for the same head:")
    print(q20_sample.head(4).to_string())

    # Q21 — |log2FoldChange| of the 24 panel genes, ranked desc.
    q21 = de[de["gene"].isin(panel)].assign(abs_lfc=lambda d: d["log2FoldChange"].abs()).sort_values("abs_lfc", ascending=False)[["gene", "abs_lfc", "padj"]].round(4)
    show("Q21", "gene in the 24-gene panel, |log2FoldChange| desc (pooled Pre R vs NR)", q21)
    print(f"  panel genes: {len(panel)}; min padj in panel = {q21['padj'].min()}")
    print(f"  stratified table rows (unused by Q12-Q21, listed for completeness): {len(strat)}")


if __name__ == "__main__":
    main()

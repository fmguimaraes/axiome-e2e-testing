# AXI-1474 "Executable QC" — E2E coverage report

The Workflow 5 record of what this epic needs exercised end-to-end, what is
automated today, and where to look at each behaviour in a running local stack.

Feature doc: `axiome-docs/05 - product/features/BACKLOG-Executable-QC-Result-Snapshots.md`
Epic doc: `axiome-docs/05 - product/epics/AXI-1474-Executable-QC-Result-Snapshots.md`

**Headline: 3 of 38 acceptance criteria are covered by an automated E2E spec.**
One story of 18 (AXI-1482) carries the epic's entire E2E suite. FR58–FR63 — the
six stories opened during W5 — have none.

---

## 1. How to use this report

Bring the stack up with `make demo-up` and sign in at
<http://localhost:5173> as `admin@cro-one.com` / `admin`.

Every deep link below points at seeded data already present in the demo
database, so a link is clickable without running anything first. The four
automated specs are API-level (no browser); their links show you the same state
in the UI.

Status column:

| | Meaning |
|---|---|
| **AUTO** | Covered by a Playwright spec in `tests/AXI-1474/` |
| **MANUAL** | No automated coverage — must be walked by a human at sign-off |
| **BLOCKED** | Cannot be verified on any surface today; see §5 |

---

## 2. Seeded fixtures

| Entity | Name | Link |
|---|---|---|
| Project | Executable QC Validation | [open][P1] |
| Analysis | Default analysis — qc_sample.csv | [open][A1] |
| QC snapshot | `IMM-QC-01` result | [open][S1] |
| Dataset | `qc_sample.csv` (40 rows) | [open][D1] |
| Project | … — Staleness | [open][P3] |
| Project | … — No Container | [open][P2] |

All three projects share the one ingested dataset
`05c0299d-605d-4e85-87f9-0aae0e7ca2ff`.

---

## 3. Acceptance criteria — coverage and where to look

### AXI-1475 / AXI-1476 — run kind, operation declaration, fingerprint

| AC | What must be exercised | Status | Where |
|---|---|---|---|
| AC1 | A governed QC step produces a `RuleRun` of kind `QC` through the standard execute path | MANUAL | [Provenance graph][PROV] |

### AXI-1477 — attribute resolution & three-valued evaluation

| AC | What must be exercised | Status | Where |
|---|---|---|---|
| AC5 | Every attribute resolves ⇒ `pass`/`block`, never `degrade` | MANUAL | [QC snapshot][S1] |
| AC6 | An unresolvable attribute ⇒ `degrade`, names every unresolved key, never reports `pass` | MANUAL | [QC snapshot][S1] |
| AC7 | Decidable despite unresolved leaves ⇒ resolves, records the leaves it did not need | MANUAL | [QC snapshot][S1] |

### AXI-1478 — additive materialization & provenance node

| AC | What must be exercised | Status | Where |
|---|---|---|---|
| AC2 | Result table keeps every input row and column, plus `qc_include` / `qc_fail_reasons` | MANUAL | [QC snapshot][S1] |
| AC8 | Appends a `MaterializedView` node + `DERIVED_FROM` edge; **no new node or edge type** | MANUAL | [Provenance graph][PROV] |
| AC9 | `qcSummary` carries verdict, rule code+version, excluded count/%, ranked reasons, unresolved attrs, guard | MANUAL | [Provenance graph][PROV] |
| AC10 | A blocking verdict still materializes result/snapshot/node and fails the gate with a reason | MANUAL | [Analysis][A1] |
| AC17 | `guardOutput` present on run record, node summary and gate fact | MANUAL | [Provenance graph][PROV] |
| AC18 | No backfill script; no historical row written | MANUAL | code review only |

### AXI-1479 — dedup parity

| AC | What must be exercised | Status | Where |
|---|---|---|---|
| AC11 | An identical re-run reuses the artifact byte-identically **and, on both dedup paths, produces a result with non-floating lineage** | **BLOCKED** | see §5 — defect AXI-1536 |

### AXI-1480 — governed run gate & planner alignment

| AC | What must be exercised | Status | Where |
|---|---|---|---|
| AC16 | Planner offered only fully resolvable QC rule codes; the flag read from one place by parser and prompt builder | MANUAL | [Analysis][A1] |

### AXI-1481 — analysis surfaces

| AC | What must be exercised | Status | Where |
|---|---|---|---|
| AC3 | QC result listed in the snapshot picker as `rule_derived`, named for rule code+version, with verdict and excluded count | MANUAL | [Analysis][A1] |
| AC4 | Opening it shows `qc_include`/`qc_fail_reasons` first, excluded rows visually marked | MANUAL | [QC snapshot][S1] |
| AC12 | "Keep only QC-passed rows" creates an ordinary filter snapshot whose lineage resolves **through** the QC node | MANUAL | [QC snapshot][S1] |
| AC13 | The result gets a gallery card from its `defaultChart`, and refuses rather than guessing when a role cannot resolve | MANUAL | [Analysis][A1] |
| AC14 | A chart downstream of QC displays the governing rule and verdict, resolved by graph walk, storing nothing on the chart | MANUAL | [Analysis][A1] |
| AC15 | A result with **no** reachable QC node shows no QC affordance at all | MANUAL | [No-container project][P2] |

### AXI-1482 — dataset strip & staleness *(the only automated story)*

| AC | What must be exercised | Status | Where |
|---|---|---|---|
| AC19 | Dataset-level QC materializes in the dataset's default analysis; **no QC-only container** | **AUTO** — `AXI-1482-qc-dataset-strip.spec.ts:46` | [Analysis][A1] |
| AC19 | A dataset with no default analysis is refused, not accommodated | **AUTO** — `AXI-1482-qc-dataset-strip.spec.ts:79` | [No-container project][P2] |
| AC20 | Dataset Detail shows a QC strip with verdict, excluded count/%, dataset version per rule code, each linking to the snapshot | **AUTO** — `AXI-1482-qc-dataset-strip.spec.ts:101` | [Dataset][D1] |
| AC21 | A new dataset version appends a staleness row; every surface states the verdict was computed on the earlier version | **AUTO** — `AXI-1482-qc-staleness.spec.ts:38` | [Staleness dataset][D3] |

### AXI-1483 — QC on a chart's frozen slice

| AC | What must be exercised | Status | Where |
|---|---|---|---|
| AC22 | "Run QC on this chart's data" materializes the frozen slice, QC's it, binds a **new** chart instance, leaves the original intact | **BLOCKED** | see §5 — defect AXI-1536 |
| AC23 | `ChartArtifact --DERIVED_FROM--> ViewAnalysisSnapshot`; a downstream chart resolves its badge through it | MANUAL | [Provenance graph][PROV] |
| AC24 | A per-column OR slice materializes the row set the chart **renders**, not the AND'd intersection | MANUAL | [Analysis][A1] |
| AC25 | A chart over an unfiltered dataset takes the identical path to the no-filter snapshot | MANUAL | [Analysis][A1] |
| AC26 | A chart with no persisted slice refuses, naming that reason, and does not QC the ambient dataset | MANUAL | [Analysis][A1] |
| AC27 | A run stopped by a blocking verdict shows rule code, failing-row count and proportion, and a working snapshot link | MANUAL | [Analysis][A1] |

### AXI-1484 — one resolver, four mounts

| AC | What must be exercised | Status | Where |
|---|---|---|---|
| AC28 | One resolver supplies QC state to every surface; removing it removes the indicator everywhere | MANUAL | [Analysis][A1] |
| AC29 | The object line shows the QC control for the open snapshot, opens as a popover without displacing content, re-resolves on snapshot navigation | MANUAL | [Analysis][A1] |
| AC30 | The same component renders on standalone chart page, detailed chart view and gallery card | MANUAL | [Analysis][A1] |

### AXI-1485 / AXI-1486 — QC-enriched chart

| AC | What must be exercised | Status | Where |
|---|---|---|---|
| AC31 | Enriching twice returns the same derived spec and creates nothing the second time | MANUAL | [Analysis][A1] |
| AC32 | The base spec is byte-identical before and after; the base chart renders identically | MANUAL | [Analysis][A1] |
| AC33 | `mark_excluded` demotes with reachable reasons; `recompute_excluding` recomputes with mandatory caption; a template declaring nothing alters no computed value | MANUAL | [Analysis][A1] |
| AC34 | The QC caption appears on every surface **including export and report** | MANUAL | [Analysis][A1] |
| AC35 | The enriched node carries `DERIVED_FROM` to both base chart node and QC snapshot; no new node or edge type | MANUAL | [Provenance graph][PROV] |
| AC36 | Toggling excluded rows creates no new spec | MANUAL | [Analysis][A1] |
| AC37 | An enrichment whose QC columns bind to no declared role is refused with that reason | MANUAL | [Analysis][A1] |
| AC38 | Rule-system architecture docs updated in the same change | MANUAL | docs review only |

---

## 4. FR58–FR63 — the six W5 stories

None of these has an automated E2E spec, and three cannot currently be
demonstrated on any surface at all.

| FR | Story | What must be exercised | Status | Where |
|---|---|---|---|---|
| FR58 | AXI-1525 | A `row`-scoped resolver, and `IMM-QC-06` excluding rows outside the quantifiable range | **BLOCKED** | see §5 — the rule is inert |
| FR59 | AXI-1526 | A QC run citing an ACTIVE ruleset version: N criteria, one result table, conjunction verdict, per-row reason naming | **BLOCKED** | see §5 — not reachable from a chart |
| FR60 | AXI-1527 | Enrichment capability derived from template geometry; a template that cannot demote cannot declare `mark_excluded` | MANUAL | [Analysis][A1] |
| FR61 | AXI-1528 | A governed cut-point rendering in the threshold list, read-only, badged with rule code + version, not archivable | **BLOCKED** | see §5 — downstream of AXI-1536 |
| FR62/FR63 | AXI-1529 | Snapshot minted on **consumption** (evidence, export, threshold, annotation, rule_run), not on execution | **BLOCKED** | see §5 — defect AXI-1536 |
| FR57 | AXI-1530 | Offer-time resolution: an offered rule is guaranteed to produce a verdict | MANUAL | [Analysis][A1] |

---

## 5. Blockers found during W5

Three defects stand between this report and a sign-off. Two are open stories.

**AXI-1536 — a deduped chart QC run never binds.** `submitQcRun` passes
`deferSnapshot: true` (AXI-1529, FR62), but the `run.deduped` branch immediately
calls `bindChartToQc`, which requires `findQcSnapshot()` to already return a row.
The two features contradict each other, so a dedup hit produces a `DEDUPED` run
with no snapshot and no visible change on the chart. Proven at the data level:
run `79a6890f-93a3-45a7-ac5d-b1bf59fd2c8a` is `DEDUPED` on `IMM-QC-06`, with
`container_view_analysis_id` NULL and zero `view_analysis_snapshots` referencing
it. This blocks AC11, AC22, FR61 and FR62/FR63 — the governed cut-points *are*
correctly computed and stamped on the run's provenance node; they simply never
reach a chart to render on.

**AXI-1526 never reached the chart surface.** `rulesetId` appears nowhere in
`apps/organization-service/src/chart-qc/`, the gateway's chart-qc controller, or
the frontend's `RunChartQcInput`. The epic's central gap — "E8 blocks a second
rule, so QC cannot change a chart" — remains open.

**`IMM-QC-06` is inert on real data.** It executes correctly at row scope, but
nothing in the platform writes `meta.measurementValue`, per the resolver's own
comment in `qc-attribute-resolver-registry.ts`. Every row resolves to `unknown`,
so the rule reports `degrade` with 0 of 40 rows excluded regardless of input.
Its shipped bounds (`lloq` 0, `uloq` 9007199254740991) are a vacuously
permissive range by design, so even once rendered they will look odd on an axis.

**AXI-1537 — the QC verdict badge overlaps adjacent text** on the chart header.
Cosmetic, but it is on the surface a reviewer looks at first.

---

## 6. Recommendation

The epic should not be signed off on the current evidence. Either:

1. Land AXI-1536 and AXI-1537, then walk the MANUAL rows above by hand and
   record the result here; or
2. Land AXI-1536, then automate at minimum AC11, AC22, AC31/AC32 and FR61 —
   the four that carry the epic's actual claim ("QC can change a chart") and
   that no unit test can establish.

FR58 and FR59 should be re-scoped or explicitly deferred: neither is
demonstrable today, and no amount of test-writing changes that.

---

[P1]: http://localhost:5173/projects/73129613-4a22-45c3-9c83-03361832e5cb/overview
[P2]: http://localhost:5173/projects/5eef5628-59d9-45e6-b496-b578f4d8a200/view-analyses/c0f5f569-f417-4293-bc72-83afb3416091
[P3]: http://localhost:5173/projects/bc95327f-9437-4333-8a3e-862f7da11190/overview
[A1]: http://localhost:5173/projects/73129613-4a22-45c3-9c83-03361832e5cb/view-analyses/129b2a39-b351-47a7-b29a-4fda1c5909bc
[S1]: http://localhost:5173/projects/73129613-4a22-45c3-9c83-03361832e5cb/view-analyses/129b2a39-b351-47a7-b29a-4fda1c5909bc?snapshotId=3d380b06-a87a-44fb-9381-1dccc245e512
[PROV]: http://localhost:5173/projects/73129613-4a22-45c3-9c83-03361832e5cb/view-analyses/129b2a39-b351-47a7-b29a-4fda1c5909bc/provenance
[D1]: http://localhost:5173/projects/73129613-4a22-45c3-9c83-03361832e5cb/datasets/05c0299d-605d-4e85-87f9-0aae0e7ca2ff
[D3]: http://localhost:5173/projects/bc95327f-9437-4333-8a3e-862f7da11190/datasets/05c0299d-605d-4e85-87f9-0aae0e7ca2ff

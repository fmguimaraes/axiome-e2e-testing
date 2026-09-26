# Harness Unit Tests (SI-042, tag `SHADOW`)

First `UT.md` for `harness-unit/**`. Unit coverage for pure functions inside
`tests/**/harness/*.ts` that Playwright's own `tests/` `testDir` cannot host
(a `node:test` file under `tests/` would be picked up by Playwright's
`*.spec.ts` glob and fail to import). Run via `npm run harness:unit`
(`node:test` + `tsx --test`, same runner as `staging/steps/UT.md` and
`capture/**`, zero new dependencies).

## AXI-1462/shadow.spec.ts

AXI-1631 (epic AXI-1603 — FR28/FR31 join, follow-up to AXI-1624). Covers
`correlationIdOf` (`tests/AXI-1462/harness/shadow.ts`), the extraction that
lets the FR28 shadow harness stop writing `ShadowRunRow`s with no join key
against the FR31 attempt-telemetry log stream.

| ID | Description | Status |
|----|-------------|--------|
| UT-SHADOW-1631-1 | `correlationIdOf` reads a string `correlationId` off the plan API response body | Pass |
| UT-SHADOW-1631-2 | `correlationIdOf` returns `undefined`, never a fabricated value, when the response carries none | Pass |
| UT-SHADOW-1631-3 | `correlationIdOf` rejects a non-string `correlationId` rather than coercing it | Pass |
| UT-SHADOW-1631-4 | `correlationIdOf` treats an empty-string `correlationId` as "no id", not a real join key | Pass |

## AXI-1604/anchor-dataset.spec.ts

AXI-1661 + AXI-1662 (epic AXI-1604 — FR28/FR30). Covers `anchorDataset`, which
resolves the dataset identity and schema every planner envelope in the shadow run
is built from. AXI-1662 moved it — and this spec — to the ONE shared module
`tests/AXI-1604/harness/anchor-dataset.ts`; it was `harness-unit/AXI-1462/governed.spec.ts`
against `tests/AXI-1462/harness/governed.ts`. Until AXI-1661
it read `columns`/`versionHash` off the workspace dataset **list** row, which
carries neither, and degraded silently to `[]` and the literal
`'sha256:unknown'` — so the 2026-09-25 FR28/FR30 shadow run asked all 46 Grados
questions of both planner arms against a dataset with no schema and measured
nothing. UT-ANCHOR-1661-1/2/3 are the tests that would have caught that: an
undescribable dataset must throw, naming the dataset and what was missing.
The live half (that the real endpoints do return a real schema) is
`tests/AXI-1604/AXI-1661-anchor-dataset-schema.spec.ts` — a unit test alone
would have been green before the fix too.

**And why eight tests were not enough (AXI-1662).** They bound ONE of two copies.
`tests/AXI-1603/harness/planner.ts` carried a near-duplicate that kept every
defect above and emitted no `categories` at all, and nothing failed, because
nothing imported it. UT-ANCHOR-1662-1 is therefore a STRUCTURAL guard over the
harness sources: a second `anchorDataset` implementation, or either degradation
literal in any envelope-building harness, fails the suite. A duplicate no test
imports is invisible to every live scenario by construction, so it has to be
decided on the source. The live half of the collapse — both harnesses building
the same envelope from the same real dataset — is
`tests/AXI-1604/AXI-1662-shared-anchor-resolver.spec.ts`.

| ID | Description | Status |
|----|-------------|--------|
| UT-ANCHOR-1661-1 | A dataset whose schema resolves to ZERO columns throws — it never yields a `columns: []` envelope | Pass |
| UT-ANCHOR-1661-2 | A dataset with no sha256 content hash throws — it never substitutes the literal `sha256:unknown` | Pass |
| UT-ANCHOR-1661-3 | A version hash that is not `sha256:<64 hex>` is refused, not forwarded | Pass |
| UT-ANCHOR-1661-4 | A dataset that profiles to ZERO variables throws rather than anchoring untyped columns | Pass |
| UT-ANCHOR-1661-5 | A non-2xx from the schema endpoint throws with the status, never a silent empty schema | Pass |
| UT-ANCHOR-1661-6 | An empty workspace returns `null` (an honest "nothing to anchor on"), not a throw | Pass |
| UT-ANCHOR-1661-7 | A dataset that is not ingested yet is never anchored on — no parquet, no schema, no hash | Pass |
| UT-ANCHOR-1661-8 | A described dataset carries real column names, profiler types, categories and the real hash | Pass |
| UT-ANCHOR-1662-1 | Exactly ONE harness implements `anchorDataset`, and no envelope-building harness can degrade one | Pass |
| UT-ANCHOR-1662-2 | The AXI-1462 and AXI-1603 harnesses build their envelopes from the SAME anchor, categories and all | Pass |
| UT-ANCHOR-1662-3 | The anchored dataset names itself with `displayName`, not the deprecated `name` | Pass |
| UT-ANCHOR-1662-4 | The shared resolver contains no silent catch and no substituted hash — every degraded path throws | Pass |

## AXI-1604/gate-readiness.spec.ts

AXI-1677 (epic AXI-1604 — FR28/FR30). The three offline halves of gate
readiness: the refusal classifier, the arm selector, and the run loop's 401
policy.

**The defect UT-SHADOW-1677-1..8 pin.** `outcomeOf` scored ANY response carrying
a `body.plan` as `planned` unless `intentUnsupported`/`plannerFallback` was set.
A legacy-arm response of one `profile` node, every inferential analysis in
`declined[]` and `datasetsUsed: []` satisfied that — so on 2026-09-25 six
questions read `planned` on the legacy arm and `unsupported` on the compiled arm
when both arms had given the same answer ("this envelope has no schema; nothing
can be planned"). The FR30 report names it the single most misleading thing in
the table. The fixtures are not invented: they are the plan shapes that occurred,
transcribed from `reports/artifacts/2026-09-25-compiled-planner-shadow-run/db-plan-rows.md`.
A plan is now `refused` when it used no dataset AND contains no node that
analyses one — both halves required, because either alone libels the other
direction. `refused` was already a member of FR28's outcome vocabulary and of
`ShadowRunOutcome` in `axiome-back`; nothing downstream needed changing.

**The defect UT-SHADOW-1677-13..15 pin.** The same run's access token expired at
Q8 of the legacy arm and 39 of 46 rows were 4-13 ms `401 Invalid token`
responses written as the outcome `unavailable` — a harness artefact in the gate
evidence, indistinguishable in the table from a planner that failed to answer,
and de-contaminated afterwards by hand from row latencies. A 401 is now either
recovered from or fatal, never a row.

| ID | Description | Status |
|----|-------------|--------|
| UT-SHADOW-1677-1 | The recorded legacy Q1 plan PL-ac2885c4 scores `refused`, not `planned` | Pass |
| UT-SHADOW-1677-2 | All seven recorded legacy plans of the 2026-09-25 run score `refused` | Pass |
| UT-SHADOW-1677-3 | A plan that used a dataset and carries an analysis node is `planned` | Pass |
| UT-SHADOW-1677-4 | A genuine profiling plan that DID use a dataset is not libelled as a refusal | Pass |
| UT-SHADOW-1677-5 | A plan that used no dataset and declined nothing is still a refusal — it analysed nothing | Pass |
| UT-SHADOW-1677-6 | The planner's own `intentUnsupported` outranks the inferred refusal (FR30(a) counts it) | Pass |
| UT-SHADOW-1677-7 | The planner's own `plannerFallback` outranks the inferred refusal (FR30(b) counts it) | Pass |
| UT-SHADOW-1677-8 | A non-2xx or plan-less body stays `unavailable`; a plan carrying neither field is not invented into a refusal | Pass |
| UT-SHADOW-1677-9 | `SHADOW_RUN_ARMS` unset or empty runs every arm — the default is unchanged | Pass |
| UT-SHADOW-1677-10 | `SHADOW_RUN_ARMS=compiled` runs the compiled arm alone (FR30(c) v0.5 dropped the legacy comparison) | Pass |
| UT-SHADOW-1677-11 | `SHADOW_RUN_ARMS` accepts a list and tolerates spacing and case | Pass |
| UT-SHADOW-1677-12 | An arm not named in `SHADOW_RUN_ARMS` never runs by accident | Pass |
| UT-SHADOW-1677-13 | A 401 that survives re-authentication FAILS the run — it is never written as a row | Pass |
| UT-SHADOW-1677-14 | A 401 followed by a successful refresh is retried and recorded normally | Pass |
| UT-SHADOW-1677-15 | The token is re-minted proactively every N questions, before it can expire | Pass |

## AXI-1604/synthetic-grados-cohort.spec.ts

AXI-1677 (epic AXI-1604 — FR28/FR29/FR30). The synthetic Grados-shaped fixture
the FR30 gate run is measured on.

**The data is synthetic.** No cohort-level Grados dataset exists anywhere — the
paper published summary tables only. The COLUMN SCHEMA is transcribed from
`GRADOS_DATASET` (`axiome-back/.../compile/__fixtures__/grados-golden-intents.ts`),
the `PlannerDatasetSchema` all 46 golden `AnalysisIntent`s were hand-authored
against; the VALUES are fixed-seed PRNG output. It exists so the compiled planner
can be MEASURED on questions that have a matching column, and it is **not**
evidence about IgG4-RD. The categorical levels are written as TEXT because the
profiler types a numerically-coded column `numeric` with no categories at all,
which would put the live envelope in direct contradiction with the declaration.

UT-GRADOS-1677-5 is a DRIFT guard: `synthetic-grados-schema.ts` is a copy of a
declaration in another repo (the two share no package), and a column renamed or a
domain changed on the `axiome-back` side would otherwise leave the seeded dataset
quietly seating the old schema. It skips — loudly, never silently — where no
sibling `axiome-back` checkout exists.

| ID | Description | Status |
|----|-------------|--------|
| UT-GRADOS-1677-1 | The CSV header is exactly the declared `GRADOS_DATASET` columns, in declaration order | Pass |
| UT-GRADOS-1677-2 | Every categorical column observes its declared domain exactly — no stray level, no missing level | Pass |
| UT-GRADOS-1677-3 | The cohort and longitudinal structure the bank asks about is present (3 groups, 2 timepoints for treated subjects, both representation levels) | Pass |
| UT-GRADOS-1677-4 | The committed CSV regenerates byte-identically from its generator | Pass |
| UT-GRADOS-1677-5 | The copied schema still matches `GRADOS_DATASET` in `axiome-back` | Pass |

## AXI-1604/synthetic-grados-seed-fidelity.spec.ts

AXI-1694 (epic AXI-1687 — FR56/FR57, SI-044). Before this story `absolute_count`
was `pct × the subject's ONE total lymphocyte count`, applied FLAT to every
column regardless of nesting; lymphocyte count was one draw per subject, same
distribution in every disease group; timepoints were independent draws with no
shared subject term. So the two unit readings could never disagree for a fixed
subject, pSS lymphopenia could not exist, and pairing baseline against
post-treatment could not show a real subject effect. This story fixes all
three (see the provenance block in `generate-synthetic-grados-cohort.ts`) and
these tests pin the fix, read off the regenerated committed CSV. Bank intents
are unchanged (FR57) — nothing here alters `GRADOS_DATASET`, `grados-golden-
intents.ts` or `synthetic-grados-schema.ts`'s column contract.

**Not covered here (FR58, recorded not hidden).** "Pairing changes a paired
result" (AC57) is a property of the STATISTIC that consumes paired rows, not
of the seed — it is asserted where that statistic runs. UT-GRADOS-1694-5
proves the seed now carries the subject effect (`r(baseline, post) > 0`) a
paired statistic needs in order to differ from its unpaired twin; it does not
run that statistic itself.

| ID | Description | Status |
|----|-------------|--------|
| UT-GRADOS-1694-1 | The TFH-compartment triad (`tfh1+tfh2+tfh17`) stays within its declared 100% total except on the declared `n % 17 === 0` overflow rows, which exceed it by a guaranteed margin | Pass |
| UT-GRADOS-1694-2 | Every nested `absolute_count` child (`foxp3_pct` of CD4, `plasmablast_pct` of B cells) is at most its real parent's absolute value — the parent chain, not the flat lymphocyte count | Pass |
| UT-GRADOS-1694-3 | Baseline total lymphocyte count is lower for pSS than for the other two disease groups (pSS lymphopenia) | Pass |
| UT-GRADOS-1694-4 | Post-rituximab lymphocyte count is lower than the same subjects' own baseline | Pass |
| UT-GRADOS-1694-5 | Baseline and post-treatment lymphocyte counts are positively correlated within a subject — the subject effect is real, not accidental | Pass |
| UT-GRADOS-1694-6 | The two unit readings of a nested measure (`foxp3_pct`) can disagree — a subject pair can rank differently under `pct_of_parent` than under `absolute_count` | Pass |

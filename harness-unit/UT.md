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

## AXI-1462/governed.spec.ts

AXI-1661 (epic AXI-1604 — FR28/FR30). Covers `anchorDataset`
(`tests/AXI-1462/harness/governed.ts`), which resolves the dataset identity and
schema every planner envelope in the shadow run is built from. Until this story
it read `columns`/`versionHash` off the workspace dataset **list** row, which
carries neither, and degraded silently to `[]` and the literal
`'sha256:unknown'` — so the 2026-09-25 FR28/FR30 shadow run asked all 46 Grados
questions of both planner arms against a dataset with no schema and measured
nothing. UT-ANCHOR-1661-1/2/3 are the tests that would have caught that: an
undescribable dataset must throw, naming the dataset and what was missing.
The live half (that the real endpoints do return a real schema) is
`tests/AXI-1604/AXI-1661-anchor-dataset-schema.spec.ts` — a unit test alone
would have been green before the fix too.

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

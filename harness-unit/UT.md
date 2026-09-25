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

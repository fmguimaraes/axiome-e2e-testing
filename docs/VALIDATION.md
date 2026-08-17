# Validation summary — AXI-1260 (AC22)

Evidence that every FR and NFR of the Automated E2E Testing feature is delivered
by a story and exercised by a mechanism/spec. This is the AC22 record handed to
Workflow 5 (human epic acceptance); the human confirms it against a green
`npm run epic-acceptance AXI-1260` run plus the (empty) manual residue.

## Functional requirements

| FR | Story | Mechanism / spec |
|----|-------|------------------|
| FR1–FR5 | AXI-1261 | Playwright+TS scaffold, `tests/<EPIC>/` layout, clean-clone README |
| FR6/FR7 | AXI-1262 | `config/env.ts` facade; `AXI-1262-*` reachability specs |
| FR8 | AXI-1262 | `objectUrl()` public endpoint; FR8 spec |
| FR9/FR10/FR28 | AXI-1263 | `preflight/` globalSetup, reserved exit 78; `AXI-1263-*` |
| FR11 | AXI-1263 | verify-not-seed (`make seed` reused) |
| FR12/FR13/FR14 | AXI-1264 | `setup` project, `storageState` per role; `AXI-1264-*` |
| FR15–FR18 | AXI-1265 | `scripts/lint-specs.ts`; `AXI-1265-*` |
| FR19/FR20/FR21 | AXI-1266 | `scripts/coverage-report.ts`; `AXI-1266-*` |
| FR22–FR25 | AXI-1267 | `.github/workflows/ci.yml`, cross-repo dispatch, `docs/CI-INTEGRATION.md` |
| FR26/FR27 | AXI-1268 | config trace/screenshot/video + JUnit/HTML; `AXI-1268-*` |
| FR29–FR33 | AXI-1269 | `scripts/story-e2e-gate.ts` (label from exit code); `AXI-1269-*` |
| FR34/FR35 | AXI-1270 | `scripts/epic-acceptance.ts`, `epic-toolchain.spec.ts`; `AXI-1270-*` |
| FR36/FR37 | AXI-1272 | `scripts/migration-status.ts`, `docs/MIGRATION.md`; `AXI-1272-*` |
| FR38/FR39 | AXI-1271 | `scripts/quarantine-report.ts`, `--grep-invert=@flaky`; `AXI-1271-*` |
| FR40 | AXI-1268 | `retries: IS_CI ? 1 : 0` |

## Non-functional requirements

| NFR | Story | Evidence |
|-----|-------|----------|
| NFR1 | AXI-1267 | subset filter + bounded runtime (suite < 20 min) |
| NFR2 | AXI-1271 | quarantine report + flake-rate KPI |
| NFR3 | AXI-1264 | independent per-role setup, no order/ambient-data coupling |
| NFR4 | AXI-1265 | `no-fixed-sleep` lint rule |
| NFR5 | AXI-1265 | `prefer-semantic-selector` lint rule |
| NFR6 | AXI-1261/1264 | `.gitignore` excludes secrets/`.auth/`; env-overridable creds |
| NFR7 | AXI-1263 | synthetic seed data (`make seed`) |
| NFR8 | AXI-1261 | headless default + `test:headed`/`test:debug` scripts |
| NFR9 | AXI-1268 | CI artifact retention 90 days |
| NFR10 | AXI-1265 | AC-ID-led `test()` titles surface in failure lines |
| NFR11 | AXI-1261 | per-epic layout; adding specs needs no shared-config edit |

## Acceptance

- **AC1–AC20** — covered by the stories above (see the epic traceability table).
- **AC21** — AXI-1260 fully converted end-to-end (see [`MIGRATION.md`](MIGRATION.md)).
- **AC22** — this table; confirmed by a green `epic-acceptance` run at Workflow 5.

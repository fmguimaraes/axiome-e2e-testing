# Headless staging of the Riaz 2017 demo project

Stages the complete "Riaz RNA-Seq Volcano" demo pack (Confluence page 166789121)
onto the public-benchmark project the frontend serves at

    http://localhost:5173/biotech-one/public-datasets-io-benchmarks/riaz-2017-nivolumab-melanoma/overview

using REST only (no DB writes, no UI). Everything the demo script needs — three
dataset versions, one analysis, six charts, two thresholds, two snapshots
(pooled v1 + stratified-by-prior-ipilimumab v2), comments, six evidence items,
three interpretations, one publish, one export — lands in that one project, and
the cast identities are made able to present it in the browser.

## Command

```bash
cd axiome-global/axiome-e2e-testing
npm run stage:riaz
```

A second pack, the guided rule-bound question ("does nivolumab induce an
on-treatment cytotoxic program, and only in responders?"), builds on this one:
see [Riaz-Guided-Rule-Workflow.md](Riaz-Guided-Rule-Workflow.md)
(`npm run stage:riaz-guided`).

Entry point: [`staging/steps/stageRiaz.ts`](../staging/steps/stageRiaz.ts). It
reuses `stageTenant()` from `stage.ts` unchanged; the only differences are the
fixture re-point (below) and a final system-role grant.

## Prerequisites

| Need | Where | Notes |
|---|---|---|
| Demo stack up | `make demo-up` in the superrepo | gateway :3000, front :5173, biocompute :8000, Postgres container `axiome-localhost` |
| Platform admin | `admin@axiome.local` / `admin` | override with `STAGING_ADMIN_EMAIL` / `STAGING_ADMIN_PASSWORD` |
| Identity passwords | `~/.axiome/staging/identities.local.json` | created by `npm run stage:identities`; `STAGING_PASSWORD_<HANDLE>` overrides |
| Source CSVs | `staging/fixtures/tenantFixture.ts` `content.datasets[]` + `RIAZ_PAIRED_LONG_DATASET` | de_table, count_matrix, stratified_de_table, paired_expression_long (Riaz 2017 derived files; the last from `riaz_de/build_immune_paired_long_dataset.py`) |
| Gateway URL | `STAGING_BASE_URL` | default `http://localhost:3000` |

## What it does

1. `riazFixture()` takes `TENANT_FIXTURE`, keeps only the workspace named
   `Public Datasets — IO Benchmarks` (with `retiredProjects: []` so the E2E
   Testing project is left alone) and re-points every `content.datasets[]`
   entry at `Riaz 2017 — Nivolumab Melanoma`. Because analysis, charts,
   thresholds, snapshots, comments, evidence, interpretations, publish and
   export are all keyed off the dataset's project, the whole pack follows.
   Override the target with `STAGING_RIAZ_WORKSPACE` / `STAGING_RIAZ_PROJECT`
   (must be names the fixture declares).
2. `stageTenant()` runs the normal Kahn-ordered steps (identities → org →
   workspaces → memberships → subjects → datasets → analysis → charts →
   thresholds → snapshots → comments → evidence → interpretations → events →
   publish → export). Idempotent: a re-run reuses what exists.
3. `ensureCastDemoRole()` grants the seeded system role `Super Admin` to
   `cast-biologist`, `cast-bioinformatician`, `cast-clinician` via
   `GET /api/v1/roles` + `POST /api/v1/users/:id/roles`. The UI gates every
   analysis page on a system-role permission (`view-analysis:view`,
   `ProjectViewAnalysisDetail.tsx`), not on workspace membership, so without
   this the presenter sees "Access denied". `STAGING_RIAZ_DEMO_ROLE=""` skips
   it; any other seeded role name is accepted.

Expected tail of the log: `PASSED — stage:riaz converged on "Public Datasets —
IO Benchmarks" / "Riaz 2017 — Nivolumab Melanoma", N entity action(s).`
(N ≈ 82 on a fresh tenant, ~20 `reused` rows on a re-run.)

## Presenting it

Log in as **Marc Ottavi** (`staging-cast-biologist@axiome.local`, password from
the identity store) — NOT as `admin@axiome.local`: the platform admin is not an
org/workspace member, so scoped URLs redirect to the admin overview.

| Demo beat | Where |
|---|---|
| Beat 1 — Snapshot v1 + volcano | Project → Analysis → the single analysis → snapshot picker `Snapshot v1` → Workspace tab |
| Beat 1 — chart inspector | volcano card → Open (`/datasets/:id/chart/:chartId?...`) |
| Beat 2 — Snapshot v2 (stratified) | same analysis, snapshot picker `Snapshot v2 — stratified by prior ipilimumab exposure` |
| Beat 2 — provenance graph | analysis → Provenance tab (`/view-analyses/:id/provenance`) |
| Beat 3 — audit log | left nav → What Changed (`/what-changed`) |
| Beat 4 — export | Review Center → Published → Export preview (`/sponsor-review/views/:publishedId/export-preview`) |

## Gotchas

- **Snapshot version labels are off by one** in the picker: `Snapshot v1`
  shows `v2`, `Snapshot v2 — …` shows `v3` (the analysis auto-creates a
  baseline snapshot). Present by name, not by the version chip.
- **Publish and evidence are not idempotent server-side** (no uniqueness, no
  Evidence DELETE, snapshots immutable). `stage` de-dupes by name in its own
  bookkeeping, but if a step crashed mid-way you may see duplicates; wipe the
  project rather than re-running blind.
- **Semantic profiles are static** (`immunology`, `immuno_oncology`,
  `oncology`) and gate rule runs, not chart ranking; the volcano comes from
  template `volcano_v1`.
- `GET .../snapshots` needs `page=1`; `X-Workspace-Id` is required on
  `/projects/*`; thresholds use symbol operators; dataset ingest is
  POST → PUT presigned → PATCH finalize. See `docs/REST-API-Guide.md`.
- The role grant is a real privilege escalation on the local tenant. It is
  scoped to the three cast identities and meant for a demo stack only.

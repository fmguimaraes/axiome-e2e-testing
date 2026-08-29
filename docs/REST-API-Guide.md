# Axiome REST API Guide — for API Clients and AI Agents

**Covers:** FR20 (AC17). **Software Items:** SI-044 (this toolkit is the reference
implementation this guide documents — every route and shape below is copied from
code in `staging/**` that has run against a live instance, not from decorator
inspection alone) and SI-037 (this guide belongs in the in-app Help corpus;
see [Where this guide lives](#where-this-guide-lives) below).

**Audience:** a programmatic client or an AI agent driving Axiome entirely over
REST — no UI, no direct database access, no message-bus access. Everything here
is something this repository's own `staging/**` toolkit does for real, against a
running instance, and everything here is something an agent with only an HTTP
client and these instructions could reproduce.

**Status:** accurate as of 2026-08-29, against the Axiome gateway at commit
history through AXI-1381. Routes are cited with their source controller file so
you can re-confirm them against a newer checkout. Section 7 lists what is
**not** true yet — read it before you build automation that assumes more than
the API currently gives you.

---

## Table of contents

1. [Authentication and token lifecycle](#1-authentication-and-token-lifecycle)
2. [The resource model](#2-the-resource-model)
3. [Ordering constraints governance imposes](#3-ordering-constraints-governance-imposes)
4. [Worked end-to-end example (AC17)](#4-worked-end-to-end-example-ac17)
5. [Error semantics](#5-error-semantics)
6. [Idempotency and pagination](#6-idempotency-and-pagination)
7. [Boundaries — what the API will not do](#7-boundaries--what-the-api-will-not-do)
8. [Where this guide lives](#8-where-this-guide-lives)

---

## 1. Authentication and token lifecycle

Axiome has **no API-key or service-account primitive**. This was a deliberate
platform decision (confirmed with the founder, 28 Aug 2026): `apps/user-service/
src/auth/**` is plain email+password → JWT, and every authorization check is
`req.user.role === 'ADMIN'` plus workspace-role/capability guards in
`apps/gateway/src/guards/**`. "Service account" means an ordinary user your
client controls the credentials for — not a different auth primitive. Do not
build key issuance, rotation, or act-as delegation against this API; there is
nothing on the other end for it to talk to.

### 1.1 Logging in

```
POST /api/v1/auth/login
{ "email": "you@example.com", "password": "..." }
```

returns

```json
{ "accessToken": "<jwt>", "refreshToken": "<jwt>" }
```

Send the access token as `Authorization: Bearer <accessToken>` on every
subsequent call. Related routes on the same controller
(`apps/gateway/src/proxy/auth.controller.ts`): `POST /api/v1/auth/refresh`,
`GET /api/v1/auth/me` (resolve your own user id/email — the only way to look
yourself up; there is no lookup-by-email route, see §6.1), `PATCH /api/v1/auth/
preferences` (e.g. force light theme), `PATCH /api/v1/auth/profile` (change
your own display name).

### 1.2 Creating a user with a known password

```
POST /api/v1/users
{ "email": "...", "password": "...", "firstName": "...", "lastName": "..." }
```

`password` is an accepted optional field (`apps/gateway/src/proxy/
users.controller.ts:233`) — you can provision an account with a credential you
already know in one call. No email round-trip, no password-reset flow to
automate. There is **no lookup-by-email route** — the only REST-observable
signal for "does this user already exist" is the response to this same POST
(see §6.1 for the idempotency pattern this implies).

### 1.3 Holding several identities at once

If your client authors content under more than one name — a multi-author
comment thread, an external-vs-internal access check, anything where *who*
made the call matters — do not reuse one token and relabel the display name.
Authenticate each identity separately and keep one bearer token per identity,
selected explicitly on every call. This repository's own client
(`staging/client/TokenPool.ts` + `staging/client/RestClient.ts`) is built this
way on purpose: it has no notion of "the current identity" — every call names
who it is acting as, so authorship in the response is never a client-side
fiction.

```ts
class TokenPool {
  set(identity: string, tokens: { accessToken: string; refreshToken?: string }): void;
  get(identity: string): { accessToken: string; refreshToken?: string } | undefined;
}
// call as: client.as('cast-biologist', 'POST', '/api/v1/comments', body)
```

A role/permission grant is a separate call, not implied by user creation:
`POST /api/v1/roles` (admin-gated), `POST /api/v1/users/:id/roles`. A freshly
created role starts with `permissions: []` — expect 403s on capability-gated
routes until you grant what a guard actually requires (discovered empirically;
the gateway does not publish a required-permission-string catalog).

---

## 2. The resource model

The object graph, in creation order, with the real route for each node. Every
route below is exercised live by a file under `staging/steps/**` — the file
name is your worked example for that node's request/response shape.

| Node | Key routes | Toolkit reference |
|---|---|---|
| Organization | `POST /api/v1/organizations` | `staging/steps/ensureOrganization.ts` |
| Workspace | `POST /api/v1/workspaces`, `POST .../members`, `PATCH .../members/:userId/role` | `staging/steps/ensureWorkspacesStep.ts`, `workspaceMembership.ts` |
| Project | `POST /api/v1/projects`, `PATCH /api/v1/projects/:id` | `staging/steps/projectProvisioning.ts` — **requires `X-Workspace-Id` header even though `workspaceId` is also in the body** (§5.3) |
| Dataset + ingestion | `POST /api/v1/workspaces/:wsId/datasets` (initiate) → direct `PUT` to a presigned S3 URL → **`PATCH`** `.../datasets/:datasetId/finalize` | `staging/steps/datasetIngestion.ts`. `finalize` (a **PATCH**) auto-triggers ingestion and computes `fileHash` — do **not** also call a separate ingestions-create route, or you mint a redundant ingestion run |
| Chart / visualization spec | `POST /api/v1/workspaces/:wsId/datasets/:datasetId/candidates?viewAnalysisId=:analysisId` with `title` and `params` **inline in the POST body** (no separate title/params PATCH; `origin` is server-assigned, only read back in the response) | `staging/steps/chartStaging.ts:208`. **Never call** `.../visualizations/generate` or `.../candidates/regenerate` unless you want the platform's auto cross-product — see §7 |
| Thresholds | `POST /api/v1/thresholds` (path-less controller — no `/thresholds`-prefixed base beyond this), `GET /api/v1/visualization-specs/:specId/thresholds?status=active` | `staging/steps/thresholdStaging.ts` |
| Threshold rationale | `POST /api/v1/annotations` with `target: {type:'threshold', thresholdId}` | same file — there is no structured provenance field on `Threshold` itself; rationale text rides on an `Annotation` |
| Analysis-level (Discussion) comments | `POST /api/v1/snapshot-comments`, `PATCH .../:id/resolve`, `/reopen` — **not** `/comments`, despite the name resembling it | `staging/steps/commentStaging.ts` |
| Chart-anchored comments | `POST /api/v1/comments` (keyed by `dashboardVisualizationId`), `PATCH .../:id/resolve`, `/reopen` | same file — resolve/reopen on this route is a fix this epic added (AXI-1375); confirm it exists on the instance you're driving |
| Snapshots | `POST /api/v1/view-analyses/snapshots` (mint), `GET /api/v1/view-analyses/:id/snapshots?page=1&limit=N` (list — `page` is **not optional**, see §5.2), `PATCH /api/v1/view-analyses/:id/snapshots/:id` (rename) | `staging/steps/snapshotStaging.ts`. **Not** `.../snapshots/materialize` for minting a new one — that route is get-or-reuse-by-filter-signature, not create |
| Interpretations (= Decisions) | `POST /api/v1/workspaces/:wsId/decisions`, `POST .../:id/transition` | `staging/steps/interpretationsEvidenceStaging.ts`. **UI label ≠ backend name**: the Interpretations tab is the decision-draft routes. Searching the backend for "interpretation" finds almost nothing |
| Evidence | `POST /api/v1/view-analyses/evidences`, `GET /api/v1/view-analyses/:id/evidences?page=1&limit=N` | same file — **send `chartEntries: [...]`, not `chartArtifactIds`/`snapshotIds`** (see §5.4, a live contract-drift bug) |
| Provenance graph | `GET /api/v1/view-analyses/:viewAnalysisId/provenance-graph` | derived, read-only — shape follows whatever you staged upstream |
| Publish | `POST /api/v1/view-analyses/publish`, `GET .../published-versions` | same file — this route has **no uniqueness constraint**; calling it twice mints v1 and v2. "Exactly one published version" is a client-side rule, not a server one |
| Attestation / passport | `POST /api/v1/attestations/compute`, `POST /api/v1/attestations/passports/compute` (nested under the `attestations` prefix, **not** a top-level `/passports/...`), `GET .../passports/:datasetId/:projectId` | `staging/steps/attestationStaging.ts` |
| Sponsor export | `POST /api/v1/exports/sponsor`, `GET /api/v1/exports/sponsor/:publishedVersionId/preview`, `GET /api/v1/exports/packages` (poll job status); org logo via `POST /api/v1/organizations/:id/logo/upload-url` → presigned `PUT` → `POST .../logo/finalize` | `staging/steps/sponsorExportStaging.ts` |
| External stakeholder / client-exploration | `POST /api/v1/projects/:projectId/client-exploration/enable`, `.../members`, `PUT .../members/:clientUserId/permissions`; then, as that user, `GET .../client-exploration/published-artifacts`, `GET/POST .../artifacts/:artifactId/comments` | `staging/steps/externalScopingVerification.ts` |
| Governance events | `GET /api/v1/home/events`, `/home/metrics`, `/overview/events`, `/overview/org` | `staging/steps/governanceEventsStaging.ts` — read-only; see §7 for what this feed actually covers |

**Query capability inside a dataset:** `POST /api/v1/workspaces/:wsId/datasets/
:id/query` with `{ filters, sort, limit, offset }` — the only way to read rows
back for building statistical evidence citations
(`staging/steps/interpretationsEvidenceStaging.ts`'s `queryTopGeneRows`).

---

## 3. Ordering constraints governance imposes

The dependency graph is not a suggestion — it is enforced by what data a later
call needs to exist, and violating it either 404s, 400s, or (worse) silently
produces a tenant state that looks staged but is not. The toolkit encodes this
as an explicit, Kahn-ordered step graph
(`staging/steps/stage.ts` + `staging/steps/runSteps.ts`) rather than hoping call
order happens to be right:

```
organization
  → workspaces
    → dataset + ingestion (finalize computes File Hash; charts cannot bind before this)
      → analysis framing (scientific question, assumptions)
        → charts (origin:'user' only — never auto-generated)
          → thresholds (target an existing chart spec)
          → comments (chart-anchored + analysis-level Discussion thread)
            → snapshots v1, v2                      ┐
          → (thresholds also feed evidence/citations)│  BOTH required before:
                                                       ┘
              → interpretations + evidence + publish (cite snapshots & thresholds)
                → external-scoping verification (needs the published record + external thread)
                → attestation / passport            (needs the published record)
                  → sponsor export                  (needs attestation + published record)
                → governance events verification (runs last — reads the byproduct of every prior step)
```

Why, concretely — this is governance logic, not incidental sequencing:

- **Comments precede snapshot v2.** The external stakeholder's thread resolves
  to the v2 snapshot; minting v2 before the thread exists would make the
  resolution reference nothing real.
- **Evidence and thresholds precede interpretations/publish.** An
  interpretation (`POST .../decisions`) carries `evidenceLinks` — citing
  evidence or a snapshot that doesn't exist yet is not a request the domain
  model can express honestly; the provenance graph's `INFORMED` edges are
  built from these citations, so citing forward would just draw an edge to
  nothing.
- **A dataset must finalize before charts bind to it.** `finalizeUpload`
  computes the dataset's version identity (`fileHash`, row count); a chart
  spec created against an unfinalized dataset has nothing stable to reference.
- **Attestation and sponsor export need the published record.**
  `POST /api/v1/attestations/compute` and `POST /api/v1/exports/sponsor` both
  resolve their subject from a `publishedVersionId` / the analysis's published
  version — there is no unpublished-analysis attestation.
- **Snapshot minting is append-only and never race-ahead-safe.** Nothing on
  `POST /api/v1/view-analyses/snapshots` blocks until the row is durable in
  the same request in principle, so the toolkit still does a bounded
  read-after-write poll before treating a snapshot as usable (`awaitSnapshotVisible`
  in `staging/steps/snapshotStaging.ts`) — cheap insurance against relying on a
  write that hasn't settled.

A future story that reorders these calls without re-deriving this graph will
fail loudly (a 404/400 on a call whose dependency doesn't exist yet) rather
than silently producing a tenant that needs to be rebuilt — that fail-loud
property is itself part of what "governance" means here.

---

## 4. Worked end-to-end example (AC17)

**AC17 requires this worked example to have been executed successfully
against a live instance.** It has — repeatedly. This is not a hypothetical
walkthrough; it is what `npm run stage` (`staging/steps/stage.ts`) actually
does, and it has run green from an **empty** database twice during this epic's
operational phase (2026-08-28, logged in the epic's dev-context under
"OPERATIONAL PHASE — clean rebuild green, AC1 met"), and its read-only
counterpart `npm run verify` was **re-run today (2026-08-29) against the live
local instance at `http://localhost:3000` as part of writing this guide, and
exited 0**:

```
STAGING_BASE_URL=http://localhost:3000 \
STAGING_ADMIN_EMAIL=admin@axiome.local \
STAGING_ADMIN_PASSWORD=admin \
npm run verify
```

```
[verify] PASS — Capture Spec §2.2/AC5 — one corpus, real gene symbols: 3 dataset(s) share one corpus, all live, real gene symbols confirmed
[verify] PASS — Capture Spec §2.3/AC13 — no counter reads zero: activeProjects=2 ingestionJobs=4 qcJobs=4 governanceEvents=5
[verify] PASS — Capture Spec §7/AC9 — multi-author threads, chart-anchored count: internal thread: 3 authors, reply present, resolved present; external thread: 3 message(s), 1 external author; 4 chart-anchored comment(s)
[verify] PASS — Capture Spec §6.1/§6.2/AC6 — six user-created charts, origin: 6 declared user-origin chart(s) confirmed live
[verify] PASS — Capture Spec §9/AC11 — interpretations, evidence, published, fork: interpretations=3 evidence=6 published=1 fork=yes
[verify] PASS — Capture Spec §4/§8/AC10 — thresholds with provenance, snapshots v1/v2: 2 thresholds with provenance labels, 2 rationale annotation(s); snapshot v1 and v2 both materialized, v2 bound to a distinct dataset
[verify] PASS — Capture Spec §5/AC8 — assumptions chip reads exactly 3: 3 active assumptions confirmed
[verify] PASS — Capture Spec §21/AC12/EC5/EC6 — external-scope isolation: 8 probe(s): genuine scoping confirmed
PASSED — all 8 Capture Spec §18 rule(s) hold (FR18/AC1). Capture may proceed.
```

`verify` is read-only over the tenant that `stage` already built, so this run
proves the same object graph `stage` produces still holds live, right now,
against the instance this guide's routes were checked against.

### 4.1 The sequence, step by step, with real shapes

1. **Authenticate the service identity and bootstrap it if needed.**
   ```
   POST /api/v1/auth/login  { email: admin@axiome.local, password: admin }  → { accessToken, refreshToken }
   POST /api/v1/users       { email: staging-service@axiome.local, password, firstName, lastName }  (as admin, tolerant of "already exists")
   POST /api/v1/roles       { name: "staging-service-account", scope: "SYSTEM", permissions: [] }   (admin-gated, first run only)
   POST /api/v1/users/:id/roles  { roleId }
   ```
2. **Provision the tenant shell.**
   ```
   POST /api/v1/organizations   { name: "Biotech One" }
   POST /api/v1/workspaces      { name: "Translational Immuno-Oncology", organizationId }
   POST /api/v1/projects        { name: "Melanoma IO cohort, paired timepoints", workspaceId }
     — header X-Workspace-Id: <workspaceId> is REQUIRED on every /projects call
   ```
3. **Ingest the dataset.**
   ```
   POST /api/v1/workspaces/:wsId/datasets  { filename, ... }  → { id, uploadUrl }
   PUT  <uploadUrl>  <raw CSV bytes>                            (direct to storage, not the gateway)
   PATCH /api/v1/workspaces/:wsId/datasets/:datasetId/finalize  → fileHash computed, ingestion auto-triggered (finalize is a PATCH)
   ```
4. **Frame the analysis.**
   ```
   PATCH /api/v1/view-analyses/:id/review-question  { question: "Does the pre-therapy transcriptional profile separate nivolumab responders from non-responders?" }
   POST  /api/v1/view-analyses/:id/assumptions       { type: "cohort_definition", text: "..." }   (x3 — a 4th was correctly withheld, see §6)
   ```
5. **Build charts.** One POST per chart — `title` and `params` go inline in the create body; `origin` is server-assigned (you read it back as `"user"`, you do not send it):
   ```
   POST /api/v1/workspaces/:wsId/datasets/:datasetId/candidates?viewAnalysisId=:analysisId
        { title: "Volcano, pre-therapy R vs NR (baseMean >= 10)", params: { ... } }
   ```
   Note: volcano render params like `yAxisTransform: "neg_log10"` / `colorBy: "significance"` are accepted by the untyped `params` blob but are **not** contract fields — the volcano renderer reads them via the saved spec on the front end; they do not round-trip through a typed API read. Do not rely on reading them back from a generic candidate GET.
6. **Declare governance thresholds.**
   ```
   POST /api/v1/thresholds   { visualizationSpecId, field: "log2FoldChange", operator: "gte", value: 1, label: "..." }
   POST /api/v1/annotations  { visualizationSpecId, text: "<rationale>", author: "Marc Ottavi", target: { type: "threshold", thresholdId } }
   ```
7. **Stage collaboration.**
   ```
   POST /api/v1/snapshot-comments  { anchorType: "view_analysis", anchorId, body }
   POST /api/v1/comments           { dashboardVisualizationId, body }
   PATCH .../comments/:id/resolve
   ```
8. **Mint snapshots.**
   ```
   POST /api/v1/view-analyses/snapshots  { viewAnalysisId, filters: [] }                              → v1
   POST /api/v1/view-analyses/snapshots  { viewAnalysisId, filters: [], datasetId, origin: "linked" }  → v2 (real stratified contrast, distinct dataset)
   ```
9. **Cite evidence, interpret, publish.**
   ```
   POST /api/v1/view-analyses/evidences  { viewAnalysisId, chartEntries: [{chartArtifactId, snapshotId, datasetVersionId}], title, text }
   POST /api/v1/workspaces/:wsId/decisions  { label, type, confidence, context: {intendedUse:"RUO"}, evidenceLinks: [{evidenceId}] }
   POST .../decisions/:id/transition  { targetStatus: "reviewed" }   → then "approved"
   POST /api/v1/view-analyses/publish  { viewAnalysisId, evidenceVersionIds, decisionIds }
   ```
10. **Attest, export, verify scope.**
    ```
    POST /api/v1/attestations/passports/compute  { datasetId, projectId }
    POST /api/v1/attestations/compute            { artifactId: analysisId, artifactType: "view_analysis", datasetId, projectId }
    POST /api/v1/exports/sponsor                 { publishedVersionId }
    GET  /api/v1/exports/sponsor/:publishedVersionId/preview?renderMode=sponsor
    GET  /api/v1/projects/:projectId/client-exploration/published-artifacts   (as the external-stakeholder identity — should be the ONLY thing they can reach)
    ```
11. **Read back the governance surface.**
    ```
    GET /api/v1/home/metrics    → non-zero counters
    GET /api/v1/home/events     → varied governance events, ≥3 distinct authors
    ```

An agent driving this end-to-end need only: authenticate the identities it
needs, call these routes in this order (never ahead of a dependency), and
treat every non-2xx as real (see §5) rather than guessing at a workaround.

---

## 5. Error semantics

- **400 — bad request body.** Missing a required field or an invalid enum
  value. Real example found in this epic: `PATCH /api/v1/view-analyses/:id/
  snapshots/:id` declares `performedBy` as required (`@IsString()`, no
  `@IsOptional()`) even though the gateway controller **overwrites it anyway**
  from the caller's own identity before forwarding — so a body that omits it
  (the only field a caller can legitimately set) 400s before that override
  ever runs. Workaround: send a throwaway placeholder string; the server
  discards it. Lesson for any route you haven't used before: don't assume a
  DTO's "required" list matches what the handler actually consumes — treat an
  unexpected 400 as informative, not as proof your intent was wrong.
- **401 — no or invalid bearer token.** You called `.as(identity, ...)` before
  that identity logged in, or the token expired.
- **403 — authenticated, but the guard denies you.** This is how the platform
  enforces workspace membership: `WorkspaceGuard` 403s any caller who is not a
  `WorkspaceMember` of the target workspace, confirmed live in §4's external-
  stakeholder probes (`snapshot-comments`, `decisions`, `evidences` all 403 for
  that identity). **A 403 here is deliberate hiding, not a bug** — the
  external-stakeholder invitation flow creates only a `ClientExplorationMembership`
  row, never a `WorkspaceMember` row, so internal surfaces are structurally
  unreachable for that identity, not merely unlinked-to in the UI.
- **404 — route vs. resource, be careful which one you're getting.** A missing
  *route* 404s the same way a missing *resource id* does. Two concrete traps
  found in this epic: (a) `/api/v1/passports/compute` looks top-level from the
  dev-context's shorthand but is nested under `/api/v1/attestations/passports/
  compute` — the bare path 404s ("Cannot POST /api/v1/passports/compute") even
  though the *feature* exists; (b) a route-existence **probe** (unauthenticated
  or deliberately unauthorized) treats 404 as "route missing" and any other
  status (401/403/400) as "route exists" — this is how `staging/audit/probe.ts`
  tells the two apart without a live schema to consult.
- **The `X-Workspace-Id` header requirement.** `/api/v1/projects/*` routes
  require this header even when `workspaceId` is also present in the request
  body — omitting it is a silent scoping failure on some routes and an
  explicit error on others; always send it (`staging/steps/projectProvisioning.ts`'s
  `projectHeaders()` helper exists for exactly this).
- **Admin-scoped routes.** `POST /api/v1/roles` and organization/workspace
  *listing* routes are admin-gated; a non-admin caller gets a 500 rather than
  a clean 403 on the listing routes specifically (logged as a real bug, not
  fixed here — see §7). Do discovery as an admin identity, act as the target
  identity for everything else.

---

## 6. Idempotency and pagination

### 6.1 Idempotency — create-or-reuse, and the GET-fail-loud rule

**There is no lookup-by-email route for users**, and in general very few
resources have a dedicated "does X exist" endpoint. The idempotent pattern
this toolkit uses everywhere, and that you should use too:

1. `POST` the create call.
2. If it succeeds (2xx), you created it — record the returned id.
3. If it fails with a status consistent with "already exists" (never blindly
   assume this — see below), fall back to a `GET`/list call, filter client-side
   by a natural key (name, filename, title, label — whatever the fixture
   declares as identity), and use the id you find.
4. **Never treat a non-2xx GET as "empty."** `RestClient.as()` never throws on
   a non-2xx status — that is a design choice so a caller can inspect it — but
   every "find existing X" GET in this codebase explicitly does
   `if (!res.ok) throw` before falling back to `res.body?.data ?? []`. A
   version that skips this and does `res.body?.data ?? []` unconditionally
   will silently read "not found" out of a transient 500 and re-create a
   duplicate on every retry. This was a real, caught bug in this epic
   (interpretationsEvidenceStaging.ts, duplicate evidence from exactly this
   pattern) — treat it as load-bearing advice, not a style preference.
5. For users specifically: create-or-login. `POST /api/v1/users` either
   succeeds (new user) or fails (user exists) — either way, immediately
   `login()` as that identity. `login()` itself throws on a real failure, so
   it can never mask a wrong password as "found."

Two structural idempotency gaps to design around, both real:

- **No DELETE for Evidence.** Evidence, once created, cannot be removed over
  REST. If your idempotency check has a bug, duplicates accumulate and the
  only fix is a clean rebuild from an empty tenant.
- **Snapshots are immutable once created** (no `datasetId` PATCH field, no
  DELETE). If a snapshot was created pointing at the wrong dataset, the only
  REST-available correction is to rename it out of the way (so it stops
  colliding with the name your idempotency check looks for) and mint a fresh
  one — never assume a snapshot can be "fixed in place."
- **Publish has no uniqueness constraint.** `POST /api/v1/view-analyses/publish`
  will happily create v2, v3, ... on repeat calls. "Exactly one published
  version" is a rule your client must enforce (`GET .../published-versions`,
  skip if non-empty) — the server will not stop you.

### 6.2 Pagination

List routes generally take `page`/`limit` query params, 1-indexed. One route
found to actively require `page` even when you don't otherwise care about it:
`GET /api/v1/view-analyses/:id/snapshots` — omitting `page` 500s (a negative
`skip` reaches Prisma because the RPC layer doesn't leave a truly-omitted
param `undefined` on arrival, so the handler's own `page = 1` default never
fires). **Always send `page=1&limit=N` explicitly on this route.** Other list
routes (evidences, decisions, datasets) tolerate omission more gracefully but
sending both explicitly is the safer default across the board.

---

## 7. Boundaries — what the API will not do

Be honest with any agent driving this API about what it currently cannot do,
so it doesn't waste calls discovering these the hard way:

- **No API keys, no service-account primitive, no act-as/impersonation.**
  Every identity is a real user with a real password your client holds. There
  is no way to mint a scoped, revocable credential distinct from a login.
- **RUO boundary.** Interpretations are staged with `context: { intendedUse:
  "RUO" }` (Research Use Only) — this is not incidental; the platform's
  governance model does not currently support a clinical-use attestation path.
  Don't build automation that assumes one.
- **No structured threshold provenance field, and no absolute-value operator.**
  A threshold's "why" lives on a separate `Annotation`, not a field on
  `Threshold` itself. `ThresholdOperator` also has no way to express a
  two-sided cutoff like `|log2FC| ≥ 1` as one row — express the positive
  boundary and say in the label/rationale that it's symmetric.
- **No REST delete/archive for Evidence.** See §6.1 — a mistake here needs a
  tenant rebuild, not a follow-up call.
- **`GET /view-analyses/:id/snapshots` 500s without `page`; `PATCH .../snapshots/:id`
  400s without a placeholder `performedBy`.** Both logged, neither fixed as of
  this writing — see §5.
- **The governance events feed only surfaces 2 of 8 real governance-event
  kinds.** `interpretation_published` and `dataset_ingested` project into
  `/home/events`/`/overview/events`; six real, correctly-attributed audit
  entries (`threshold_declared`, `snapshot_created`, `evidence_declared`,
  `external_member_invited`, `comment_resolved`, `attestation_computed`) are
  written to their own audit tables but never read by either feed's
  projector. `POST /api/v1/engagement/events` is **not** a usable workaround —
  it's admin-gated and always attributes the event to the caller, so it can't
  produce agent- or cast-authored events. If your automation depends on a
  complete governance feed, this API does not currently provide one.
- **Org/workspace *listing* routes 500 for a non-member instead of returning
  403.** Do discovery as an admin identity.
- **`DELETE`/`PATCH /api/v1/projects/:id` 500 on an active or archived project
  in specific states** (found live, not universally reproduced — archive
  before deleting, unarchive before patching, and treat a 500 here as
  possibly a known gap rather than a client error).
- **`CreateEvidenceRequest`'s declared gateway type doesn't match what the
  service actually consumes.** The contract lists flat `chartArtifactIds`/
  `snapshotIds`; the service reads `chartEntries[]`. Sending the flat shape is
  **silently accepted** (201, no error) and produces evidence with empty
  bindings — always send `chartEntries`.
- **Client-exploration published-artifact/external-thread GET routes have no
  per-caller membership check beyond "authenticated."** Any valid bearer
  token — not just an invited member's — can currently read a project's
  published-artifacts feed and its external comment thread. This is
  distinct from the internal-surface hiding described in §5 (which *is*
  correctly enforced); it's a real, disclosed gap in the other direction.
- **No evaluative/breach threshold state.** `ThresholdStatus` is
  `active|superseded|archived` only — there is no "failed" or "breached"
  status to build alerting logic against.

None of the above are secrets discovered by reading source no client could
see; every one of them is directly observable over REST (a 500 where you
expected a 403, a feed that stays sparse no matter what you write elsewhere,
a route that accepts a shape and silently drops it) — this section exists so
you don't have to rediscover them by trial and error.

---

## 8. Where this guide lives

This file lives at `axiome-e2e-testing/docs/REST-API-Guide.md` — inside SI-044
(the staging/capture toolkit), because the toolkit **is** this guide's
reference implementation: every route cited above is exercised by a file in
`staging/steps/**`, and the worked example in §4 is that toolkit's own `npm run
stage`/`npm run verify` commands, not a separate hand-written narrative that
could drift from what the code actually does.

FR20 also names SI-037 (the in-app Help UI, `axiome-front/src/docs/**`) as a
place this guide could surface for a logged-in user browsing Help. That is a
**separate follow-up**, not done as part of this story: SI-037's corpus lives
in a different repository (`axiome-front`), has its own build-time indexer and
markdown-rendering pipeline, and copying this content there risks exactly the
drift this guide's approach (cite the code, don't restate it) is designed to
avoid. The clean way to do it later is a short SI-037 page that links out to
this file (or a generated excerpt) rather than a duplicated copy — flagged
here, not built here, so it isn't lost.

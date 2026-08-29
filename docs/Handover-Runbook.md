# Handover Runbook — Website Screenshot Staging (AXI-1368)

> **Covers:** FR21 (this runbook), FR22 (the Confluence publication plan, §6 below).
> **Audience:** an operator with a local Axiome stack and the Riaz dataset files on
> disk, who has never run this toolkit before. Every command below was executed
> against a live local stack on 2026-08-29 while writing this document — the
> transcripts are real, not illustrative.
> **Scope boundary:** this runbook gets you to captured masters and a
> ready-to-run publish command. **It does not publish to Confluence.** The
> publish step is a founder-approved outward action — see §6.

---

## 1 · Prerequisites

1. **Local stack up.**
   ```bash
   cd axiome-infra && make local-up
   ```
   Verify all containers are healthy: `docker ps` should show
   `axiome-backend`, `axiome-frontend`, `axiome-postgres`, `axiome-biocompute`,
   `axiome-minio`, `axiome-mongodb`, `axiome-rabbitmq`, `axiome-redis` all
   `Up ... (healthy)`. Frontend on `http://localhost:5173`, gateway on
   `http://localhost:3000`.

2. **The Riaz dataset files on disk.** Four CSVs, referenced by the fixture
   (`axiome-e2e-testing/staging/fixtures/tenantFixture.ts`) at these exact
   default paths — override any of them with the listed env var if your
   checkout puts them elsewhere:

   | Role | Default local path | Override env var |
   |---|---|---|
   | DE table (pre-therapy R vs NR) | `/home/felipe/dev/axiome/riaz_de/riaz_pre_therapy_responders_vs_nonresponders.csv` | `STAGING_RIAZ_DE_CSV_PATH` |
   | Count matrix (expression by response/timepoint) | `/home/felipe/dev/axiome/riaz_de/riaz2017_counts_by_response_timepoint.csv` | `STAGING_RIAZ_COUNT_MATRIX_CSV_PATH` |
   | Stratified DE (by prior ipilimumab exposure) | `/home/felipe/dev/axiome/riaz_de/riaz_stratified_pre_R_vs_NR_by_prior_ipi.csv` | `STAGING_RIAZ_STRATIFIED_DE_CSV_PATH` |
   | Subject paired timepoints | `/home/felipe/dev/axiome/riaz_de/riaz2017_subject_paired_timepoints.csv` | `STAGING_RIAZ_SUBJECT_TIMEPOINTS_CSV_PATH` |

   These are uploaded under staged filenames (`riaz2017_de_pre_R_vs_NR.csv`,
   `riaz2017_expression_by_response_timepoint.csv`,
   `riaz2017_stratified_de_by_prior_ipi.csv`) per Capture Spec §2.1 — the
   toolkit renames on upload, you do not need to rename the source files.

3. **`~/.axiome/staging` credential store.** The toolkit persists generated
   identity passwords at `${STAGING_AUTH_DIR:-~/.axiome/staging}/identities.local.json`,
   deliberately outside any worktree so a merge never destroys it (AXI-1372
   Risk-B fix). **Do not delete this file while the tenant is alive** — doing
   so makes the next `stage` run 401 against identities it can no longer log
   in as. If you *are* doing a full clean rebuild (§3), deleting it is part
   of the documented procedure, in that specific order, together with the DB
   reset — never delete it against a live tenant on its own.

4. **Admin credentials.** Bootstrap admin is `admin@axiome.local` / `admin`
   locally (re-provisioned automatically on an empty DB). This is the *only*
   account you supply manually; every other identity (`service`, three cast
   accounts, `external-stakeholder`) is created and logged into by the
   toolkit itself over `POST /api/v1/users` (FR2).

5. **Toolkit checked out and installed.** `axiome-e2e-testing` at or after
   `d604326` (AXI-1382 merged). `npm install` (or a symlinked `node_modules`
   from a sibling checkout, as this worktree uses).

---

## 2 · Sanity checks before you touch anything

```bash
cd axiome-e2e-testing
npm run typecheck        # tsc --noEmit — must be clean
npm run stage:no-backdoor  # NFR3/AC2 mechanical guard — must pass
```

Both were run against this exact worktree while writing this runbook and
passed:

```
> tsc --noEmit
(no output — clean)

> tsx staging/checks/noBackdoor.ts
no-backdoor check passed — scanned staging, capture, no DB/bus/seed import found.
```

If either fails, stop — do not proceed to staging against a toolkit that
doesn't typecheck or that has grown a direct-DB/bus import.

---

## 3 · The reconcile + clean-rebuild procedure

**When you need this:** only when the running stack's backend/frontend
containers are serving stale or diverged code (the *primary* checkouts often
carry another session's uncommitted work — see `AXI-983` in project memory),
or when you need a guaranteed-empty tenant to prove NFR1 idempotency from
scratch. If the stack is already reconciled and serving `origin/main` (check
`axiome-infra/docker-compose.override.yml` — see step 3.1), you can usually
skip straight to §4.

### 3.1 Repoint docker at origin/main worktrees, not the primary checkouts

The primary `axiome-back`/`axiome-front` checkouts are **never** touched
directly (AXI-983 discipline: they may be carrying another session's dirty
work). Instead, stand up dedicated worktrees tracking `origin/main`:

```bash
git worktree add /home/felipe/dev/axiome/_worktrees/axiome-back-main-live -b axiome-back-main-live origin/main
git worktree add /home/felipe/dev/axiome/_worktrees/axiome-front-main-live -b axiome-front-main-live origin/main
```

(Skip creation if these worktrees already exist — `git -C <path> pull
--ff-only origin main` to refresh instead.)

If the worktree carries a symlinked `node_modules` (used for standalone
`tsc`/`vitest` runs), **remove the symlink before the Docker mount** —
Docker fails with "not a directory" against a symlinked `node_modules`
(known pitfall, project memory).

Point `axiome-infra/docker-compose.override.yml` at those worktrees:

```yaml
services:
  backend:
    volumes:
      - ../../_worktrees/axiome-back-main-live:/app
      - backend_mainlive_node_modules:/app/node_modules
  frontend:
    volumes:
      - ../../_worktrees/axiome-front-main-live:/app
      - frontend_mainlive_node_modules:/app/node_modules
  biocompute:
    volumes:
      - ../axiome-bio-compute:/app
volumes:
  backend_mainlive_node_modules:
  frontend_mainlive_node_modules:
```

(This exact override is already checked in as
`axiome-infra/docker-compose.override.yml` as of the 2026-08-28 reconcile —
confirm it matches the above before relying on it; a backup of the
pre-reconcile override is kept at
`docker-compose.override.yml.pre-1368-reconcile.bak` if you ever need to
revert to serving the primary checkouts.)

### 3.2 Reset the database

```bash
cd axiome-infra
docker compose down
docker volume rm axiome-infra_postgres_data
make local-up
```

### 3.3 Run migrations (not automatic under `npm run dev`)

Inside the backend container, per service:

```bash
docker exec -it axiome-backend sh -c "cd apps/user-service && npx prisma migrate deploy"
docker exec -it axiome-backend sh -c "cd apps/organization-service && npx prisma migrate deploy"
```

(Only these two services carry migrations relevant to this epic's schema
changes — e.g. the AXI-1375 `ChartComment` resolve/reopen migration lands in
organization-service. The Prisma *client* persists in the `node_modules`
Docker volume, so a re-reset only needs re-running `migrate deploy`, not
`prisma generate`, unless the `node_modules` volume was also wiped — in that
case run `npm run prisma:generate` first or services return 503.)

### 3.4 Restart backend, clear the identity store

```bash
docker restart axiome-backend
rm ~/.axiome/staging/identities.local.json
```

The bootstrap admin (`admin@axiome.local` / `admin`) re-provisions itself on
the empty DB automatically — no manual seeding needed.

### 3.5 Stage from empty

```bash
STAGING_BASE_URL=http://localhost:3000 \
STAGING_ADMIN_EMAIL=admin@axiome.local \
STAGING_ADMIN_PASSWORD=admin \
npm run stage
```

This is idempotent (AC1/NFR1) — running it a second time converges without
duplicates or errors, which is exactly what was proven twice during the
epic's own operational-phase rebuild (2026-08-28).

---

## 4 · Stage → Verify → Capture (the routine path)

If the stack is already reconciled and staged (skip §3 entirely), this is
the loop you re-run on every refresh:

```bash
cd axiome-e2e-testing

# 1. Stage (idempotent — safe to re-run against an already-staged tenant, AC1)
STAGING_BASE_URL=http://localhost:3000 \
STAGING_ADMIN_EMAIL=admin@axiome.local \
STAGING_ADMIN_PASSWORD=admin \
npm run stage

# 2. Verify (gate — must exit 0 before capture)
STAGING_BASE_URL=http://localhost:3000 \
STAGING_ADMIN_EMAIL=admin@axiome.local \
STAGING_ADMIN_PASSWORD=admin \
npm run verify

# 3. Capture (re-runs the verify gate internally, then drives the browser)
CAPTURE_FRONTEND_URL=http://localhost:5173 \
STAGING_BASE_URL=http://localhost:3000 \
STAGING_ADMIN_EMAIL=admin@axiome.local \
STAGING_ADMIN_PASSWORD=admin \
npm run capture
```

### What green looks like

**`verify`** prints one `[verify] PASS — ...` line per Capture Spec §18 rule
and ends with `PASSED — all 8 Capture Spec §18 rule(s) hold (FR18/AC1).
Capture may proceed.` Actual output from this run:

```
[verify] PASS — Capture Spec §2.2/AC5 — one corpus, real gene symbols
[verify] PASS — Capture Spec §2.3/AC13 — no counter reads zero
[verify] PASS — Capture Spec §7/AC9 — multi-author threads, chart-anchored count
[verify] PASS — Capture Spec §6.1/§6.2/AC6 — six user-created charts, origin
[verify] PASS — Capture Spec §9/AC11 — interpretations, evidence, published, fork
[verify] PASS — Capture Spec §4/§8/AC10 — thresholds with provenance, snapshots v1/v2
[verify] PASS — Capture Spec §5/AC8 — assumptions chip reads exactly 3
[verify] PASS — Capture Spec §21/AC12/EC5/EC6 — external-scope isolation
PASSED — all 8 Capture Spec §18 rule(s) hold (FR18/AC1). Capture may proceed.
```

If any rule prints `FAIL`, `verify` exits non-zero and `capture` refuses to
launch a browser at all (`[capture] verify gate PASSED — proceeding to
capture.` never prints) — this is deliberate: "`verify` is a gate, not a
report" (dev-epic-context). Fix the underlying staged content, don't try to
capture around a failing gate.

**`capture`** prints one `[capture] M<n>: CAPTURED (4800x3000)` line per
successful master and ends with a summary count. Actual output from this
run:

```
[capture] M1: CAPTURED (4800x3000)
[capture] M2: CAPTURED (4800x3000)
[capture] M3: CAPTURED (4800x3000)
[capture] M4: CAPTURED (4800x3000)
[capture] M5: CAPTURED (4800x3000)
[capture] M6: CAPTURED (4800x3000)
[capture] M7: CAPTURED (4800x3000)
[capture] M8: CAPTURED (4800x3000)
[capture] M9: CAPTURED (4800x3000)
[capture] M10: CAPTURED (4800x3000)
[capture] M11: CAPTURED (4800x3000)
[capture] M12: BLOCKED — OQ4 (dev-epic-context): no flow-cytometry data exists
[capture] DONE — 11/12 masters captured.
```

Output lands at `capture/masters/M<n>.png` (4800×3000px = 2400×1500 logical
viewport at 2× DPR, light theme, no browser chrome — FR19/AC14) plus a
machine-readable `capture/masters/summary.json` (title + status + detail per
master). Both are gitignored — regenerate on demand, don't try to commit
them.

A **`BLOCKED`** master is not a failure of the run: the harness deliberately
produces no frame rather than a wrong one when a precondition doesn't hold
(§5 below explains M12's block). Everything else continuing to capture after
a block, rather than aborting the whole run, is intentional (see
`capture/README.md` step 4).

---

## 5 · Known blockers and limitations — read before you're surprised

- **M12 is permanently blocked**, not intermittently. There is no
  flow-cytometry population-frequency data for this tenant (OQ4, unresolved)
  and producing it is explicitly out of `SI-044`'s scope — the toolkit stages
  content against the platform's *existing* REST surface; it does not
  fabricate a new data source. Do not spend time debugging this as if it
  were a flaky capture.
- **M1 and M2 show 4 of the 6 user-created charts**, not 6. Two charts are
  cross-dataset (they live on the count-matrix dataset's own gallery per
  Capture Spec §6.2 #5–#6, not merged into the analysis's chart gallery) and
  are excluded from these two masters — this is a disclosed exclusion, not a
  bug or a faked frame.
- **M8 (stakeholder view) is Daniel Reiss's reachable published seat**, not a
  combined external-thread frame. The REST-level scoping (hiding vs
  disabling, EC6) is separately proven by `verify`'s external-scope rule —
  M8 itself is the UI screenshot of what his account can see.
- **M11 and M12 have no assigned site slot yet.** Capture Spec §17's 19-slot
  map (§6 below) does not place either — that's OQ3 (site-side, does not
  gate staging), still open as of this writing. M11 is captured and ready;
  it simply has nowhere to go on the site until that's decided.
- **The REST-gap backlog** (13 items found during staging, logged for
  founder triage at W5 — none block staging/capture): missing
  Evidence delete/archive route; `GET .../snapshots` 500s without a `page`
  param; `PATCH .../snapshots/:id` 400s without `performedBy`; org/workspace
  list is admin-scoped (500 not 403 for a non-member); `DELETE`/`PATCH
  /projects/:id` 500 on active/archived rows; the event projector only
  surfaces 2 of 8 governance-event kinds into any REST-readable feed; no
  per-caller membership check on `published-artifacts`/external-thread GETs
  beyond `AuthGuard`; and others. Full list: dev-epic-context's "REST-GAP
  BACKLOG" section. None of these change the runbook — they're product
  follow-ups, not staging blockers.
- **The running-stack-vs-primary-checkout note.** The docker stack currently
  serves `_worktrees/axiome-back-main-live` / `_worktrees/axiome-front-main-live`
  (origin/main), not the primary `axiome-back`/`axiome-front` checkouts — see
  §3.1. If a future session repoints the override back to the primaries
  (restoring `docker-compose.override.yml.pre-1368-reconcile.bak`), any
  merged fixes not yet in those primaries' working tree will silently regress
  out of the running stack. Check the override file first if a capture looks
  stale relative to what you expect from `main`.
- **A full `stage` from empty completes in well under NFR6's 15-minute
  budget** (single-digit minutes on this local stack, both toolkit steps
  combined) — a rebuild is a routine act, not an event, in practice as well
  as by requirement.

---

## 6 · Publication plan (FR22/AC19) — PREPARED, NOT PUBLISHED

**⛔ This section is a plan and a ready-to-run command, not an executed
action.** Publishing to Confluence is a founder-approved outward action.
Nothing in this runbook, and nothing run while producing it, has posted
anything to Confluence. The publish step below is presented so it is a
single command away once the founder signs off.

### 6.1 Target

**Parent page:** Confluence page `274857986`, "Website Screenshot Staging
Specification", space `axiome` (space ID `31490052`) — OQ1, answered by the
founder 2026-08-28 (dev-epic-context). The new page is created as a **child**
of this page.

**Confirmed live** by reading the parent page (read-only fetch, via
`scripts/jira/get_confluence_page.py 274857986`) while preparing this plan —
its title and space ID above are taken directly from that response, not
assumed.

### 6.2 Master → slot mapping (Capture Spec §17, transcribed exactly)

11 of 12 masters were captured (M12 blocked, §5). Every row below is taken
verbatim from Capture Spec §17's 19-slot table, cross-referenced against the
real `capture/masters/summary.json` titles from the run in §4.

| Master | Title (from `summary.json`) | Slot(s) it serves (page — location — ratio) | Status |
|---|---|---|---|
| **M1** | Question + Assumptions popover + user-created charts (wide) | index — hero carousel 3 (16:10.4, popover closed, chip visible); platform — hero (16:10.4, popover open, wide); platform — "The context" (16:9, cropped tight to bar + popover) | Captured |
| **M2** | Explore — filtered table + chart gallery (Table view) | index — hero carousel 1 (16:10.4); index — tab: Explore (16:10) | Captured |
| **M3** | Volcano detail, publication mode, hovered significant point | index — differentiator row 3 (520×360); platform — "The evidence" (16:9, alternate to M7) | Captured |
| **M4** | Discussion panel — 3 authors, 1 resolved, mention dropdown open | index — hero carousel 2 (16:10.4); index — tab: Review (16:10) | Captured |
| **M5** | Interpretation record — statement, cited evidence, author, timestamp | index — differentiator row 2 (520×360); index — tab: Interpret (16:10) | Captured |
| **M6** | Provenance graph — dataset to interpretation, with a fork | platform — "The trail" (16:9) | Captured |
| **M7** | Evidence listing, 6 entries | platform — "The evidence" (16:9, alternate to M3) | Captured |
| **M8** | Stakeholder view — Daniel Reiss's external session (published artifacts) | index — use-case teaser 1, dark (2.4:1, crop, optional change-feed inset); use-cases — hero (16:10.4) | Captured |
| **M9** | Co-branded sponsor export — provenance stamp | index — differentiator row 1 (520×360) | Captured |
| **M10** | Subject delta view (paired T1/T2) | index — use-case teaser 2, dark (2.4:1, crop) | Captured |
| **M11** | Dataset header — RNA-Seq DE schema badge + declare action | **No slot assigned yet** — OQ3 open (site-side decision, does not gate staging) | Captured, unplaced |
| **M12** | Flow cytometry population-frequency master | **No slot assigned** — OQ4 open (no flow-cytometry data exists; producing it is out of `SI-044` scope) | Blocked, not captured |

Non-master slots (not produced by this toolkit — illustration/photo, out of
`SI-044`'s scope, listed here only so the 19-slot map is traceable in full):
index use-case teaser 3 (dark) = **S1** schematic (two centres, finding
crosses, data stays); index tab: Deploy = **S2** schematic (deploys into
your infrastructure); about founder portrait (1:1) = **P1** photo.

### 6.3 Intended Confluence page structure

- **Title:** `Website Screenshot Staging — Captured Masters (AXI-1383)`
- **Parent:** `274857986`
- **One section per captured master (M1–M11)**, each containing:
  - Heading: `M<n> — <title>`
  - The slot(s) it serves, as prose (from the table in §6.2)
  - The image, embedded from `capture/masters/M<n>.png` (attached to the page
    at publish time — the PNGs are gitignored build output, not committed to
    the repo, so they must be attached fresh from whatever machine runs the
    publish, using the files most recently produced by `npm run capture`)
  - A one-line caption-discipline note where the spec calls for one (e.g. M8:
    "your sponsor sees the finding and its traceability, not your working
    files" — true; do not caption as full cross-org data sharing, §12–13)
- **One closing section:** "Not yet placed" — M11 (OQ3) and M12 (OQ4,
  blocked), with the reasons above, so the page is honest about what's
  outstanding rather than silently omitting them.

### 6.4 The exact publish command (NOT run)

Two ways to execute this once approved — a REST call using the same
Atlassian credentials the Jira scripts already use (`axiome-global/.env`,
loaded by `scripts/jira/*.py` via `JIRA_URL`/`JIRA_EMAIL`/`JIRA_TOKEN`), or
the `mcp__claude_ai_Atlassian__createConfluencePage` tool. Both are
documented here as ready-to-run; **neither has been invoked.**

**Option A — direct REST call** (`POST /wiki/api/v2/pages`, Confluence Cloud
v2 API, same auth as `get_confluence_page.py`):

```bash
curl -X POST "${JIRA_URL}/wiki/api/v2/pages" \
  -u "${JIRA_EMAIL}:${JIRA_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "spaceId": "31490052",
    "status": "current",
    "title": "Website Screenshot Staging — Captured Masters (AXI-1383)",
    "parentId": "274857986",
    "body": {
      "representation": "storage",
      "value": "<page HTML per §6.3 — one section per master, images attached via a follow-up POST /wiki/api/v2/pages/{id}/attachments call per PNG>"
    }
  }'
```

**Option B — MCP tool** (equivalent, once the `claude.ai Atlassian`
connector is authorized in an interactive session):

```
mcp__claude_ai_Atlassian__createConfluencePage(
  spaceId: "31490052",
  parentId: "274857986",
  title: "Website Screenshot Staging — Captured Masters (AXI-1383)",
  body: <same structure as §6.3>
)
```

Images are not inline in either call's JSON body — attach each
`capture/masters/M<n>.png` via a follow-up attachment call
(`POST /wiki/api/v2/pages/{id}/attachments`, multipart) after the page
exists, then reference the attachment in the body content. This two-step
shape (create page, then attach files) is standard for the Confluence v2
API and is why the page body above is a placeholder rather than embedded
image bytes.

**Founder approval gate:** run neither of the above until the founder
explicitly signs off on this plan (page structure, title, and — importantly
— the "Not yet placed" section's honesty about M11/M12) at Workflow 5.

---

## 7 · Cross-references

- Dev Epic Context: `axiome-docs/05 - product/dev-epic-context/AXI-1368-Website-Screenshot-Staging.md`
  — "OPERATIONAL PHASE — DONE" section is the source for §3 above; per-story
  learnings log has the full provenance for every ID/finding cited here.
- Feature doc: `axiome-docs/05 - product/features/BACKLOG-Website-Screenshot-Staging.md`
  — FR21/FR22/AC18/AC19 (this runbook's covered requirements), FR18/FR19
  (verify/capture themselves).
- Capture Spec: Confluence page `274857986` — §16 (masters), §17 (slot map),
  §18 (capture rules), §19 (things that must not ship — `capture/doNotShip.ts`
  is the mechanical check for this).
- Programmatic-usage guide (FR20/AC17, the toolkit's REST reference
  implementation): `docs/REST-API-Guide.md`.
- `capture/README.md` — the capture harness's own operating notes (how to add
  a master, output shape).

# CI integration & merge gating

The suite's CI (`.github/workflows/ci.yml`) has two jobs (AXI-1267).

## `checks` — every push and PR (FR22, AC12)

Stack-independent gates that never need a running platform, so they gate every
push and pull request to `main` deterministically:

- `npm run typecheck` — `tsc --noEmit`
- `npm run lint:specs` — the spec-convention linter (AC-ID titles, no sleeps, semantic selectors)
- `npm run coverage` — the AC-ID → spec map; **fails on any gap or orphan** (FR21)

## `e2e` — the browser suite (FR23, AC13, AC14)

The browser suite needs a reachable Axiome stack. It runs when a deployed target
is configured (`vars.BASE_URL`) or on demand (`workflow_dispatch` /
`repository_dispatch`). Retargeting is env-only (AXI-1262): set repo/environment
variables `BASE_URL`, `API_BASE_URL`, `OBJECT_PUBLIC_URL` and secrets
`E2E_ADMIN_*` / `E2E_USER_*`. The fail-closed preflight (AXI-1263) aborts with
exit **78** if the target is down — an environment fault, not a test failure (FR28).

Every run uploads the HTML report, JUnit XML, and failure traces/screenshots/
videos as artifacts, retained 30 days (FR26/FR27, AC14) — detailed by AXI-1268.

## Cross-repo trigger from a service-repo PR (FR23/FR24)

A service repo (`axiome-front` / `axiome-back` / `axiome-bio-compute`) fires the
suite's `repository_dispatch` and reports the result back as a check on its PR.
Add this to the service repo's PR workflow (needs a PAT with `repo` scope on
`axiome-e2e-testing` in the `E2E_DISPATCH_TOKEN` secret):

```yaml
  trigger-e2e:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger the relevant E2E subset
        run: |
          curl -sf -X POST \
            -H "Authorization: token ${{ secrets.E2E_DISPATCH_TOKEN }}" \
            -H "Accept: application/vnd.github+json" \
            https://api.github.com/repos/fmguimaraes/axiome-e2e-testing/dispatches \
            -d '{"event_type":"e2e-subset","client_payload":{"filter":"tests/${{ env.EPIC_KEY }}/"}}'
```

## `pr` governance interaction (FR24/FR25)

- **`pr: true`** — a red suite check blocks the merge exactly like a red unit-CI
  check (FR24). The `checks` job always votes; the `e2e` job votes when a target
  is configured.
- **`pr: false`** (current `config/sdlc.json`) — no PR exists, so the merge-gate
  trigger is dormant; the Workflow 4 step **g** headless run stands in as the
  pre-merge gate (FR25). CI still runs post-merge on push to `main` as a
  regression signal.

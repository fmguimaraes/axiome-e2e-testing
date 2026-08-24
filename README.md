# axiome-e2e-testing

Machine-verified end-to-end Playwright suite for the Axiome platform — front,
back, and bio-compute exercised through a real browser. This is the executable
counterpart to the Given/When/Then scenario library in
[`axiome-docs/manual-e2e/`](https://github.com/fmguimaraes/axiome-docs/tree/main/manual-e2e):
every automated test implements a `automation: playwright` scenario and its
`test()` title leads with the acceptance-criterion IDs it verifies.

Requirement source: `axiome-docs/05 - product/features/IN-PROGRESS-Automated-E2E-Testing.md`
(epic **AXI-1260**). Process doctrine: `axiome-docs/SDLC.md` — E2E Testing Strategy.

## Install (from a clean clone)

```bash
npm ci                      # or: npm install
npm run install:browsers    # installs the Chromium browser Playwright drives
```

## Run

The suite targets the local `make local-up` stack by default. Bring the stack up
first (`cd axiome-infra && make local-up`), then:

```bash
npm test                                   # full suite
npx playwright test tests/AXI-1260/        # a single epic, by path filter
npx playwright test tests/AXI-1260/AXI-1261-*   # a single story, by path filter
```

No configuration edit is needed to scope a run — the `tests/<EPIC-KEY>/` layout
plus a path filter is the whole mechanism.

Headed / debug (no config change):

```bash
npm run test:headed
npm run test:debug
npm run test:ui
npx playwright show-report      # open the last HTML report
```

## Environment targeting

Origins are read from environment variables and default to the local stack, so
the same suite runs locally, in CI, and against a deployed environment by
changing only these values — no spec, selector, or config edit:

| Variable | Default | Purpose |
|----------|---------|---------|
| `BASE_URL` | `http://localhost:5173` | front-end origin the browser drives |
| `API_BASE_URL` | `http://localhost:3000` | backend API (setup/teardown, API-only specs) |
| `OBJECT_PUBLIC_URL` | `http://localhost:9000` | public, browser-reachable object storage (MinIO/S3) |
| `METABASE_BASE_URL` | `http://localhost:3001` | Behavior Tracking read layer (AXI-1048); the `make analytics-up` overlay. Read-layer specs skip when it is unreachable. |

The Behavior Tracking read-layer round-trip (`tests/AXI-1043/`) additionally
reads back through Metabase's query API; it skips unless a Metabase admin is
supplied via `METABASE_USER` / `METABASE_PASSWORD` (optionally `METABASE_DATABASE_ID`).

Copy `.env.example` to `.env` to override locally. **Never commit a secret** —
role credentials are supplied at run time (env vars or the platform secret store).

## Layout

```
config/env.ts                 environment resolution facade (one seam)
playwright.config.ts          shared root config — stories add specs, never fork this
tests/<EPIC-KEY>/             one folder per epic
  <story-key>-<slug>.spec.ts  a story's specs (Workflow 4 step e)
  epic-<slug>.spec.ts         cross-story flows (Workflow 5 step 3)
```

Adding a story's specs never requires editing shared configuration — the layout
convention alone makes them discoverable and runnable.

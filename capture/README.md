# capture/

The deterministic Playwright capture harness (FR19/AC14/AC15, AXI-1381, `SI-044`).
Turns the tenant `staging/**` provisions into the twelve publication masters
M1-M12.

## Run it

```bash
# stack must be up (make local-up) and the tenant staged (npm run stage)
npm run capture
```

Env vars (all optional, defaults target the local stack):

| Variable | Default | Purpose |
|---|---|---|
| `CAPTURE_FRONTEND_URL` | `http://localhost:5173` | the browser origin masters navigate |
| `STAGING_BASE_URL` | `http://localhost:3000` | the gateway origin (also the `verify` gate's target) |
| `STAGING_ADMIN_EMAIL` / `STAGING_ADMIN_PASSWORD` | `admin@axiome.local` / `admin` | bootstrap admin, same as `stage`/`verify` |

## What it does, in order

1. **FR18 gate** — runs `staging/verify`'s rule set in-process and aborts
   (non-zero exit, no browser launched) if any rule fails. Capture never
   runs against an inconsistent tenant.
2. **`resolveCaptureContext.ts`** — re-derives every live id a master needs
   (workspace/project/analysis/dataset/chart/snapshot/decision/evidence/
   published-version ids) over REST, by name — the same pattern
   `staging/verify/deps.ts` uses. Nothing here is a hard-coded id from a
   past staging run.
3. **`runCapture.ts`** launches ONE fixed Playwright configuration
   (`config.ts`: 2400px viewport width, 1500px height, 2x device scale
   factor, light theme — identical across every master, FR19/AC14) and
   runs each master in `masters/index.ts`'s `MASTERS` registry in order.
4. Each master asserts its own precondition (in code, unit-tested) before
   the shutter. A precondition that does not hold makes that ONE master
   **blocked** (reason logged) — the run continues to the next master
   rather than aborting, and rather than shipping a wrong/fabricated frame.
5. A shared AC15 check (`doNotShip.ts`) scans every captured frame's
   rendered text for Capture Spec §19 do-not-ship markers before the
   shutter — defense in depth on top of "only navigate sanctioned routes".

## Output

- `capture/masters/M<n>.png` — one PNG per captured master, at
  4800x3000px (2400x1500 logical viewport, exported at 2x DPR).
- `capture/masters/summary.json` — machine-readable run result (status +
  detail per master), written every run for the next reader (AXI-1383).

## Adding/changing a master

Each master lives in its own `capture/masters/m<n><Slug>.ts` file:
export a pure `assertPrecondition`-shaped function (unit-testable without
a browser) and an impure `captureM<n>(page, baseUrl, ctx)` that navigates,
asserts, and calls the shared `shutter()` helper from `common.ts`. Register
it in `masters/index.ts`'s `MASTERS` array. Never hand-roll a screenshot
call outside `shutter()` — that is the one place the fixed viewport/DPR/
AC15 scan is enforced.

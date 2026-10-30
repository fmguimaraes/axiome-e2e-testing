# AXI-2333 — IgG4 strip-plot debug & fix — verification evidence

Epic AXI-2308 (Platform Opening: Human Guided). Scope: reproduce/fix the
live strip-plot failure reported against Paul's (CeRAINOM-IgG4) real header,
root-cause it, fix it, lock it with tests. Investigation was read-only
against the CeRAINOM-IgG4 org (never written to); this fixture reproduces
the same DEFECT CLASS on a throwaway dataset instead.

## Root cause

`resolveGroupOrder` (`axiome-front/src/lib/charts/builders/shared.ts`,
reused by `resolveFacetOrder` in `facetedStrip.builders.ts`) matched a
curated `group_order`/`facet_order` name against a raw group/facet value
with **exact string equality**. A real spreadsheet header can carry
incidental whitespace variance a curator's typed name never does (a merged
Excel cell, a trailing blank) — e.g. the raw column holds `"HD  "` (trailing
double space) while the curated spec declares `"HD"`. Exact-equality
matching never binds the two, so the named group silently falls to the
unmatched/fallback position instead of the declared one. The RAW value is
still what's rendered either way — only the match was wrong. Mirrored
byte-for-byte in `axiome-back`'s `pdf-render.service.ts`
(`resolveGroupOrderBack`/`groupOrderMatchKeyBack`), per the existing
AXI-2242 front/back port convention.

## Before/after screenshots (same backend `:3000`, same fresh throwaway
tenant+dataset+candidate spec, same declared `group_order: ["HD","IgG4-RD","SD"]`)

- `before-unfixed-group-order.png` — demo stack's currently-served
  `axiome-front` build (pre-fix `main`, container `axiome-demo-frontend`,
  port 5173). X-axis renders `IgG4-RD, SD, HD` — the declared `HD` position
  is NOT honoured; the whitespace-carrying raw value falls to the end.
- `after-fixed-group-order.png` — this story's worktree build
  (`axiome-front-AXI-2333-igg4-strip-plot`, built with `vite build` and
  served statically on port 5180 against the SAME shared backend). X-axis
  renders `HD, IgG4-RD, SD` — the declared order is honoured, and the raw
  value (`"HD  "`, trailing whitespace) is still what's plotted/labelled.

Both screenshots point at the same dataset/candidate spec
(`2b129c7e-46a0-4f64-ab8c-c10f168b8d6c` / `7129d573-ac65-47c7-b13f-98d619e72770`,
throwaway "AXI-2333 evidence org", deleted after capture), isolating the
frontend build as the only variable.

## Automated test evidence

- Unit — front: `src/lib/charts/builders/shared.test.ts` UT-FB-146/147/148,
  `npx vitest run` → full charts/builders suite green (no regressions).
- Unit — back: `apps/organization-service/src/exports/pdf-render.service.spec.ts`
  UT-PDFR-099, `npx jest` (with `AXIOME_DOCS_ROOT` set) → full exports suite
  green (no regressions).
- E2E: `tests/AXI-2308/AXI-2333-igg4-strip-plot.spec.ts` — 2/2 passed,
  `npx playwright test tests/AXI-2308/AXI-2333-igg4-strip-plot.spec.ts
  --project=chromium --no-deps`, run against the fixed worktree build
  (port 5180) and the shared backend (port 3000). The spec creates its own
  throwaway org/workspace/project/dataset/candidate (never the real
  CeRAINOM-IgG4 org) and deletes the candidate in `afterAll`.

## Scope note (out of this story)

Both the live demo stack and this evidence run surface an unrelated
pre-existing 404 from `GET /api/v1/derived-evidence?projectId=&...` on the
chart page (an empty `projectId` query param) — a derived-evidence/
interpretations sidebar lookup, not the strip-plot render path, and not a
regression from this fix (observed identically on both the pre-fix and
post-fix builds). Not in AXI-2333's scope; flagged for a separate ticket if
not already tracked.

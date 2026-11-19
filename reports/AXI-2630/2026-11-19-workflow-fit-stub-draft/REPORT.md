# AXI-2673 opening-templates/match stub-draft regression guard — run against w5val

Verdict: **FAIL (pre-fix behaviour reproduced)** — infra, not a spec defect.

Spec: `tests/AXI-2630/AXI-2673-workflow-fit-stub-draft.spec.ts`
Command:
```
BASE_URL=http://localhost:5174 API_BASE_URL=http://localhost:3001 \
GUIDED_ANALYSIS_LLM_TRANSPORT=recorded \
E2E_ADMIN_EMAIL=admin@cro-one.com E2E_ADMIN_PASSWORD=admin \
E2E_INVESTIGATOR_EMAIL=*** E2E_INVESTIGATOR_PASSWORD=*** \
HANDOVER_WORKSPACE_ID=1eebb49b-a1f6-4e69-b880-20d0e7d1f739 \
npx playwright test tests/AXI-2630/AXI-2673-workflow-fit-stub-draft.spec.ts --project=chromium --no-deps
```

## Result

1 failed. Login, project creation, protocol, draft creation, variable declaration, Q1
planning (T2) and Q2's stub addition all succeeded. The `match` call against
`dataset.datasetId = "spec:<sapId>:draft"` returned:

```json
{"success":false,"statusCode":404,"message":"SAP not found","error":"Not Found","path":"/api/v1/guided-analysis/opening-templates/match"}
```

— the exact pre-fix defect AXI-2673 describes, reproduced live.

## Root cause

`axiome-w5val-backend` serves from `_worktrees/axiome-back-AXI-2433-validation`
(confirmed via `docker inspect` bind mount), whose `HEAD` is `1f304a33` (AXI-2669 merge).
`git merge-base --is-ancestor c8b0d873fb03b13d1888b203bb772663b3388926 HEAD` on that
checkout returns false: **the AXI-2673 fix commit is not in the history the w5val stack
is currently running.** PR #99 (branch `AXI-2673-spec-schema-draft-stub`) is still open/
unmerged, so this is expected, not a flaw in the guard — the spec correctly reproduces the
"stuck disabled, Could not check which workflows fit your variables" defect against any
backend that does not carry the fix, which is exactly the regression behaviour it exists
to catch.

## Conclusion

The guard is validated as a true regression test (it reliably reproduces the exact
pre-fix 404 against live, unfixed code) but cannot be reported `e2e-pass` until the
backend the stack serves actually includes commit `c8b0d873` (e.g. once PR #99 merges to
`main` and the w5val backend worktree/stack is updated to it, or a worktree already on
the fix is pointed at by the stack). Re-run the exact command above once that is true;
expect `200` + 4 templates + at least one `eligible: true`.

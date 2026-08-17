# Workflow 4 integration

How the suite plugs into the Workflow 4 story lifecycle (SSoT doctrine:
`axiome-docs/SDLC.md` — E2E Testing Strategy, and `workflow-4-implementation.md`).
This repo provides the *mechanism*; the feature doc (FR29–FR33) is the requirement.

| Step | What happens | Requirement |
|------|--------------|-------------|
| **c — Design** | The design note records the **E2E contract**: routes, `data-testid`s / ARIA roles, API response shapes the scenarios will target. | FR29 |
| **d — Scenarios** | The tagged scenario file is written/updated under `axiome-docs/manual-e2e/<EPIC>-<Feature>.md` — `automation:` + `_ACs:_`. **No runnable spec yet.** | FR30 |
| **e — Develop + automate** | The spec is authored against the *running* slice (selectors from the rendered DOM), under `tests/<EPIC>/<story>-<slug>.spec.ts`, titles leading with AC IDs. | FR31 |
| **g — Testing** | Run `npm run story-gate <EPIC> <STORY>`. The label is derived from the **exit code**, never asserted. | FR32/FR33, AC15/AC16 |

## Step g — `story-gate`

```bash
npm run story-gate AXI-1260 AXI-1269
# runs: npx playwright test tests/AXI-1260/AXI-1269-*
```

It maps the run's exit code to a label and prints the Jira comment:

| Exit code | Label | Meaning |
|-----------|-------|---------|
| `0` | `e2e-pass` | all specs green |
| `78` | `infra-fault` | preflight aborted (stack down / seed missing) — an **environment fault, not a defect**; fix the environment and re-run, do **not** route to rework (FR28) |
| other | `e2e-fail` | at least one spec failed |

Because the label is a pure function of the exit code (`deriveLabel`), a story
with a `playwright`-tagged scenario **cannot reach `e2e-pass` on an asserted
claim** (AC16). The orchestrator applies the printed label/comment to Jira via
`scripts/jira/add_labels.py` / `add_comment.py` — this repo holds no Jira
credentials, so the gate stays credential-free.

#!/usr/bin/env bash
# AXI-2601 (epic AXI-2598 — FR9, NFR1, FR31, EC20) — run the handover rehearsal against the local
# demo stack in one command. Records the commit each service checkout serves and whether it equals
# origin/main, then runs the API-only `handover-api` project headless.
#
# Required env: E2E_INVESTIGATOR_PASSWORD. Optional: HANDOVER_PROVISIONER_EMAIL/_PASSWORD (without
# them the provisioning step is blocked), HANDOVER_FRONT_DIR / _BACK_DIR / _COMPUTE_DIR (the
# checkouts the stack serves), BASE_URL, API_BASE_URL, HANDOVER_WORKSPACE_ID.
# Never prints a credential.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
root="${AXIOME_ROOT:-$(cd "$repo/../.." && pwd)}"
front_dir="${HANDOVER_FRONT_DIR:-$root/_worktrees/axiome-front-AXI-2433-validation}"
back_dir="${HANDOVER_BACK_DIR:-$root/_worktrees/axiome-back-AXI-2433-validation}"
compute_dir="${HANDOVER_COMPUTE_DIR:-$root/axiome-global/axiome-bio-compute}"

sha() { git -C "$1" rev-parse --short HEAD 2>/dev/null || echo ""; }
on_main() {
  local head main
  head="$(git -C "$1" rev-parse HEAD 2>/dev/null)" || return 1
  main="$(git -C "$1" rev-parse origin/main 2>/dev/null)" || return 1
  [ "$head" = "$main" ]
}

front="$(sha "$front_dir")"; back="$(sha "$back_dir")"; compute="$(sha "$compute_dir")"
if [ -n "$front" ] && [ -n "$back" ] && [ -n "$compute" ]; then
  export HANDOVER_COMMITS="front=$front,back=$back,compute=$compute"
fi
all_main=true
for d in "$front_dir" "$back_dir" "$compute_dir"; do on_main "$d" || all_main=false; done
export HANDOVER_COMMITS_ON_MAIN="$all_main"
export BASE_URL="${BASE_URL:-http://localhost:5174}"
export API_BASE_URL="${API_BASE_URL:-http://localhost:3001}"
export HANDOVER_WORKSPACE_ID="${HANDOVER_WORKSPACE_ID:-1eebb49b-a1f6-4e69-b880-20d0e7d1f739}"
export HANDOVER_TARGET_LABEL="${HANDOVER_TARGET_LABEL:-local demo stack}"
echo "[AXI-2601] target $API_BASE_URL workspace $HANDOVER_WORKSPACE_ID; commits ${HANDOVER_COMMITS:-NOT RECORDED}; on main: $all_main"
cd "$repo"
exec npx playwright test --project=handover-api tests/AXI-2598/AXI-2601- "$@"

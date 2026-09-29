#!/usr/bin/env bash
set -euo pipefail

mapfile -t workspaces < <(ls -dt "${TMPDIR:-/tmp}"/pi-pstack-migration.* 2>/dev/null || true)
for workspace in "${workspaces[@]}"; do
  profile="$workspace/profile"
  if [[ -f "$profile/settings.json" && -d "$workspace/pi-pstack" && -d "$workspace/pi-subagents" ]]; then
    cd "$workspace"
    PI_CODING_AGENT_DIR="$profile" exec pi
  fi
done

printf 'No test installation found. Run on-computer.sh first.\n' >&2
exit 1

#!/usr/bin/env bash
set -euo pipefail

while IFS= read -r workspace; do
  profile="$workspace/profile"
  if [[ -f "$profile/settings.json" && -d "$workspace/pi-pstack" && -d "$workspace/pi-subagents" ]]; then
    cd "$workspace"
    PI_CODING_AGENT_DIR="$profile" exec pi
  fi
done < <(ls -dt "${TMPDIR:-/tmp}"/pi-pstack-migration.* 2>/dev/null || true)

printf 'No test installation found. Run on-computer.sh first.\n' >&2
exit 1

#!/usr/bin/env bash
set -euo pipefail

workspace=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
profile="$workspace/profile"
if [[ ! -f "$profile/settings.json" || ! -d "$workspace/pi-pstack" || ! -d "$workspace/pi-subagents" ]]; then
  printf 'Copy this script into the test workspace created by on-computer.sh.\n' >&2
  exit 1
fi

cd "$workspace"
PI_CODING_AGENT_DIR="$profile" exec pi

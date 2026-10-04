#!/usr/bin/env bash
set -euo pipefail

if (( $# < 3 || $# > 4 )); then
  printf 'Usage: %s <ssh-host> <provider> <model> [provider-package-path]\n' "$0" >&2
  exit 2
fi

remote=$1
provider=$2
model=$3
provider_package=${4:-}
workspace=$(mktemp -d "${TMPDIR:-/tmp}/pi-pstack-migration.XXXXXX")
profile="$workspace/profile"
mkdir "$profile"

ssh "$remote" 'set -eu
  cd "$HOME/projects/pi-pstack-subagents-migration"
  transfer=$(mktemp -d)
  trap '\''rm -rf "$transfer"'\'' EXIT
  git -C pi-pstack bundle create "$transfer/pi-pstack.bundle" migration/tintinweb-subagents
  git -C pi-subagents bundle create "$transfer/pi-subagents.bundle" migration/pstack-package-agents
  tar -C "$transfer" -cf - pi-pstack.bundle pi-subagents.bundle
' | tar -C "$workspace" -xf -

git clone -q -b migration/tintinweb-subagents "$workspace/pi-pstack.bundle" "$workspace/pi-pstack"
git clone -q -b migration/pstack-package-agents "$workspace/pi-subagents.bundle" "$workspace/pi-subagents"
npm ci --prefix "$workspace/pi-subagents"

if [[ ! -f "$HOME/.pi/agent/auth.json" ]]; then
  printf 'Missing %s/.pi/agent/auth.json\n' "$HOME" >&2
  exit 1
fi
cp "$HOME/.pi/agent/auth.json" "$profile/auth.json"
if [[ -f "$HOME/.pi/agent/models.json" ]]; then
  cp "$HOME/.pi/agent/models.json" "$profile/models.json"
fi
if [[ "$provider" == commandcode ]]; then
  provider_package=${provider_package:-"$HOME/.pi/agent/npm/node_modules/pi-commandcode-provider"}
  if [[ ! -f "$provider_package/package.json" || ! -f "$HOME/.pi/agent/commandcode-models.json" ]]; then
    printf 'Commandcode provider or model catalog is missing. Pass its package path as the fourth argument.\n' >&2
    exit 1
  fi
  cp "$HOME/.pi/agent/commandcode-models.json" "$profile/commandcode-models.json"
fi
if [[ -n "$provider_package" && ! -f "$provider_package/package.json" ]]; then
  printf 'Provider package not found: %s\n' "$provider_package" >&2
  exit 1
fi

node - "$workspace" "$profile" "$provider_package" <<'NODE'
const fs = require('node:fs');
const [workspace, profile, providerPackage] = process.argv.slice(2);
const packages = [
  ...(providerPackage ? [{ source: providerPackage }] : []),
  { source: `${workspace}/pi-subagents` },
  { source: `${workspace}/pi-pstack`, extensions: ["extensions/pstack/index.ts"] },
];
fs.writeFileSync(`${profile}/settings.json`, JSON.stringify({ packages }));
NODE

printf '\nCheck that both packages come from %s:\n' "$workspace"
(cd "$workspace" && PI_CODING_AGENT_DIR="$profile" pi list)
printf '\nInside Pi, send /poteto-mode. Then send:\n'
printf 'Use the subagent tool with agent poteto-agent to read pi-pstack/package.json, run bash sleep 12, and report only the package name. Do not call Agent.\n'
printf 'Test files: %s\nProfile: %s\n' "$workspace" "$profile"
printf 'After testing, remove the test files with: rm -rf %q\n\n' "$workspace"
cd "$workspace"
PI_CODING_AGENT_DIR="$profile" pi --provider "$provider" --model "$model"

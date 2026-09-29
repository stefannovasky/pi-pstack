# How to run the pi-subagents migration

This migration moves `pi-pstack` delegation off its private child-process runner and onto the `tintinweb/pi-subagents` extension RPC. Two checkouts are involved. Neither is pushed. No user Pi configuration is changed by these steps.

## Layout

```text
pi-pstack-subagents-migration/
├── pi-pstack/     branch migration/tintinweb-subagents
└── pi-subagents/  branch migration/pstack-package-agents
```

The `pi-subagents` branch adds RPC protocol 4. It carries spawn-local agent definitions, ordered messages on completion events, and per-message progress events. The `pi-pstack` branch replaces its subprocess runner with an adapter over that protocol. The model calls pstack's `subagent` tool; pstack sends `subagents:rpc:spawn` to tintinweb. Seeing `subagent` rather than tintinweb's model-facing `Agent` tool is expected.

## Requirements

- Pi CLI on `PATH`.
- Node 22 or newer.
- Both local checkouts on the branches named above.
- A working provider. The example uses the installed `pi-commandcode-provider`, `~/.pi/agent/auth.json`, and `~/.pi/agent/commandcode-models.json`. The test copies credentials and the catalog into a temporary profile and deletes that copy after the run.

## Run the reproducible integration test

The test drives a real `pi` process against a disposable profile. It reads authentication and provider files from your Pi directory but does not change your personal Pi settings.

```bash
cd pi-pstack-subagents-migration

PROFILE=$(mktemp -d)
cp ~/.pi/agent/auth.json "$PROFILE/auth.json"
cp ~/.pi/agent/commandcode-models.json "$PROFILE/commandcode-models.json"

PI_CODING_AGENT_DIR="$PROFILE" \
  PI_PROVIDER=commandcode \
  PI_MODEL=deepseek/deepseek-v4-pro \
  node pi-pstack/test/integration.mjs
```

The test asserts these behaviors:

- The bundled `poteto-agent` resolves without copying any file into a user or project agents directory.
- The result keeps ordered messages in `details.results[].messages`.
- A role configured with `provider/model:high` resolves the model and reports the child's effective thinking level as `high`.
- Parallel and chain modes return their expected ordering and status.
- Progress updates arrive before completion for child messages.
- A same-name project agent does not replace the bundled definition under the default scope.
- A task with another `cwd` loads that directory's project instructions and skills, not the parent's.
- A missing `pi-subagents` extension or a stale RPC protocol fails instead of running a substitute agent.
- A child bash call that looks external is blocked without interactive approval.

It prints one line on success and exits nonzero on any failure.

When you set a different `cwd` for a task, the child reads that directory's project instructions. It loads that directory's skills but not its extensions. Loading another project's extensions into the parent Pi process would execute that code without the isolation of the old standalone child.

## Run the upstream suite

```bash
cd pi-subagents
npm run typecheck
PI_CODING_AGENT_DIR=$(mktemp -d) npm test
```

The suite must show all tests passing. The temporary `PI_CODING_AGENT_DIR` stops the tests from reading your personal `subagents.json` settings.

## Try it interactively in an isolated profile

This starts a real Pi session with both local packages loaded as extensions, still without touching your personal settings.

```bash
cd pi-pstack-subagents-migration

PROFILE=$(mktemp -d)
cp ~/.pi/agent/auth.json "$PROFILE/auth.json"
cp ~/.pi/agent/commandcode-models.json "$PROFILE/commandcode-models.json"

PI_CODING_AGENT_DIR="$PROFILE" \
  pi \
  --provider commandcode \
  --model deepseek/deepseek-v4-pro \
  --extension "$HOME/.pi/agent/npm/node_modules/pi-commandcode-provider/index.ts" \
  --extension ./pi-subagents/src/index.ts \
  --extension ./pi-pstack/extensions/pstack/index.ts
```

The pstack workflow skills are present, but most are explicit-only. They do not appear in the model's automatic skill list. Enter `/skill:arena` to invoke that skill directly. Enter `/poteto-mode` to enable sticky Poteto Mode for the current Pi session. While enabled, Pi exposes pstack's `subagent` tool instead of pi-subagents' model-facing `Agent` tool. `/poteto-mode off` restores `Agent`. A fresh disposable profile starts with this mode off.

Then ask for a delegate:

```text
Use the subagent tool with agent poteto-agent to read pi-pstack/package.json and report only its package name. Do not call Agent.
```

Loading both with `--extension` proves the delegation path. It does not prove child-session guards, because explicit `--extension` flags are not automatically inherited by child sessions. The integration test covers that by loading both packages through the temporary profile's settings.

## Install locally for a fuller test

If you want a longer manual session where child sessions inherit both packages, register both local checkouts inside a disposable profile instead of your personal settings.

```bash
cd pi-pstack-subagents-migration

PROFILE=$(mktemp -d)
cp ~/.pi/agent/auth.json "$PROFILE/auth.json"
cp ~/.pi/agent/commandcode-models.json "$PROFILE/commandcode-models.json"

cat > "$PROFILE/settings.json" <<EOF
{
  "packages": [
    { "source": "$HOME/.pi/agent/npm/node_modules/pi-commandcode-provider" },
    { "source": "$PWD/pi-subagents" },
    { "source": "$PWD/pi-pstack" }
  ]
}
EOF

PI_CODING_AGENT_DIR="$PROFILE" pi --provider commandcode --model deepseek/deepseek-v4-pro
```

Before starting Pi, run `PI_CODING_AGENT_DIR="$PROFILE" pi list`. It must list the local paths ending in `pi-pstack` and `pi-subagents`. If it lists `git:github.com/kkgogogo17/pi-pstack` or `npm:@tintinweb/pi-subagents` instead, the disposable profile was not applied. An empty `PROFILE` variable also makes Pi fall back to your personal installation.

Your personal `~/.pi/agent/settings.json` is left alone. The profile under `/tmp` holds all changes. In Pi, enter `/poteto-mode` to enable the workflow, or `/skill:arena` to invoke a specific skill. Then use the `subagent` tool with agent `poteto-agent` and ask it to read `pi-pstack/package.json`. Exit with `/quit`. To remove the temporary profile and its copied credentials afterward, run `rm -rf "$PROFILE"` only while `PROFILE` still points to the directory you created with `mktemp -d`.

## Release notes

The `pi-subagents` changes are not released upstream. Until protocol 4 ships, `pi-pstack` requires the `migration/pstack-package-agents` branch. The adapter fails with a clear message when it sees an older or absent extension rather than running a different agent.

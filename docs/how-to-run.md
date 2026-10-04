# Run and test the pi-subagents integration

This guide is for contributors testing local `pi-pstack` and `pi-subagents` checkouts. It uses disposable Pi profiles without changing personal settings.

## Prepare the checkouts

Use this directory layout:

```text
workspace/
├── pi-pstack/
└── pi-subagents/
```

Requirements:

- Pi CLI on `PATH`.
- Node 22.20 or newer for the checked-in dependency lockfile and deterministic tests.
- A `pi-subagents` checkout with RPC protocol 4. The unmodified `0.19.0` release does not include the migration's RPC additions.
- Authentication for a model available in Pi, for the live integration test.

From the directory containing both checkouts, install their development dependencies:

```bash
npm ci --prefix pi-subagents
npm ci --prefix pi-pstack
```

## Run deterministic checks

These checks do not call a live model:

```bash
npm --prefix pi-pstack test
npm --prefix pi-pstack run typecheck

(
	PROFILE=$(mktemp -d)
	trap 'rm -rf "$PROFILE"' EXIT
	export PI_CODING_AGENT_DIR="$PROFILE"
	npm --prefix pi-subagents run check
	npm --prefix pi-subagents run test:e2e
	npm --prefix pi-subagents run build
)
```

The disposable profile prevents personal `subagents.json` settings from changing the upstream suite's agent registry. The consumer tests cover partial parallel failures, concurrency and result ordering, startup deadlines, cancellation, early replies, progress callback failures, listener and timer cleanup, relative working directories, and session-file lookup.

The upstream end-to-end suite uses scripted providers by default. Its live-provider tests remain skipped unless explicitly enabled.

## Run the live integration test

The test starts real Pi processes and calls a live model. It requires the adjacent `pi-subagents` checkout. Its package settings exclude pstack's bundled backend so it tests only the adjacent checkout. It accepts a built-in provider or the installed `pi-commandcode-provider`.

Set `PI_PROVIDER` and `PI_MODEL` to an authenticated model that Pi lists as available. For example:

```bash
(
	PROFILE=$(mktemp -d)
	trap 'rm -rf "$PROFILE"' EXIT
	cp "$HOME/.pi/agent/auth.json" "$PROFILE/auth.json"
	PI_CODING_AGENT_DIR="$PROFILE" \
		PI_PROVIDER=openai-codex \
		PI_MODEL=gpt-6-sol \
		node pi-pstack/test/integration.mjs
)
```

The test creates a second profile inside `PROFILE` and removes it in `finally`. The shell trap removes the outer profile and its copied credentials. Do not use your personal Pi directory as `PI_CODING_AGENT_DIR` for this test.

For Commandcode, set `PI_PROVIDER=commandcode` and an available model, such as `PI_MODEL=deepseek/deepseek-v4-pro`. The test reads the installed provider at `$HOME/.pi/agent/npm/node_modules/pi-commandcode-provider/index.ts` and copies `$HOME/.pi/agent/commandcode-models.json` into its test profile.

The live test checks bundled agent identity, ordered transcript messages, thinking-suffixed role selection, progress, parallel and chain modes, project-agent collisions, and relative child-cwd instructions and skills. It also checks that target-cwd extensions do not execute, missing or stale backends fail, installed child guards block an external-looking shell command, and Poteto Mode delegates through pstack's `subagent` tool to a widget-visible background agent.

A successful run prints a summary and exits with status zero. A provider error, missing tool call, or failed assertion makes it fail.

## Try Poteto Mode in a disposable profile

Install the local pstack package through profile settings so its extensions and skills also load in child sessions. It loads the pinned backend downloaded by `npm ci`, not the adjacent checkout. Passing extension entry-point files with `pi -e` alone does not verify child guards or install the bundled skills.

```bash
(
	PROFILE=$(mktemp -d)
	trap 'rm -rf "$PROFILE"' EXIT
	cp "$HOME/.pi/agent/auth.json" "$PROFILE/auth.json"
	PI_CODING_AGENT_DIR="$PROFILE" pi install "$PWD/pi-pstack"
	PI_CODING_AGENT_DIR="$PROFILE" pi list
	PI_CODING_AGENT_DIR="$PROFILE" pi --provider openai-codex --model gpt-6-sol
)
```

`pi list` must show the local pstack checkout path. If you use another provider, register its package and copy any required model catalog into this profile before starting Pi.

Inside Pi, enter `/poteto-mode`, then send:

```text
Use the subagent tool with agent poteto-agent to read pi-pstack/package.json and report only its package name. Do not call Agent.
```

Most pstack workflow skills are explicit-only. Invoke them with `/skill:arena` or `/skill:how`. While Poteto Mode is active, pstack hides the competing `Agent` tool but keeps the tintinweb RPC backend active. `/poteto-mode off` restores `Agent` if pstack disabled it. Exit with `/quit`.

The child runs in the same process. A different task `cwd` changes its project instructions and skills, but not the extensions loaded from the parent's configuration. This is not a process or security sandbox.

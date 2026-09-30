# pi-pstack

A Pi-native port of [pstack](https://github.com/cursor/plugins/tree/main/pstack). It includes all 44 upstream skills and their references, playbooks, and scripts, plus Pi implementations of `poteto-agent` and `comment-sicko`.

## Install

This migration requires the adjacent `tintinweb/pi-subagents` checkout on branch `migration/pstack-package-agents` until its RPC protocol 4 changes are released. Both local packages must be loaded in the same Pi session. Pi does not activate one package's extension when another package loads.

To test without changing your personal Pi settings, use a disposable `PI_CODING_AGENT_DIR` with authentication and run `node pi-pstack/test/integration.mjs` from the directory containing both checkouts. The test creates and removes its own child profile. It checks package loading through temporary settings as well as direct extension loading. Loading only with `pi -e` is insufficient to verify child-session guards because explicit extensions do not automatically load in child sessions.

For regular use, install and enable both local packages in Pi after reviewing them. Keep the `pi-subagents` checkout on the protocol 4 branch; an unmodified release does not support this adapter.

## Start

```text
/setup-pstack
/poteto-mode investigate and fix the retry regression, then verify it
/poteto-mode off
```

`/setup-pstack` is an extension command. It interactively maps pstack roles to models that Pi has configured and saves the result in `~/.pi/agent/pstack/models.json`.

`/poteto-mode` enables sticky Poteto Mode for the current Pi session and expands the bundled `poteto-mode` skill. `/poteto-mode off` disables it. Individual skills use Pi's standard form, for example `/skill:how` and `/skill:no-comments`.

## Pi subagents

The `subagent` tool delegates execution to `tintinweb/pi-subagents` through its versioned extension RPC. It supplies bundled agent definitions per run, so they do not need to be copied into a user or project agents directory. The tool requires protocol 4. A missing or older extension fails instead of running a different agent.

The availability ping has a three-second timeout. Each task has a 30-minute deadline that includes startup, queue wait, and execution. Cancellation and deadline expiry abort the child, including while its spawn reply is pending. The adapter removes its event listeners and timers when the task settles.

While the tool waits, tintinweb's Agents widget shows the child above the prompt. The tool call remains in the conversation, with the final text and ordered messages in its details.

Bundled agents:

- `poteto-agent` for pstack implementation and investigation delegates. It must read the full `poteto-mode` skill before working.
- `comment-sicko` for comment-only review.

The tool supports a single task, `tasks` for parallel work, and `chain` for sequential work with `{previous}` interpolation. It accepts `role` for the model configuration and `model` for a one-off `provider/model` override. It permits at most eight tasks and runs at most four concurrently.

It also honors Pi's subagent definition locations:

- `~/.pi/agent/agents/*.md` for user agents.
- `.pi/agents/*.md` for project agents, only with `agentScope: "project"` or `"both"`.

Bundled agents are the default. Project agents require interactive approval unless `confirmProjectAgents: false` is explicit.

## Safety and compatibility

This port deliberately removes Cursor-only setup and behavior:

| Cursor pstack behavior | Pi equivalent |
|---|---|
| `Task` and `subagent_type` | `subagent` tool and Markdown agent definitions |
| Cursor model slugs and rules | `/setup-pstack`, `pstack_config`, and Pi `provider/model` selectors |
| sticky `mode: true` | session-persisted `/poteto-mode` extension command |
| Cursor todo list | `pstack_todo` tool |
| Cursor transcript directories | `$PI_SESSION_FILE` and `pstack_sessions` |
| `/loop`, cloud-agent resume | explicit project watchers; pi-subagents runs local child sessions |
| Cursor Team Kit skills | capability detection and project-native verification tooling |

The extension requests confirmation for recognizable shell commands that push, alter pull requests, merge, deploy, mutate infrastructure, or recursively delete files. In non-interactive mode it blocks these commands. This is a guardrail, not a complete shell-security sandbox. Prompts also require explicit approval for all external or irreversible actions.

The upstream `watch-pr` and orchestration helper scripts are retained. Their runtime requirements remain project-specific. In particular, the script package uses Bun and GitHub workflows require `gh` authentication.

## License and provenance

Derived from Cursor's pstack, licensed under MIT. See [LICENSE](LICENSE).

# Install pi-pstack

This guide assumes you already use Pi and have a model provider configured.

## Check prerequisites

Use Pi 0.86.0 or newer, Node.js 22.20.0 or newer, and Git. Check your versions:

```bash
pi --version
node --version
git --version
```

Pi packages execute code on your computer. Review the [pstack fork](https://github.com/stefannovasky/pi-pstack) and its [pi-subagents backend](https://github.com/stefannovasky/pi-subagents) before installing.

## Remove a separately installed backend

Skip this step if you have not installed pi-subagents before.

Run `pi list` and find any pi-subagents entry. Remove it with `pi remove`, using the source shown in the list. For example, for the upstream npm package:

```bash
pi remove npm:@tintinweb/pi-subagents
```

If you registered a local checkout, remove that entry using its path instead. For a project-local installation, add `--local`. Disable any manually configured pi-subagents extension in `pi config` too.

Pstack includes its own backend. Loading another copy can cause duplicate tools and commands.

## Install the package

Run:

```bash
pi install git:github.com/stefannovasky/pi-pstack
```

Pi saves the package in your personal configuration, making it available across projects. The installation downloads the modified pi-subagents fork automatically. Pstack pins a compatible backend commit and declares both extensions in its package manifest. Do not install the backend separately.

No manual clone, build, or `npm install` is needed.

To install only for the current project, use this command instead:

```bash
pi install git:github.com/stefannovasky/pi-pstack --local
```

Pi loads project packages after you trust the project.

## Start using pstack

1. Restart Pi.
2. Run `/setup-pstack` and choose models from your configured providers.
3. Run `/poteto-mode` to enable Poteto Mode for the current session.
4. Give Pi a task.

Role choices are saved in `~/.pi/agent/pstack/models.json`. Delegated agents run locally and use your configured providers. Their model calls can incur provider charges.

To disable Poteto Mode, run `/poteto-mode off`. To use a skill directly, run a command such as `/skill:how`.

## Check the installation

Run `pi list` in your terminal. It should list `git:github.com/stefannovasky/pi-pstack`. The backend is a dependency, so it does not need a separate package entry.

Inside Pi, check that `/setup-pstack` and `/agents` are available. The first comes from pstack. The second comes from the included backend.

To check delegation, send this prompt inside Pi:

```text
Use the subagent tool with agent poteto-agent to report its current working directory. Do not modify files.
```

This check calls your model provider. The delegated agent should appear in the Agents widget and return its result.

If commands are missing, check that the package extensions are enabled in `pi config`, then restart Pi. If delegation reports a missing or incompatible backend, remove any separately installed pi-subagents copy and update pstack. The unmodified upstream `0.19.0` release does not provide the RPC protocol this integration needs.

## Update

Run:

```bash
pi update git:github.com/stefannovasky/pi-pstack
```

Restart Pi afterward. Updating pstack installs the backend commit selected by that version of pstack.

## Remove

Run:

```bash
pi remove git:github.com/stefannovasky/pi-pstack
```

For a project-local installation, add `--local`. Restart Pi afterward. Removing pstack also stops loading its included backend, unless you have another copy configured separately.

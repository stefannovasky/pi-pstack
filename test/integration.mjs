import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const upstream = resolve(root, "../pi-subagents/src/index.ts");
assert(process.env.PI_CODING_AGENT_DIR, "Set PI_CODING_AGENT_DIR to a disposable profile with authentication before running this test.");
assert(realpathSync(process.env.PI_CODING_AGENT_DIR).startsWith(`${realpathSync(tmpdir())}${sep}`), "The integration test only accepts a disposable profile under the temporary directory.");
assert(existsSync(upstream), "The adjacent pi-subagents checkout is required.");

const commandcodeExt = resolve(homedir(), ".pi/agent/npm/node_modules/pi-commandcode-provider/index.ts");
const commandcodeCatalog = resolve(homedir(), ".pi/agent/commandcode-models.json");
const hasCommandcode = existsSync(commandcodeExt) && existsSync(commandcodeCatalog);
const provider = process.env.PI_PROVIDER || (hasCommandcode ? "commandcode" : undefined);
const model = process.env.PI_MODEL || (hasCommandcode ? "deepseek/deepseek-v4-pro" : undefined);
assert(provider && model, "Set PI_PROVIDER and PI_MODEL to an authenticated model available in Pi, or install the Commandcode provider and catalog.");

const profile = mkdtempSync(join(process.env.PI_CODING_AGENT_DIR, "integration-"));

function invoke(prompt, extensions = [upstream, resolve(root, "extensions/pstack/index.ts")], cwd = root, raw = false) {
  const modelArgs = provider && model ? ["--provider", provider, "--model", model] : [];
  const providerArgs = provider === "commandcode" ? ["--extension", commandcodeExt] : [];
  const run = spawnSync("pi", [...modelArgs, "--no-session", "--mode", "json", ...providerArgs, ...extensions.flatMap((extension) => ["--extension", extension]), "--print", prompt], {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: profile },
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.error?.message || run.stderr.slice(-1000));
  const events = run.stdout.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  return events.filter((event) => event.toolName === "subagent" && (raw || event.type === "tool_execution_end"));
}

try {
  copyFileSync(join(process.env.PI_CODING_AGENT_DIR, "auth.json"), join(profile, "auth.json"));
  if (provider === "commandcode") copyFileSync(commandcodeCatalog, join(profile, "commandcode-models.json"));

  const single = invoke('Call subagent with agent poteto-agent and task "Read package.json and answer only its package name." Do not call Agent.');
  assert.equal(single.length, 1);
  assert.equal(single[0].result.content[0].text, "pi-pstack");
  assert.equal(single[0].result.details.results[0].source, "bundled");
  assert(single[0].result.details.results[0].messages.some((message) => message.role === "toolResult"));

  mkdirSync(join(profile, "pstack"), { recursive: true });
  writeFileSync(join(profile, "pstack/models.json"), JSON.stringify({ version: 1, roles: { "bug-fix": `${provider}/${model}:high` } }));
  const selectedEvents = invoke('Call subagent with agent poteto-agent, role "bug-fix", and task "Say exactly OK." Do not call Agent.', undefined, root, true);
  const selected = selectedEvents.filter((event) => event.type === "tool_execution_end");
  assert.equal(selected.length, 1);
  assert.equal(selected[0].isError, false, selected[0].result.content[0].text);
  assert.equal(selected[0].result.details.results[0].exitCode, 0);
  assert.equal(selected[0].result.details.results[0].model, `${provider}/${model}:high`);
  assert.equal(selected[0].result.details.results[0].thinkingLevel, "high");
  assert(selectedEvents.some((event) => event.type === "tool_execution_update" && event.partialResult?.details?.results?.[0]?.messages?.length), "Expected child message progress before completion.");

  const modes = invoke('Call subagent with tasks [{"agent":"poteto-agent","task":"Read package.json and answer only pi-pstack"},{"agent":"poteto-agent","task":"Read agents/poteto-agent.md and answer only poteto-agent"}]. Then call subagent with chain [{"agent":"poteto-agent","task":"Say only pi-pstack"},{"agent":"poteto-agent","task":"Echo exactly this: {previous}"}]. Do not call Agent.');
  assert.deepEqual(modes.map((event) => event.result.details.mode), ["parallel", "chain"]);
  assert.deepEqual(modes[0].result.details.results.map((result) => result.exitCode), [0, 0]);
  assert.equal(modes[1].result.content[0].text, "pi-pstack");

  const project = mkdtempSync(join(profile, "project-"));
  mkdirSync(join(project, ".pi/agents"), { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "bundled-wins" }));
  writeFileSync(join(project, ".pi/agents/poteto-agent.md"), "---\nname: poteto-agent\ndescription: Shadow agent\n---\nRespond SHADOW without using tools.\n");
  const collision = invoke('Call subagent with agent poteto-agent and task "Read package.json and answer only the name field." Do not call Agent.', undefined, project);
  assert.equal(collision.length, 1);
  assert.equal(collision[0].result.details.results[0].source, "bundled");
  assert.match(collision[0].result.content[0].text, /bundled-wins/);
  const unapproved = invoke('Call subagent exactly once with agent poteto-agent, agentScope "project", and task "Say OK". Do not set confirmProjectAgents to false. Do not call Agent.', undefined, project);
  assert.equal(unapproved.length, 1);
  assert.equal(unapproved[0].isError, true);
  assert.match(unapproved[0].result.content[0].text, /Project-local agents require confirmation/);

  const parentContext = mkdtempSync(join(profile, "parent-"));
  const childContext = mkdtempSync(join(profile, "child-"));
  writeFileSync(join(parentContext, "AGENTS.md"), "PARENT_CONTEXT_MARKER\n");
  writeFileSync(join(childContext, "AGENTS.md"), "CHILD_CONTEXT_MARKER\n");
  mkdirSync(join(childContext, ".pi/skills/child-context-skill"), { recursive: true });
  writeFileSync(join(childContext, ".pi/skills/child-context-skill/SKILL.md"), "---\nname: child-context-skill\ndescription: Child project marker skill.\n---\nUse only in the child project.\n");
  const extensionMarker = join(childContext, "extension-loaded");
  mkdirSync(join(childContext, ".pi/extensions"), { recursive: true });
  writeFileSync(join(childContext, ".pi/extensions/marker.mjs"), `import { writeFileSync } from "node:fs"; export default function () { writeFileSync(${JSON.stringify(extensionMarker)}, "loaded"); }\n`);
  const contextCall = invoke(`Call subagent with agent comment-sicko, cwd ${JSON.stringify(relative(parentContext, childContext))}, and task "Say OK." Do not call Agent.`, undefined, parentContext);
  assert.equal(contextCall.length, 1);
  const systemMessage = JSON.stringify(contextCall[0].result.details.results[0].messages.find((message) => message.role === "system"));
  assert(systemMessage.includes("CHILD_CONTEXT_MARKER"), "Child instructions must come from task.cwd.");
  assert(!systemMessage.includes("PARENT_CONTEXT_MARKER"), "Parent project instructions must not leak to a different cwd.");
  assert(systemMessage.includes("child-context-skill"), "Child skills must come from task.cwd.");
  assert(!existsSync(extensionMarker), "Child cwd extensions must not execute in the parent process.");

  const missing = invoke('Call subagent with agent poteto-agent and task "Say yes".', [resolve(root, "extensions/pstack/index.ts")]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].isError, true);
  assert.match(missing[0].result.content[0].text, /pi-subagents is unavailable/);

  const oldRpc = join(profile, "old-rpc.mjs");
  writeFileSync(oldRpc, 'export default function (pi) { pi.events.on("subagents:rpc:ping", ({ requestId }) => pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 3 } })); }\n');
  const stale = invoke('Call subagent with agent poteto-agent and task "Say yes".', [oldRpc, resolve(root, "extensions/pstack/index.ts")]);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].isError, true);
  assert.match(stale[0].result.content[0].text, /RPC protocol 4/);

  const command = ["echo", "git", "push"].join(" ");
  writeFileSync(join(profile, "settings.json"), JSON.stringify({ packages: [...(provider === "commandcode" ? [{ source: resolve(commandcodeExt, "..") }] : []), { source: resolve(root, "../pi-subagents") }, { source: root }] }));
  const protectedCall = invoke(`Call subagent with agent poteto-agent and task "Use bash once with the exact command ${command}. Report the tool result." Do not call bash yourself.`, []);
  assert.equal(protectedCall.length, 1);
  const childMessages = protectedCall[0].result.details.results[0].messages;
  assert(childMessages.some((message) => message.role === "toolResult" && message.toolName === "bash" && message.isError && JSON.stringify(message.content).includes("requires explicit user confirmation")), "The child must block the external-looking echo command without interactive approval.");

  const activeToolsFile = join(profile, "active-tools.json");
  const rpcSpawnFile = join(profile, "rpc-spawn.json");
  const observer = join(profile, "observe-tools.mjs");
  writeFileSync(observer, `import { writeFileSync } from "node:fs"; export default function (pi) { pi.on("before_agent_start", () => writeFileSync(${JSON.stringify(activeToolsFile)}, JSON.stringify(pi.getActiveTools()))); pi.events.on("subagents:rpc:spawn", (request) => writeFileSync(${JSON.stringify(rpcSpawnFile)}, JSON.stringify({ type: request.type, isBackground: request.options?.isBackground }))); }\n`);
  const commandPi = spawn("pi", ["--provider", provider, "--model", model, "--mode", "rpc", "--no-session", "--extension", observer], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: profile },
  });
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      let expanded = false;
      const timeout = setTimeout(() => reject(new Error("Poteto Mode did not delegate through pstack.")), 180_000);
      commandPi.stdout.on("data", (chunk) => {
        output += chunk.toString();
        const lines = output.split("\n");
        output = lines.pop() ?? "";
        for (const line of lines) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === "extension_error") { clearTimeout(timeout); reject(new Error(event.error)); }
          if (event.type === "message_start" && event.message?.role === "user" && JSON.stringify(event.message.content).includes('<skill name=\\"poteto-mode\\"')) expanded = true;
          if (event.type === "tool_execution_end" && (event.toolName === "subagent" || event.toolName === "Agent")) {
            clearTimeout(timeout);
            try {
              assert(expanded, "Poteto Mode skill was not expanded.");
              assert.equal(event.toolName, "subagent", "Poteto Mode used the wrong delegation tool.");
              assert.equal(event.result.details.results[0].source, "bundled");
              resolve();
            } catch (error) { reject(error); }
          }
          if (event.type === "agent_end" && !expanded) { clearTimeout(timeout); reject(new Error("Poteto Mode command did not expand its skill.")); }
        }
      });
      commandPi.on("error", (error) => { clearTimeout(timeout); reject(error); });
      commandPi.stdin.write(`${JSON.stringify({ type: "prompt", message: '/poteto-mode Use the subagent tool with agent poteto-agent to read pi-pstack/package.json and report only its package name. Do not call Agent.' })}\n`);
    });
  } finally {
    commandPi.kill();
    if (commandPi.exitCode === null) await new Promise((resolve) => commandPi.once("close", resolve));
  }
  const activeTools = JSON.parse(readFileSync(activeToolsFile, "utf8"));
  assert(activeTools.includes("subagent"), "Pstack delegation tool must be available in Poteto Mode.");
  assert(!activeTools.includes("Agent"), "Agent tool must not compete with pstack delegation in Poteto Mode.");
  assert.deepEqual(JSON.parse(readFileSync(rpcSpawnFile, "utf8")), { type: "poteto-agent", isBackground: true }, "Pstack delegates to tintinweb as a widget-visible background agent.");
  console.log("Bundled identity, thinking-suffixed role, progress, parallel, chain, project collision and confirmation, relative cwd context and skills, target extension exclusion, missing and stale backends, child guard, and Poteto Mode routing checks passed.");
} finally {
  rmSync(profile, { recursive: true, force: true });
}

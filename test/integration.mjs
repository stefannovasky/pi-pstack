import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
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

  const parentContext = mkdtempSync(join(profile, "parent-"));
  const childContext = mkdtempSync(join(profile, "child-"));
  writeFileSync(join(parentContext, "AGENTS.md"), "PARENT_CONTEXT_MARKER\n");
  writeFileSync(join(childContext, "AGENTS.md"), "CHILD_CONTEXT_MARKER\n");
  const contextCall = invoke(`Call subagent with agent comment-sicko, cwd ${JSON.stringify(childContext)}, and task "Say OK." Do not call Agent.`, undefined, parentContext);
  assert.equal(contextCall.length, 1);
  const systemMessage = JSON.stringify(contextCall[0].result.details.results[0].messages.find((message) => message.role === "system"));
  assert(systemMessage.includes("CHILD_CONTEXT_MARKER"), "Child instructions must come from task.cwd.");
  assert(!systemMessage.includes("PARENT_CONTEXT_MARKER"), "Parent project instructions must not leak to a different cwd.");

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
  writeFileSync(join(profile, "settings.json"), JSON.stringify({ packages: [{ source: resolve(root, "../pi-subagents") }, { source: root }] }));
  const protectedCall = invoke(`Call subagent with agent poteto-agent and task "Use bash once with the exact command ${command}. Report the tool result." Do not call bash yourself.`, []);
  assert.equal(protectedCall.length, 1);
  const childMessages = protectedCall[0].result.details.results[0].messages;
  assert(childMessages.some((message) => message.role === "toolResult" && message.toolName === "bash" && message.isError && JSON.stringify(message.content).includes("requires explicit user confirmation")), "The child must block the external-looking echo command without interactive approval.");
  console.log("Bundled identity, thinking-suffixed role, parallel, chain, project collision, missing-provider, and child guard checks passed.");
} finally {
  rmSync(profile, { recursive: true, force: true });
}

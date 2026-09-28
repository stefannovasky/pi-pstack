import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const upstream = resolve(root, "../pi-subagents/src/index.ts");
assert(process.env.PI_CODING_AGENT_DIR, "Set PI_CODING_AGENT_DIR to a disposable profile with authentication before running this test.");
assert(existsSync(upstream), "The adjacent pi-subagents checkout is required.");

function invoke(prompt, extensions = [upstream, resolve(root, "extensions/pstack/index.ts")], cwd = root) {
  const model = process.env.PI_PROVIDER && process.env.PI_MODEL ? ["--provider", process.env.PI_PROVIDER, "--model", process.env.PI_MODEL] : [];
  const run = spawnSync("pi", [...model, "--no-session", "--mode", "json", ...extensions.flatMap((extension) => ["--extension", extension]), "--print", prompt], {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.error?.message || run.stderr.slice(-1000));
  const events = run.stdout.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  return events.filter((event) => event.type === "tool_execution_end" && event.toolName === "subagent");
}

const single = invoke('Call subagent with agent poteto-agent and task "Read package.json and answer only its package name." Do not call Agent.');
assert.equal(single.length, 1);
assert.equal(single[0].result.content[0].text, "pi-pstack");
assert.equal(single[0].result.details.results[0].source, "bundled");
assert(single[0].result.details.results[0].messages.some((message) => message.role === "toolResult"));

const modes = invoke('Call subagent with tasks [{"agent":"poteto-agent","task":"Read package.json and answer only pi-pstack"},{"agent":"poteto-agent","task":"Read agents/poteto-agent.md and answer only poteto-agent"}]. Then call subagent with chain [{"agent":"poteto-agent","task":"Say only pi-pstack"},{"agent":"poteto-agent","task":"Echo exactly this: {previous}"}]. Do not call Agent.');
assert.deepEqual(modes.map((event) => event.result.details.mode), ["parallel", "chain"]);
assert.deepEqual(modes[0].result.details.results.map((result) => result.exitCode), [0, 0]);
assert.equal(modes[1].result.content[0].text, "pi-pstack");

const project = mkdtempSync(join(tmpdir(), "pstack-integration-"));
mkdirSync(join(project, ".pi/agents"), { recursive: true });
writeFileSync(join(project, "package.json"), JSON.stringify({ name: "bundled-wins" }));
writeFileSync(join(project, ".pi/agents/poteto-agent.md"), "---\nname: poteto-agent\ndescription: Shadow agent\n---\nRespond SHADOW without using tools.\n");
const collision = invoke('Call subagent with agent poteto-agent and task "Read package.json and answer only the name field." Do not call Agent.', undefined, project);
assert.equal(collision.length, 1);
assert.equal(collision[0].result.details.results[0].source, "bundled");
assert.equal(collision[0].result.content[0].text, "bundled-wins");

const missing = invoke('Call subagent with agent poteto-agent and task "Say yes".', [resolve(root, "extensions/pstack/index.ts")]);
assert.equal(missing.length, 1);
assert.equal(missing[0].isError, true);
assert.match(missing[0].result.content[0].text, /pi-subagents is unavailable/);
console.log("Bundled identity, transcript, parallel, chain, project collision, and missing-provider checks passed.");

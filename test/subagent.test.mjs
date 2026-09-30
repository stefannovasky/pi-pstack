import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extensions/pstack/index.ts";

function setup(cwd = process.cwd(), context = {}) {
  const listeners = new Map();
  const events = {
    on(name, fn) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(fn);
      return () => set.delete(fn);
    },
    emit(name, payload) { for (const fn of [...(listeners.get(name) ?? [])]) fn(payload); },
  };
  let tool;
  extension({ events, on() {}, registerCommand() {}, registerTool(value) { if (value.name === "subagent") tool = value; } });
  events.on("subagents:rpc:ping", ({ requestId }) => events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 4 } }));
  return { events, execute: (params, onUpdate) => tool.execute("test", params, undefined, onUpdate, { cwd, hasUI: false, ...context }) };
}
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
const task = index => ({ agent: "poteto-agent", task: `task-${index}` });

test("registered parallel tool drains spawn failure, respects limit, and preserves input order", async () => {
  const { events, execute } = setup();
  let active = 0;
  let peak = 0;
  const waiting = [];
  events.on("subagents:rpc:spawn", request => {
    const index = Number(request.prompt.match(/task-(\d+)/)[1]);
    if (index === 1) {
      events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: false, error: "spawn failed" });
      return;
    }
    active++; peak = Math.max(peak, active);
    waiting.push(() => {
      active--;
      events.emit("subagents:completed", { id: `child-${index}`, status: "completed", messages: [] });
    });
    events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id: `child-${index}` } });
  });
  let settled = false;
  const outcome = execute({ tasks: Array.from({ length: 8 }, (_, index) => task(index)) }).catch(error => error);
  outcome.then(() => { settled = true; });
  await flush();
  const settledBeforeSiblings = settled;
  while (waiting.length) { waiting.pop()(); await flush(); }
  const result = await outcome;
  assert.equal(settledBeforeSiblings, false);
  assert.ok(!(result instanceof Error), result.message);
  assert.ok(peak <= 4);
  assert.equal(active, 0);
  assert.deepEqual(result.details.results.map(result => result.task), Array.from({ length: 8 }, (_, index) => `task-${index}`));
  assert.deepEqual(result.details.results.map(result => result.exitCode), [0, 1, 0, 0, 0, 0, 0, 0]);
  assert.match(result.content[0].text, /failed\n\nspawn failed/);
});

for (const mode of ["single", "chain"]) test(`registered ${mode} stops on spawn failure`, async () => {
  const { events, execute } = setup();
  let spawned = 0;
  events.on("subagents:rpc:spawn", request => {
    spawned++;
    events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: false, error: "spawn failed" });
  });
  await assert.rejects(execute(mode === "single" ? task(0) : { chain: [task(0), task(1)] }), /failed/);
  assert.equal(spawned, 1);
});

test("throwing progress callbacks cannot discard parallel outcomes", async () => {
  const { events, execute } = setup();
  let spawned = 0;
  events.on("subagents:rpc:spawn", request => {
    const id = `child-${++spawned}`;
    events.emit(`subagents:rpc:progress:${request.requestId}`, { id, status: "running", messages: [] });
    events.emit("subagents:completed", { id, status: "completed", messages: [] });
    events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
  });
  const result = await execute({ tasks: [task(0), task(1)] }, () => { throw new Error("progress callback"); });
  assert.deepEqual(result.details.results.map(result => result.exitCode), [0, 0]);
  assert.equal(spawned, 2);
});

test("relative task cwd resolves against the parent session, not process.cwd", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "pstack-cwd-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const child = join(parent, "child");
  mkdirSync(child);
  const { events, execute } = setup(parent);
  const spawns = [];
  events.on("subagents:rpc:spawn", request => {
    spawns.push(request);
    const id = `cwd-${spawns.length}`;
    events.emit("subagents:completed", { id, status: "completed", messages: [] });
    events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id } });
  });
  for (const cwd of ["child", child, ".", undefined]) {
    await execute({ ...task(0), cwd });
  }
  assert.deepEqual(spawns.map(request => request.options.cwd), [child, child, parent, parent]);
  assert.deepEqual(spawns.map(request => request.definition.contextFromCwd), [true, true, undefined, undefined]);
});

for (const approval of ["unavailable", "declined", "explicit"]) test(`project agent confirmation ${approval}`, async (t) => {
  const project = mkdtempSync(join(tmpdir(), "pstack-project-agent-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const directory = join(project, ".pi/agents");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "project-only.md"), "---\nname: project-only\ndescription: Local agent\n---\nSay OK.\n");
  const { events, execute } = setup(project, approval === "declined" ? { hasUI: true, ui: { confirm: async () => false } } : {});
  let spawned = 0;
  events.on("subagents:rpc:spawn", request => {
    spawned++;
    events.emit("subagents:completed", { id: "project-child", status: "completed" });
    events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id: "project-child" } });
  });
  const params = { agent: "project-only", task: "task", agentScope: "project", ...(approval === "explicit" && { confirmProjectAgents: false }) };
  if (approval === "explicit") {
    const result = await execute(params);
    assert.equal(result.details.results[0].source, "project");
    assert.equal(spawned, 1);
  } else {
    const outcome = await execute(params).catch(error => error);
    assert.ok(outcome instanceof Error);
    assert.match(outcome.message, /Project-local agents/);
    assert.equal(spawned, 0);
  }
});

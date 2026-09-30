import { test } from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/pstack/index.ts";

function setup() {
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
  return { events, execute: (params, onUpdate) => tool.execute("test", params, undefined, onUpdate, { cwd: process.cwd(), hasUI: false }) };
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

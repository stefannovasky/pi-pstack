import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runSubagent } from "../extensions/pstack/rpc.ts";

function bus() {
  const listeners = new Map();
  const sent = [];
  return {
    sent,
    on(name, handler) {
      const handlers = listeners.get(name) ?? new Set();
      listeners.set(name, handlers);
      handlers.add(handler);
      return () => { handlers.delete(handler); if (!handlers.size) listeners.delete(name); };
    },
    emit(name, payload) {
      sent.push([name, payload]);
      for (const handler of [...(listeners.get(name) ?? [])]) handler(payload);
    },
    count() { return [...listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0); },
  };
}
const agent = { name: "test", description: "test", systemPrompt: "test", source: "bundled" };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const reply = (events, method, request, data) => events.emit(`subagents:rpc:${method}:reply:${request.requestId}`, data);
const run = (events, signal, update) => runSubagent({ events }, agent, "task", process.cwd(), false, undefined, signal, update);

for (const stage of ["before", "ping", "spawn", "running"]) test(`abort ${stage} settles and cleans up`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = bus();
  const controller = new AbortController();
  let childSignal;
  const offPing = events.on("subagents:rpc:ping", request => {
    if (stage === "ping") controller.abort();
    reply(events, "ping", request, { success: true, data: { version: 4 } });
  });
  const offSpawn = events.on("subagents:rpc:spawn", request => {
    childSignal = request.options.signal;
    if (stage === "spawn") controller.abort();
    if (stage === "running") reply(events, "spawn", request, { success: true, data: { id: "child" } });
  });
  if (stage === "before") controller.abort();
  const outcome = run(events, controller.signal).then(() => "resolved", error => error.message);
  await flush();
  if (stage === "running") controller.abort();
  t.mock.timers.tick(30 * 60 * 1000);
  assert.match(await outcome, /aborted/);
  if (stage === "before") assert.equal(events.sent.length, 0);
  if (stage === "ping") assert.equal(events.sent.some(([name]) => name === "subagents:rpc:spawn"), false);
  if (childSignal) assert.equal(childSignal.aborted, true);
  assert.ok(events.sent.filter(([name]) => name === "subagents:rpc:stop").length <= 1);
  offPing(); offSpawn();
  assert.equal(events.count(), 0);
});

for (const stage of ["spawn", "running"]) test(`deadline aborts producer during ${stage}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = bus();
  const offPing = events.on("subagents:rpc:ping", request => reply(events, "ping", request, { success: true, data: { version: 4 } }));
  let spawn;
  const offSpawn = events.on("subagents:rpc:spawn", request => {
    spawn = request;
    if (stage === "running") reply(events, "spawn", request, { success: true, data: { id: "child" } });
  });
  let outcome;
  const pending = run(events).then(value => { outcome = value; }, error => { outcome = error; });
  await flush();
  t.mock.timers.tick(4000); await flush();
  assert.equal(outcome, undefined);
  assert.ok(spawn.options.signal instanceof AbortSignal);
  t.mock.timers.tick(30 * 60 * 1000); await pending;
  assert.match(outcome.message, /30 minutes/);
  assert.equal(spawn.options.signal.aborted, true);
  assert.equal(events.sent.filter(([name]) => name === "subagents:rpc:stop").length, stage === "running" ? 1 : 0);
  offPing(); offSpawn();
  assert.equal(events.count(), 0);
});

for (const version of [undefined, 3]) test(`unavailable backend ${version}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = bus();
  const off = events.on("subagents:rpc:ping", request => { if (version) reply(events, "ping", request, { success: true, data: { version } }); });
  const outcome = run(events).catch(error => error);
  t.mock.timers.tick(3000);
  assert.match((await outcome).message, /unavailable|protocol/);
  assert.equal(events.sent.some(([name]) => name === "subagents:rpc:spawn"), false);
  off();
  assert.equal(events.count(), 0);
});

for (const mode of ["startup", "ping-abort", "spawn-abort"]) test(`late replies after ${mode}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = bus();
  const controller = new AbortController();
  let ping;
  let spawn;
  const offPing = events.on("subagents:rpc:ping", request => {
    ping = request;
    if (mode !== "ping-abort") reply(events, "ping", request, { success: true, data: { version: 4 } });
  });
  const offSpawn = events.on("subagents:rpc:spawn", request => { spawn = request; });
  const pending = run(events, controller.signal).catch(error => error);
  await flush();
  if (mode === "startup") {
    t.mock.timers.tick(4000);
    events.emit("subagents:completed", { id: "child", status: "completed" });
    reply(events, "spawn", spawn, { success: true, data: { id: "child" } });
    assert.equal((await pending).id, "child");
  } else {
    controller.abort();
    assert.match((await pending).message, /aborted/);
    if (mode === "ping-abort") {
      reply(events, "ping", ping, { success: true, data: { version: 4 } });
      assert.equal(spawn, undefined);
    } else {
      assert.equal(spawn.options.signal.aborted, true);
      reply(events, "spawn", spawn, { success: true, data: { id: "child" } });
    }
  }
  assert.equal(events.sent.some(([name]) => name === "subagents:rpc:stop"), false);
  offPing(); offSpawn();
  assert.equal(events.count(), 0);
});

test("early and interleaved completion, duplicate events, and throwing callbacks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = bus();
  const offPing = events.on("subagents:rpc:ping", request => reply(events, "ping", request, { success: true, data: { version: 4 } }));
  const spawns = [];
  const offSpawn = events.on("subagents:rpc:spawn", request => spawns.push(request));
  const updates = [[], []];
  const pending = updates.map((list, index) => run(events, undefined, event => { list.push(event); if (index === 0) throw new Error("callback"); }));
  await flush();
  events.emit(`subagents:rpc:progress:${spawns[0].requestId}`, { id: "a", status: "running" });
  events.emit("subagents:completed", { id: "unrelated", status: "completed" });
  events.emit("subagents:failed", { id: "b", status: "error", error: "child failure" });
  events.emit("subagents:completed", { id: "a", status: "completed" });
  reply(events, "spawn", spawns[0], { success: true, data: { id: "a" } });
  reply(events, "spawn", spawns[1], { success: true, data: { id: "b" } });
  await flush();
  events.emit("subagents:completed", { id: "a", status: "completed" });
  assert.deepEqual((await Promise.all(pending)).map(event => event.id), ["a", "b"]);
  assert.deepEqual(updates.map(list => list.map(event => event.status)), [["running", "completed"], ["error"]]);
  assert.equal(events.sent.filter(([name]) => name === "subagents:rpc:consume").length, 2);
  offPing(); offSpawn();
  assert.equal(events.count(), 0);
  t.mock.timers.tick(30 * 60 * 1000);
});

test("the canonical skill path remains readable when the package path contains spaces", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pstack url "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const modulePath = join(directory, "extensions/pstack/rpc.ts");
  mkdirSync(dirname(modulePath), { recursive: true });
  copyFileSync(new URL("../extensions/pstack/rpc.ts", import.meta.url), modulePath);
  const relocated = await import(pathToFileURL(modulePath).href);
  const events = bus();
  let spawn;
  const offPing = events.on("subagents:rpc:ping", request => reply(events, "ping", request, { success: true, data: { version: 4 } }));
  const offSpawn = events.on("subagents:rpc:spawn", request => {
    spawn = request;
    events.emit("subagents:completed", { id: "relocated", status: "completed" });
    reply(events, "spawn", request, { success: true, data: { id: "relocated" } });
  });
  await relocated.runSubagent({ events }, { ...agent, name: "poteto-agent" }, "task", process.cwd(), false, undefined);
  assert.ok(spawn.prompt.includes(join(directory, "skills/poteto-mode/SKILL.md")));
  offPing(); offSpawn();
  assert.equal(events.count(), 0);
});

for (const mode of ["success", "failure", "abort", "deadline", "missing"]) test(`no abandoned timers or listeners after ${mode}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timers = new Set();
  const schedule = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const timer = schedule(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", timer => { timers.delete(timer); clear(timer); });
  const events = bus();
  const controller = new AbortController();
  let producerSignal;
  const offPing = events.on("subagents:rpc:ping", request => {
    if (mode !== "missing") reply(events, "ping", request, { success: true, data: { version: 4 } });
  });
  const offSpawn = events.on("subagents:rpc:spawn", request => {
    producerSignal = request.options.signal;
    if (mode === "success") {
      events.emit("subagents:completed", { id: "child", status: "completed" });
      reply(events, "spawn", request, { success: true, data: { id: "child" } });
    }
    if (mode === "failure") reply(events, "spawn", request, { success: false, error: "failure" });
    if (mode === "abort") controller.abort();
  });
  const outcome = run(events, controller.signal).catch(error => error);
  await flush();
  if (mode === "deadline" || mode === "missing") t.mock.timers.tick(30 * 60 * 1000);
  await outcome;
  assert.equal(timers.size, 0);
  if (mode === "abort" || mode === "deadline") assert.equal(producerSignal.aborted, true);
  offPing(); offSpawn();
  assert.equal(events.count(), 0);
});

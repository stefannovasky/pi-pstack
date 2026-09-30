import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";

type EventData = { id: string; status: string; result?: string; error?: string; messages?: Message[]; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }; model?: string; thinkingLevel?: string };
type Reply = { success: boolean; data?: { id?: string; version?: number }; error?: string };
let requestSequence = 0;

export async function runSubagent(pi: ExtensionAPI, agent: AgentConfig, task: string, cwd: string, contextFromCwd: boolean, model: string | undefined, signal?: AbortSignal, onUpdate?: (event: EventData) => void): Promise<EventData> {
  if (signal?.aborted) throw new Error("Subagent task aborted.");
  const events = pi.events;
  const requestId = `pstack-${process.pid}-${++requestSequence}`;
  const controller = new AbortController();
  let ownedId: string | undefined;
  let terminal: EventData | undefined;
  let stopSent = false;
  const stop = () => {
    if (ownedId && !terminal && !stopSent) {
      stopSent = true;
      events.emit("subagents:rpc:stop", { requestId, agentId: ownedId });
    }
  };
  const abort = () => {
    controller.abort(new Error("Subagent task aborted."));
    stop();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(() => {
    controller.abort(new Error("pi-subagents did not report completion within 30 minutes."));
    stop();
  }, 30 * 60 * 1000);
  const rpc = (method: string, payload: Record<string, unknown>, timeout?: number): Promise<Reply> => new Promise((resolve, reject) => {
    if (controller.signal.aborted) { reject(controller.signal.reason); return; }
    const channel = `subagents:rpc:${method}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      off();
      controller.signal.removeEventListener("abort", cancelled);
    };
    const cancelled = () => { cleanup(); reject(controller.signal.reason); };
    const off = events.on(`${channel}:reply:${requestId}`, (raw) => {
      cleanup();
      resolve(raw as Reply);
    });
    controller.signal.addEventListener("abort", cancelled, { once: true });
    if (timeout !== undefined) timer = setTimeout(() => {
      cleanup();
      reject(new Error("pi-subagents is unavailable. Load the tintinweb/pi-subagents extension in this Pi session."));
    }, timeout);
    try { events.emit(channel, { requestId, ...payload }); }
    catch (error) { cleanup(); reject(error); }
  });
  const early = new Map<string, EventData>();
  let settle: (event: EventData) => void = () => {};
  let cancel: (reason: unknown) => void = () => {};
  const finished = new Promise<EventData>((resolve, reject) => { settle = resolve; cancel = reject; });
  const cancelled = () => cancel(controller.signal.reason);
  const update = (event: EventData) => { try { onUpdate?.(event); } catch {} };
  const onFinished = (raw: unknown) => {
    const event = raw as EventData;
    if (!event?.id || terminal || controller.signal.aborted) return;
    if (event.id !== ownedId) { if (!ownedId) early.set(event.id, event); return; }
    terminal = event;
    settle(event);
    events.emit("subagents:rpc:consume", { requestId, agentId: event.id });
    update(event);
  };
  let offDone = () => {};
  let offFailed = () => {};
  let offProgress = () => {};
  try {
    const ping = await rpc("ping", {}, 3000);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!ping.success || (ping.data?.version ?? 0) < 4) throw new Error("pi-subagents RPC protocol 4 or newer is required for package-local agents and progress events.");
    offDone = events.on("subagents:completed", onFinished);
    offFailed = events.on("subagents:failed", onFinished);
    offProgress = events.on(`subagents:rpc:progress:${requestId}`, (raw) => {
      if (!terminal && !controller.signal.aborted) update(raw as EventData);
    });
    const prompt = agent.name === "poteto-agent"
      ? `${task}\n\nBefore any work, use the read tool to load the canonical poteto-mode skill at ${fileURLToPath(new URL("../../skills/poteto-mode/SKILL.md", import.meta.url))}.`
      : task;
    const selector = model?.match(/^(.*):(off|minimal|low|medium|high|xhigh|max)$/);
    const reply = await rpc("spawn", {
      type: agent.name,
      prompt: `Delegated task:\n${prompt}`,
      definition: { name: agent.name, description: agent.description, systemPrompt: agent.systemPrompt, tools: agent.tools, promptMode: "append", ...(contextFromCwd && { contextFromCwd: true }) },
      options: { description: agent.description, model: selector ? selector[1] : model, thinkingLevel: selector?.[2], cwd, isBackground: true, signal: controller.signal },
    });
    if (!reply.success || !reply.data?.id) throw new Error(reply.error ?? "pi-subagents rejected the spawn.");
    ownedId = reply.data.id;
    const completedEarly = early.get(ownedId);
    early.clear();
    if (controller.signal.aborted) { stop(); throw controller.signal.reason; }
    if (completedEarly) onFinished(completedEarly);
    controller.signal.addEventListener("abort", cancelled, { once: true });
    return await finished;
  } finally {
    clearTimeout(deadline);
    offDone();
    offFailed();
    offProgress();
    early.clear();
    controller.signal.removeEventListener("abort", cancelled);
    signal?.removeEventListener("abort", abort);
  }
}

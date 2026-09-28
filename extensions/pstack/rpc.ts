import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";

type EventData = { id: string; status: string; result?: string; error?: string; messages?: Message[]; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }; model?: string; thinkingLevel?: string };
type Reply = { success: boolean; data?: { id?: string; version?: number }; error?: string };
let requestSequence = 0;

export async function runSubagent(pi: ExtensionAPI, agent: AgentConfig, task: string, cwd: string, contextFromCwd: boolean, model: string | undefined, signal?: AbortSignal, onUpdate?: (event: EventData) => void): Promise<EventData> {
  const events = pi.events;
  const requestId = `pstack-${process.pid}-${++requestSequence}`;
  const rpc = (method: string, payload: Record<string, unknown>, timeout = 3000): Promise<Reply> => new Promise((resolve, reject) => {
    const channel = `subagents:rpc:${method}`;
    const timer = setTimeout(() => { off(); reject(new Error("pi-subagents is unavailable. Load the tintinweb/pi-subagents extension in this Pi session.")); }, timeout);
    const off = events.on(`${channel}:reply:${requestId}`, (raw) => {
      clearTimeout(timer);
      off();
      resolve(raw as Reply);
    });
    events.emit(channel, { requestId, ...payload });
  });
  const ping = await rpc("ping", {});
  if (!ping.success || (ping.data?.version ?? 0) < 4) throw new Error("pi-subagents RPC protocol 4 or newer is required for package-local agents and progress events.");

  let ownedId: string | undefined;
  const early = new Map<string, EventData>();
  let settle: (event: EventData) => void = () => {};
  const finished = new Promise<EventData>((resolve) => { settle = resolve; });
  const onFinished = (raw: unknown) => {
    const event = raw as EventData;
    if (!event?.id) return;
    if (event.id !== ownedId) { if (!ownedId) early.set(event.id, event); return; }
    events.emit("subagents:rpc:consume", { requestId, agentId: event.id });
    onUpdate?.(event);
    settle(event);
  };
  const offDone = events.on("subagents:completed", onFinished);
  const offFailed = events.on("subagents:failed", onFinished);
  const offProgress = events.on(`subagents:rpc:progress:${requestId}`, (raw) => onUpdate?.(raw as EventData));
  const abort = () => { if (ownedId) events.emit("subagents:rpc:stop", { requestId, agentId: ownedId }); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new Error("Subagent task aborted.");
    const prompt = agent.name === "poteto-agent"
      ? `${task}\n\nBefore any work, use the read tool to load the canonical poteto-mode skill at ${new URL("../../skills/poteto-mode/SKILL.md", import.meta.url).pathname}.`
      : task;
    const selector = model?.match(/^(.*):(off|minimal|low|medium|high|xhigh|max)$/);
    const reply = await rpc("spawn", {
      type: agent.name,
      prompt: `Delegated task:\n${prompt}`,
      definition: { name: agent.name, description: agent.description, systemPrompt: agent.systemPrompt, tools: agent.tools, promptMode: "append", ...(contextFromCwd && { contextFromCwd: true }) },
      options: { description: agent.description, model: selector ? selector[1] : model, thinkingLevel: selector?.[2], cwd, isBackground: false, signal },
    });
    if (!reply.success || !reply.data?.id) throw new Error(reply.error ?? "pi-subagents rejected the spawn.");
    ownedId = reply.data.id;
    const completedEarly = early.get(ownedId);
    if (completedEarly) onFinished(completedEarly);
    if (signal?.aborted) abort();
    return await Promise.race([finished, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("pi-subagents did not report completion within 30 minutes.")), 30 * 60 * 1000);
      finished.finally(() => clearTimeout(timer));
    })]);
  } finally {
    offDone();
    offFailed();
    offProgress();
    signal?.removeEventListener("abort", abort);
  }
}

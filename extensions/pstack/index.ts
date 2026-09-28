import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bundledAgentsDirectory, discoverAgents, projectAgentsDirectory, type AgentConfig, type AgentScope } from "./agents.ts";
import { ROLE_NAMES, configPath, defaultConfig, modelsForRole, readConfig, writeConfig } from "./config.ts";
import { runSubagent } from "./rpc.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_MODEL_OUTPUT_BYTES = 50 * 1024;
const MODE_ENTRY = "pstack-mode";

const Task = Type.Object({
  agent: Type.String({ description: "Agent name. Use poteto-agent for pstack implementation delegates." }),
  task: Type.String({ description: "Self-contained delegated task. Point to files instead of inlining large payloads." }),
  model: Type.Optional(Type.String({ description: "Pi model selector (provider/model). Overrides the role configuration." })),
  role: Type.Optional(Type.String({ description: "pstack model role configured by /setup-pstack." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for this child Pi process." })),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  role: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  tasks: Type.Optional(Type.Array(Task)),
  chain: Type.Optional(Type.Array(Task)),
  agentScope: Type.Optional(
    StringEnum(["bundled", "user", "project", "both"] as const, {
      description: "Agent locations. bundled is the safe default. Project agents require explicit opt-in.",
      default: "bundled",
    }),
  ),
  confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
});

type TaskInput = {
  agent: string;
  task: string;
  model?: string;
  role?: string;
  cwd?: string;
};

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
type ChildResult = {
  agent: string;
  source: string;
  task: string;
  model?: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: Usage;
  stopReason?: string;
  errorMessage?: string;
  thinkingLevel?: string;
};

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function resultText(result: ChildResult): string {
  const final = [...result.messages].reverse().find((message) => message.role === "assistant");
  if (final?.role === "assistant") {
    const text = final.content.find((part) => part.type === "text");
    if (text?.type === "text") return text.text;
  }
  return result.errorMessage || result.stderr || "(no output)";
}

function failure(result: ChildResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function truncate(text: string): string {
  if (Buffer.byteLength(text) <= MAX_MODEL_OUTPUT_BYTES) return text;
  let output = text.slice(0, MAX_MODEL_OUTPUT_BYTES);
  while (Buffer.byteLength(output) > MAX_MODEL_OUTPUT_BYTES) output = output.slice(0, -1);
  return `${output}\n\n[Output truncated. Full transcript is retained in the tool details.]`;
}

async function runLimited<T>(items: T[], callback: (item: T, index: number) => Promise<ChildResult>): Promise<ChildResult[]> {
  const results = new Array<ChildResult>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await callback(items[index], index);
      }
    }),
  );
  return results;
}

function knownExternalWrite(command: string): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/\bgit\s+push\b/, "git push"],
    [/\bgh\s+pr\s+(create|edit|merge|close)\b/, "GitHub pull-request mutation"],
    [/\bgt\s+(submit|merge|create)\b/, "Graphite mutation"],
    [/\b(terraform|tofu)\s+(apply|destroy)\b/, "infrastructure mutation"],
    [/\bkubectl\s+(apply|delete|rollout)\b/, "Kubernetes mutation"],
    [/\b(vercel|flyctl|railway)\s+(deploy|promote)\b/, "deployment"],
    [/\brm\s+(-[A-Za-z]*r|--recursive)/, "recursive deletion"],
  ];
  return patterns.find(([pattern]) => pattern.test(command))?.[1];
}

export default function (pi: ExtensionAPI) {
  let potetoMode = false;
  let todos: string[] = [];

  pi.on("session_start", (_event, ctx) => {
    potetoMode = false;
    todos = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === MODE_ENTRY) potetoMode = Boolean((entry.data as { enabled?: boolean }).enabled);
      if (entry.type === "custom" && entry.customType === "pstack-todo") {
        const items = (entry.data as { items?: unknown }).items;
        if (Array.isArray(items) && items.every((item) => typeof item === "string")) todos = items;
      }
    }
    if (ctx.mode === "tui") ctx.ui.setStatus("pstack-mode", potetoMode ? "pstack: poteto mode" : undefined);
  });

  pi.on("input", (event) => {
    if (/^\/skill:poteto-mode(?:\s|$)/.test(event.text)) {
      potetoMode = true;
      pi.appendEntry(MODE_ENTRY, { enabled: true });
    }
    return { action: "continue" } as const;
  });

  pi.on("before_agent_start", (event) => {
    if (!potetoMode) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nPstack Poteto Mode is enabled for this session. Follow its persisted workflow: use pstack_todo for non-trivial work, select and read the matching playbook, delegate through the subagent tool when delegation helps, verify real behavior, and name only principles that changed a decision. The full skill is at ${path.join(packageRoot(), "skills/poteto-mode/SKILL.md")}.`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const input = event.input as { command?: string };
    const operation = input.command ? knownExternalWrite(input.command) : undefined;
    if (!operation) return;
    if (!ctx.hasUI) return { block: true, reason: `${operation} requires explicit user confirmation; non-interactive Pi cannot request it.` };
    const approved = await ctx.ui.confirm("Confirm external or irreversible action", `Allow ${operation}?\n\n${input.command}`);
    if (!approved) return { block: true, reason: `User declined ${operation}.` };
  });

  pi.registerCommand("poteto-mode", {
    description: "Enable or disable sticky pstack Poteto Mode for this Pi session. Usage: /poteto-mode [task] | /poteto-mode off",
    handler: async (args, ctx) => {
      if (/^(off|disable|stop)$/i.test(args.trim())) {
        potetoMode = false;
        pi.appendEntry(MODE_ENTRY, { enabled: false });
        ctx.ui.setStatus("pstack-mode", undefined);
        ctx.ui.notify("Poteto Mode disabled for this session.", "info");
        return;
      }
      potetoMode = true;
      pi.appendEntry(MODE_ENTRY, { enabled: true });
      ctx.ui.setStatus("pstack-mode", "pstack: poteto mode");
      pi.sendUserMessage(`/skill:poteto-mode${args.trim() ? ` ${args.trim()}` : ""}`, { expandPromptTemplates: true });
    },
  });

  pi.registerCommand("setup-pstack", {
    description: "Interactively map pstack delegation roles to models available in Pi.",
    handler: async (_args, ctx) => {
      const config = await readConfig();
      const available = (ctx.scopedModels.length ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable())
        .map((model) => `${model.provider}/${model.id}`);
      const choices = ["inherit-parent", ...new Set(available)];
      if (!ctx.hasUI) {
        await writeConfig(defaultConfig());
        return;
      }
      for (const role of ROLE_NAMES) {
        const current = config.roles[role];
        const selected = await ctx.ui.select(`Model for ${role}`, choices.map((model) => model === current ? `${model} (current)` : model));
        if (!selected) break;
        config.roles[role] = selected.replace(/ \(current\)$/, "");
      }
      await writeConfig(config);
      ctx.ui.notify(`Saved pstack model settings to ${configPath()}.`, "info");
    },
  });

  pi.registerTool({
    name: "pstack_todo",
    label: "Pstack Todo",
    description: "Maintain pstack's current task checklist. Use at the start of non-trivial multi-step work, then update it as work advances.",
    parameters: Type.Object({
      action: StringEnum(["get", "set", "add", "complete"] as const),
      items: Type.Optional(Type.Array(Type.String())),
      item: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      if (params.action === "set") todos = params.items ?? [];
      if (params.action === "add" && params.item) todos = [...todos, params.item];
      if (params.action === "complete" && params.item) todos = todos.map((item) => item === params.item ? `[done] ${item}` : item);
      pi.appendEntry("pstack-todo", { items: todos });
      return { content: [{ type: "text", text: todos.length ? todos.map((item, index) => `${index + 1}. ${item}`).join("\n") : "No pstack todo items." }], details: { items: todos } };
    },
  });

  pi.registerTool({
    name: "pstack_sessions",
    label: "Pstack Sessions",
    description: "List Pi session files for the current working directory. Use before reading prior Pi transcripts; never glob other project session directories.",
    parameters: Type.Object({ action: StringEnum(["list"] as const) }),
    async execute(_id, _params, _signal, _update, ctx) {
      const sessions = await SessionManager.list(ctx.cwd);
      const files = sessions.map((session) => session.file);
      return { content: [{ type: "text", text: files.join("\n") || "No saved sessions for this working directory." }], details: { files } };
    },
  });

  pi.registerTool({
    name: "pstack_config",
    label: "Pstack Config",
    description: "Read or update pstack's role-to-model configuration. Use list-models before setting a model. inherit-parent makes a subagent use the parent session model.",
    parameters: Type.Object({
      action: StringEnum(["get", "list-models", "set"] as const),
      role: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      models: Type.Optional(Type.Array(Type.String(), { description: "Optional ordered model pool for a parallel review role." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.action === "list-models") {
        const models = (ctx.scopedModels.length ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable())
          .map((model) => `${model.provider}/${model.id}`);
        return { content: [{ type: "text", text: ["inherit-parent", ...models].join("\n") }], details: { models } };
      }
      const config = await readConfig();
      if (params.action === "set") {
        if (!params.role || (!params.model && !params.models?.length)) throw new Error("pstack_config set requires role plus model or models.");
        config.roles[params.role] = params.models?.length ? params.models : params.model!;
        await writeConfig(config);
      }
      return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }], details: config };
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: `Delegate isolated work to Pi subagents. Supports exactly one of single agent/task, parallel tasks (maximum ${MAX_PARALLEL_TASKS}), or sequential chain. Bundled pstack agents live in ${bundledAgentsDirectory()}.`,
    parameters: SubagentParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      const scope = (params.agentScope ?? "bundled") as AgentScope;
      const agents = discoverAgents(ctx.cwd, scope);
      const requested = params.agent ? [{ agent: params.agent, task: params.task ?? "", model: params.model, role: params.role, cwd: params.cwd }] : undefined;
      const modes = Number(Boolean(requested && params.task)) + Number(Boolean(params.tasks?.length)) + Number(Boolean(params.chain?.length));
      if (modes !== 1) throw new Error("Provide exactly one mode: agent + task, tasks, or chain.");
      if ((scope === "project" || scope === "both") && params.confirmProjectAgents !== false && ctx.hasUI) {
        const names = [...(requested ?? []), ...(params.tasks ?? []), ...(params.chain ?? [])].map((task) => task.agent);
        const project = agents.filter((agent) => agent.source === "project" && names.includes(agent.name));
        if (project.length) {
          const approved = await ctx.ui.confirm("Run project-local Pi agents?", `Agents: ${project.map((agent) => agent.name).join(", ")}\nSource: ${projectAgentsDirectory(ctx.cwd)}`);
          if (!approved) throw new Error("Project-local agents were not approved.");
        }
      }
      const config = await readConfig();
      const childModel = (task: TaskInput, index = 0) => task.model ?? modelsForRole(config, task.role)[index % Math.max(modelsForRole(config, task.role).length, 1)] ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
      const makeUpdate = (results: ChildResult[]) => onUpdate?.({
        content: [{ type: "text", text: results.map((result) => `${result.agent}: ${resultText(result)}`).join("\n\n") }],
        details: { results },
      });
      const start = async (task: TaskInput, index = 0, update?: (result: ChildResult) => void): Promise<ChildResult> => {
        const agent = agents.find((candidate) => candidate.name === task.agent);
        if (!agent) return { agent: task.agent, source: "unknown", task: task.task, exitCode: 1, messages: [], stderr: `Unknown agent ${JSON.stringify(task.agent)}. Available agents: ${agents.map((item) => item.name).join(", ") || "none"}.`, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } };
        const model = childModel(task, index);
        const asResult = (event: Awaited<ReturnType<typeof runSubagent>>): ChildResult => {
          const failed = event.status === "error" || event.status === "stopped" || event.status === "aborted";
          const turns = event.messages?.filter((message) => message.role === "assistant") ?? [];
          const total = (field: "input" | "output" | "cacheRead" | "cacheWrite") => turns.reduce((sum, message) => sum + (message.usage?.[field] ?? 0), 0);
          return {
            agent: agent.name, source: agent.source, task: task.task, model: model ?? event.model,
            exitCode: failed ? 1 : 0,
            messages: event.messages ?? [], stderr: event.error ?? "",
            usage: { input: event.usage?.input ?? total("input"), output: event.usage?.output ?? total("output"), cacheRead: event.usage?.cacheRead ?? total("cacheRead"), cacheWrite: event.usage?.cacheWrite ?? total("cacheWrite"), cost: event.usage?.cost?.total ?? turns.reduce((sum, message) => sum + (message.usage?.cost?.total ?? 0), 0), turns: turns.length },
            stopReason: event.status === "error" || event.status === "aborted" ? event.status : undefined,
            errorMessage: event.error,
            thinkingLevel: event.thinkingLevel,
          };
        };
        const event = await runSubagent(pi, agent, task.task, task.cwd ?? ctx.cwd, task.cwd !== undefined && path.resolve(task.cwd) !== path.resolve(ctx.cwd), model, signal, (progress) => {
          if (progress.status === "running") update?.(asResult(progress));
        });
        const result = asResult(event);
        update?.(result);
        return result;
      };

      if (params.chain?.length) {
        const results: ChildResult[] = [];
        let previous = "";
        for (const [index, task] of params.chain.entries()) {
          const result = await start({ ...task, task: task.task.replaceAll("{previous}", previous) }, index, (current) => makeUpdate([...results, current]));
          results.push(result);
          if (failure(result)) throw new Error(`Chain step ${index + 1} (${result.agent}) failed: ${resultText(result)}`);
          previous = resultText(result);
        }
        return { content: [{ type: "text", text: resultText(results.at(-1)!) }], details: { mode: "chain", results } };
      }

      if (params.tasks?.length) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) throw new Error(`At most ${MAX_PARALLEL_TASKS} parallel tasks are allowed.`);
        const updates: ChildResult[] = params.tasks.map((task) => ({ agent: task.agent, source: "pending", task: task.task, exitCode: -1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }));
        const results = await runLimited(params.tasks, async (task, index) => {
          const result = await start(task, index, (current) => { updates[index] = current; makeUpdate(updates); });
          updates[index] = result;
          makeUpdate(updates);
          return result;
        });
        const report = results.map((result) => `### ${result.agent} ${failure(result) ? "failed" : "completed"}\n\n${truncate(resultText(result))}`).join("\n\n---\n\n");
        return { content: [{ type: "text", text: report }], details: { mode: "parallel", results } };
      }

      const task = requested![0];
      const result = await start(task, 0, (current) => makeUpdate([current]));
      if (failure(result)) throw new Error(`${result.agent} failed: ${resultText(result)}`);
      return { content: [{ type: "text", text: resultText(result) }], details: { mode: "single", results: [result] } };
    },
  });
}

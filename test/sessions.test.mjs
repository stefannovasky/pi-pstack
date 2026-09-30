import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/pstack/index.ts";

test("registered session tool returns real session file paths", async (t) => {
  const profile = mkdtempSync(join(tmpdir(), "pstack-sessions-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = profile;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(profile, { recursive: true, force: true });
  });
  const cwd = join(profile, "project");
  const session = SessionManager.create(cwd);
  const file = session.getSessionFile();
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: session.getSessionId(), timestamp: new Date().toISOString(), cwd })}\n`);
  let tool;
  extension({
    on() {},
    registerCommand() {},
    registerTool(value) { if (value.name === "pstack_sessions") tool = value; },
  });
  const result = await tool.execute("sessions", { action: "list" }, undefined, undefined, { cwd });
  assert.deepEqual(result.details.files, [file]);
  assert.equal(result.content[0].text, file);
});

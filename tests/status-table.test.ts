import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLocale } from "../src/locale.js";
import { TopicCommands } from "../src/topic-commands.js";

/**
 * #1052: /status is the primary table — Status/State merged into one State
 * column, IPC dropped, Model added (same source as /ctx), en+zh headers.
 */

const roots: string[] = [];
afterEach(() => {
  setLocale("en");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(models: Record<string, string>, statuses: Record<string, { status: string; exec?: string | null }>) {
  const dir = mkdtempSync(join(tmpdir(), "agend-status-table-"));
  roots.push(dir);
  const instances: Record<string, { backend: string; working_directory: string }> = {};
  for (const name of Object.keys(statuses)) instances[name] = { backend: "codex", working_directory: dir };
  const commands = new TopicCommands({
    dataDir: dir,
    fleetConfig: { defaults: {}, instances },
    getInstanceStatus: (name: string) => statuses[name].status,
    getInstanceExecutionState: (name: string) => statuses[name].exec ?? null,
    modelDisplayForInstance: (name: string) => models[name] ?? "default",
  } as any);
  return commands;
}

describe("/status table (#1052)", () => {
  it("merges Status/State, drops IPC, and shows one Model column", async () => {
    const commands = setup(
      { w: "gpt-6-luna", p: "auto", s: "sonnet-4.6", c: "opus" },
      {
        w: { status: "running", exec: "working" },
        p: { status: "paused", exec: "paused" },
        s: { status: "stopped", exec: null },
        c: { status: "crashed", exec: null },
      },
    );
    const text = await commands.getStatusText();
    const header = text.split("\n").find(l => l.startsWith("| Instance")) ?? "";
    expect(header).toBe("| Instance | Backend | Model | Ctx | Effort | Cost | State |");
    expect(text).not.toContain("IPC");
    expect(text).toContain("gpt-6-luna");
    expect(text).toContain("⏸ paused");
    expect(text).toContain("🔵 working");
    expect(text).toContain("✗ stopped");
    expect(text).toContain("🔴 crashed");
  });

  it("truncates a long model so one name cannot blow the table wider", async () => {
    const commands = setup(
      { w: "muse-spark-1.3-contributor" },
      { w: { status: "running", exec: "idle" } },
    );
    const text = await commands.getStatusText();
    expect(text).not.toContain("muse-spark-1.3-contributor");
    expect(text).toContain("…");
    for (const line of text.split("\n").filter(l => l.startsWith("| "))) {
      expect(line.length).toBeLessThanOrEqual(140);
    }
  });

  it("renders the zh header and lifecycle states", async () => {
    setLocale("zh-TW");
    const commands = setup(
      { s: "sonnet-4.6", c: "opus" },
      { s: { status: "stopped", exec: null }, c: { status: "crashed", exec: null } },
    );
    const text = await commands.getStatusText();
    expect(text.split("\n").find(l => l.startsWith("| instance")) ?? "")
      .toBe("| instance | Backend | Model | Context | 推理強度 | 花費 | 執行狀態 |");
    expect(text).toContain("✗ 已停止");
    expect(text).toContain("🔴 已當機");
  });
});

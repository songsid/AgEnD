import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLocale, getLocale } from "../src/locale.js";
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

function setup(models: Record<string, string>, statuses: Record<string, { status: string; exec?: string | null }>, costGuard?: object) {
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
    costGuard,
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
    expect(header).toBe("| Instance | Backend | Model | Ctx | Effort | State |");
    expect(text).not.toContain("IPC");
    expect(text).toContain("gpt-6-luna");
    expect(text).toContain("⏸ paused");
    expect(text).toContain("🔵 working");
    expect(text).toContain("✗ stopped");
    expect(text).toContain("🔴 crashed");
  });

  it("shows running (never idle or —) when execution state is unknown", async () => {
    const commands = setup(
      { u: "auto" },
      { u: { status: "running", exec: null } },
    );
    const text = await commands.getStatusText();
    const row = text.split("\n").find(l => l.includes("| u |")) ?? "";
    expect(row).toContain("🟢 running");
    expect(row).not.toContain("idle");
    expect(row).not.toContain("—");
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
    expect(text.split("\n").find(l => l.startsWith("| Agent")) ?? "")
      .toBe("| Agent | 後端 | 模型 | 上下文 | 推理強度 | 執行狀態 |");
    expect(text).toContain("✗ 已停止");
    expect(text).toContain("🔴 已當機");
  });

  it.each(["en", "zh-TW"] as const)("omits cost header and values, preserving the six remaining cells (%s)", async lang => {
    setLocale(lang);
    const commands = setup({ worker: "example-model" }, { worker: { status: "running", exec: "idle" } }, {
      isLimited: () => false, getDailyCostCents: () => 123456,
      getLimitCents: () => 500000, getFleetTotalCents: () => 123456,
    });
    const text = await commands.getStatusText(), table = text.split("\n").filter(line => line.startsWith("|"));
    const cells = (line: string) => line.split("|").slice(1, -1).map(value => value.trim());
    expect(cells(table[0])).toEqual(lang === "en"
      ? ["Instance", "Backend", "Model", "Ctx", "Effort", "State"]
      : ["Agent", "後端", "模型", "上下文", "推理強度", "執行狀態"]);
    expect(cells(table[1])).toHaveLength(6);
    expect(cells(table[2])).toHaveLength(6);
    expect(cells(table[2]).slice(0, 5)).toEqual(["worker", "codex", "example-model", "-", "-"]);
    expect(cells(table[2])[5]).toContain("🟢");
    expect(table.join("\n")).not.toMatch(/Cost|花費|\$/);
    // The existing fleet limit summary is outside the table and remains intact.
    expect(text).toContain("$1234.56 / $5000.00");
  });
});


describe("M-3425 structured web status", () => {
  it.each(["en", "zh-TW"] as const)("sends six columns without cost in %s, keeping the platform formatter unchanged", async locale => {
    setLocale(locale);
    const commands = setup({ helper: "example-model" }, { helper: { status: "running", exec: "idle" } });
    const answer = await commands.getWebReport("status");
    expect(answer.report.columns).toHaveLength(6);
    expect(answer.report.rows).toEqual([["helper", "codex", "example-model", "-", "-", expect.stringContaining(locale === "en" ? "idle" : "閒置")]]);
    expect(answer.report.columns.join(" ")).not.toMatch(/Cost|花費/);
    expect(answer.text).not.toContain("$0.00");
    expect(JSON.stringify(answer.report)).not.toMatch(/cost|Cost|花費/);
    expect(await commands.getStatusText()).not.toContain("$0.00");
  });

  it("returns the empty-state report without inventing rows", async () => {
    const answer = await new TopicCommands({} as any).getWebReport("status");
    expect(answer.report.rows).toEqual([]);
    expect(answer.report.notes).toHaveLength(1);
    expect(answer.text).not.toContain("undefined");
  });
});


it("M-3425 renders the web preference without mutating the platform locale", async () => {
  setLocale("en");
  const commands = setup({}, { helper: { status: "running", exec: "idle" } });
  expect((await commands.getWebReport("status", "zh-TW")).report.title).toBe("Fleet 狀態");
  expect(getLocale()).toBe("en");
});

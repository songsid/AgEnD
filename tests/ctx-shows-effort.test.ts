import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TopicCommands } from "../src/topic-commands.js";
import { setLocale } from "../src/locale.js";

/**
 * `/ctx` reports the reasoning effort alongside the model.
 *
 * Effort has no file the CLI writes back the way Claude's statusline reports the
 * live model, so the only honest thing to show is what we configured — and the
 * line has to say so wherever the CLI could have been re-tuned since.
 */
let dataDir: string;
const inst = "worker";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ctx-effort-"));
  mkdirSync(join(dataDir, "instances", inst), { recursive: true });
  writeFileSync(
    join(dataDir, "instances", inst, "statusline.json"),
    JSON.stringify({ context_window: { used_percentage: 20 } }),
  );
});
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); setLocale("en"); });

function commandsFor(opts: {
  backend: string;
  strategy: "runtime" | "restart" | "unsupported";
  effort: string | null;
}) {
  return new TopicCommands({
    dataDir,
    fleetConfig: { defaults: {}, instances: { [inst]: { backend: opts.backend } } },
    modelDisplayForInstance: () => "some-model",
    effortStrategyFor: () => opts.strategy,
    resolveInstanceEffort: () => ({
      effort: opts.effort,
      source: opts.effort ? "instance" : "unset",
    }),
  } as any);
}

describe("/ctx effort line", () => {
  it("prints the level for a backend that takes effort as a launch flag", async () => {
    setLocale("en");
    const text = await commandsFor({ backend: "kiro-cli", strategy: "restart", effort: "high" })
      .getCtxText(inst);

    expect(text).toContain("Effort: high");
    // A restart backend cannot be re-tuned behind our back, so no caveat.
    expect(text).not.toContain("configured —");
  });

  it("marks the level as configured for a backend the user can re-tune in its TUI", async () => {
    setLocale("en");
    const text = await commandsFor({ backend: "claude-code", strategy: "runtime", effort: "high" })
      .getCtxText(inst);

    expect(text).toContain("Effort: high");
    expect(text, "the CLI may disagree, and the line must admit it").toContain("configured");
  });

  it("says nothing for a backend that takes no effort setting", async () => {
    const text = await commandsFor({ backend: "opencode", strategy: "unsupported", effort: "high" })
      .getCtxText(inst);

    expect(text).not.toContain("Effort");
  });

  it("says nothing for antigravity, whose effort is already in the model name", async () => {
    // Printing it again would read as two independent settings.
    for (const backend of ["antigravity", "agy"]) {
      const text = await commandsFor({ backend, strategy: "restart", effort: "medium" })
        .getCtxText(inst);
      expect(text, backend).not.toContain("Effort");
    }
  });

  it("omits the line when no effort is configured, rather than showing a placeholder", async () => {
    const text = await commandsFor({ backend: "kiro-cli", strategy: "restart", effort: null })
      .getCtxText(inst);

    expect(text).not.toContain("Effort");
  });

  it("keeps the existing lines and their order", async () => {
    setLocale("en");
    const text = await commandsFor({ backend: "kiro-cli", strategy: "restart", effort: "low" })
      .getCtxText(inst);

    const lines = text.split("\n");
    expect(lines.findIndex(l => l.startsWith("Backend:"))).toBeGreaterThanOrEqual(0);
    expect(lines.findIndex(l => l.startsWith("Effort:")))
      .toBeGreaterThan(lines.findIndex(l => l.startsWith("Model:")));
    expect(lines.findIndex(l => l.startsWith("Instance:")))
      .toBeGreaterThan(lines.findIndex(l => l.startsWith("Effort:")));
  });

  it("renders in zh-TW too", async () => {
    setLocale("zh-TW");
    const text = await commandsFor({ backend: "claude-code", strategy: "runtime", effort: "high" })
      .getCtxText(inst);

    expect(text).toContain("Effort：high");
    expect(text).toContain("設定值");
  });

  it("still works when the host does not provide the effort helpers at all", async () => {
    // Older/partial contexts must not break /ctx.
    const commands = new TopicCommands({
      dataDir,
      fleetConfig: { defaults: {}, instances: { [inst]: { backend: "kiro-cli" } } },
      modelDisplayForInstance: () => "some-model",
    } as any);

    const text = await commands.getCtxText(inst);
    expect(text).toContain("Backend:");
    expect(text).not.toContain("Effort");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon, PaneStateMachine } from "../src/daemon.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const pane = (name: string): string => readFileSync(join(fixtures, name), "utf8");
const backend = new CodexBackend("/tmp/agend-codex-pane-compat");

describe("Codex 0.155/0.156 inline pane contract", () => {
  const idle155 = pane("codex-0155-inline-idle.pane.txt");
  const busy156 = pane("codex-01561-inline-busy.pane.txt");
  const resumed156 = pane("codex-01561-inline-resumed.pane.txt");

  it("accepts the live bottom prompt/footer, including the 0.156 warning badge", () => {
    expect(backend.getReadyPattern().test(idle155)).toBe(true);
    expect(backend.getReadyPattern().test(resumed156)).toBe(true);
    expect(backend.isPeriodicRedrawIdlePane(idle155)).toBe(true);
    expect(backend.isPeriodicRedrawIdlePane(resumed156)).toBe(true);
  });

  it("does not treat a historical header, context percentage, or prompt above a modal as ready", () => {
    const headerOnly = "│ >_ OpenAI Codex (v0.156.1) │\n│ model: loading │";
    const oldFooter = "› Ask Codex to do anything\n  Context 100% left\n\n  Select Model and Effort\n› 1. GPT-6-Astra\n  enter select · esc back";
    expect(backend.getReadyPattern().test(headerOnly)).toBe(false);
    expect(backend.getReadyPattern().test("Context 100% left")).toBe(false);
    expect(backend.getReadyPattern().test(oldFooter)).toBe(false);
    expect(backend.getReadyPattern().test(pane("codex-0156-resume-locked.pane.txt"))).toBe(false);
    expect(backend.isPeriodicRedrawIdlePane(oldFooter)).toBe(false);
  });

  it("keeps a real 0.156 working frame busy despite its visible input/footer", () => {
    const machine = new PaneStateMachine(backend.getReadyPattern(), 60_000, 0, backend.getBusyPattern());
    expect(backend.getBusyPattern().test(busy156)).toBe(true);
    expect(machine.observe(busy156, 1_000, { settled: true }).state).toBe("working");
    expect(backend.isPeriodicRedrawIdlePane(busy156)).toBe(false);
  });

  it("identifies only the live resume-loading frame, not its historical scrollback", () => {
    const transient = backend.getInputUnavailableTransients()[0];
    const loading = resumed156.slice(0, resumed156.indexOf("╭────────────────────────────────────────────────╮"));
    expect(transient.pattern.test(loading)).toBe(true);
    expect(transient.isActive(loading)).toBe(true);
    expect(backend.getReadyPattern().test(loading)).toBe(false);
    expect(transient.isActive(resumed156)).toBe(false);
  });

  it("does not re-answer the historical 0.155 update picker after reaching idle", () => {
    const update = backend.getRuntimeDialogs().find(dialog => dialog.description.includes("update-available picker"));
    expect(update!.pattern.test(idle155)).toBe(true);
    expect(update!.isActive?.(idle155)).toBe(false);
  });

  it("dismisses only the live canonical update picker and holds an unknown Enter-only selector", () => {
    // Daemon.dialogMatches deliberately uses isActive INSTEAD OF pattern when
    // supplied.  A pattern && isActive test would miss the production bug.
    const matches = (Daemon as unknown as {
      dialogMatches: (dialog: ReturnType<CodexBackend["getRuntimeDialogs"]>[number], pane: string) => boolean;
    }).dialogMatches;
    const liveUpdate = idle155.slice(0, idle155.indexOf("\n╭─────────────────────────────────────────────────╮"));
    const unknown = [
      "Select changed options",
      "› 1. Different model",
      "  2. Keep current model",
      "Press enter to continue",
    ].join("\n");
    for (const dialogs of [backend.getStartupDialogs(), backend.getRuntimeDialogs()]) {
      expect(dialogs.find(dialog => matches(dialog, liveUpdate))?.description).toContain("update-available picker");
      for (const pane of [unknown, `${liveUpdate}\n${unknown}`]) {
        const selected = dialogs.find(dialog => matches(dialog, pane));
        expect(selected).toMatchObject({
          description: "Codex interactive selection needs human input",
          holdOnly: true,
          blocksDelivery: true,
          inputBlocked: true,
          keys: [],
        });
      }
    }
  });

  it("pins inline mode supported by both tested CLI versions", () => {
    const cmd = backend.buildCommand({
      workingDirectory: "/tmp", instanceDir: "/tmp/agend-codex-pane-compat", instanceName: "pane-compat", mcpServers: {},
    });
    expect(cmd).toContain("--no-alt-screen");
  });

  it("holds a rate-switch picker without selecting a costly model by position", () => {
    const rate = backend.getRuntimeDialogs().find(dialog => dialog.description.includes("rate limit model switch"));
    expect(rate).toBeDefined();
    const switched = [
      "  Approaching rate limits",
      "  Switch to GPT-6-Luna for lower credit usage?",
      "› 1. Switch to GPT-6-Luna",
      "  2. Keep current model",
      "  3. Keep current model (never show again)",
      "  enter select · esc cancel",
    ].join("\n");
    expect(rate!.pattern.test(switched)).toBe(true);
    expect(rate!.isActive?.(switched)).toBe(true);
    expect(rate).toMatchObject({ holdOnly: true, blocksDelivery: true, inputBlocked: true, keys: [] });
    const history = `${switched}\n\n› Ask Codex to do anything\n  Context 100% left`;
    expect(rate!.isActive?.(history)).toBe(false);
    expect(rate!.isActive?.("  Select Model and Effort\n› 1. GPT-6-Astra\n enter select · esc back")).toBe(false);
  });

  it("holds the real 0.156 model picker and unknown numbered menus without auto-keys", () => {
    const selection = backend.getRuntimeDialogs().find(dialog => dialog.description.includes("interactive selection"));
    expect(selection).toMatchObject({ holdOnly: true, blocksDelivery: true, inputBlocked: true, keys: [] });
    expect(selection!.isActive?.(pane("codex-01561-model-picker.pane.txt"))).toBe(true);
    const active = backend.getRuntimeDialogs().filter(dialog => dialog.pattern.test(pane("codex-01561-model-picker.pane.txt"))
      && (!dialog.isActive || dialog.isActive(pane("codex-01561-model-picker.pane.txt"))));
    expect(active.map(dialog => dialog.description)).toEqual([selection!.description]);
    expect(active.every(dialog => dialog.keys.length === 0)).toBe(true);
    const historical = `${pane("codex-01561-model-picker.pane.txt")}\n\n› Ask Codex to do anything\n  Context 100% left`;
    expect(selection!.isActive?.(historical)).toBe(false);
    expect(selection!.isActive?.(idle155)).toBe(false);
    expect(selection!.isActive?.("  Select a model\n› Alternate model\n  Keep current model\n  enter select · esc back")).toBe(true);
    expect(backend.getStartupDialogs().some(dialog => dialog.description === selection!.description)).toBe(true);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
import { PaneStateMachine } from "../src/daemon.js";

const dirs: string[] = [];

function backendForStatusLine(items: string[]): CodexBackend {
  const dir = mkdtempSync(join(tmpdir(), "agend-codex-947-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.toml"), `[tui]\n"status_line" = ${JSON.stringify(items)}\n`);
  const backend = new CodexBackend(join(dir, "instance"));
  (backend as any).isolatedCodexHome = dir;
  return backend;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Codex status_line without Context (#947)", () => {
  it("accepts a live composer with a configured model status line as positive readiness proof", () => {
    // Mutation guard: removing the no-Context configured-footer proof makes
    // this valid, quoted-key status_line remain permanently not-ready.
    const backend = backendForStatusLine(["model-with-reasoning"]);
    const pane = [
      "› Ask Codex to do anything",
      "  GPT-6-Luna xhigh",
    ].join("\n");

    expect(backend.getReadyPattern().test(pane)).toBe(true);
    expect(backend.isDeliveryInputReadyPane(pane)).toBe(true);
    expect(backend.isPeriodicRedrawIdlePane(pane)).toBe(true);

    // Some valid model-with-reasoning configurations temporarily render only
    // the model token while Codex has no reasoning label available yet.
    const shortFooter = "› Ask Codex to do anything\n  gpt-5";
    expect(backend.getReadyPattern().test(shortFooter)).toBe(true);
    expect(backend.isDeliveryInputReadyPane(shortFooter)).toBe(true);
    expect(backend.isPeriodicRedrawIdlePane(shortFooter)).toBe(true);
  });

  it("requires a configured status item and its real rendered shape, not any non-empty footer", () => {
    // Mutation guard: loosening this into an arbitrary non-empty-footer rule
    // makes one or more unknown/modal/transcript-echo controls false-ready.
    const backend = backendForStatusLine(["model-with-reasoning"]);
    const composer = "› Ask Codex to do anything";

    for (const pane of [
      `${composer}\n arbitrary text`,
      `${composer}\n Waiting for approval`,
      `${composer}\n Select a model\n› 1. GPT-6-Astra`,
      `${composer}\n GPT-6-Luna xhigh\n Select Model and Effort\n› 1. GPT-6-Astra`,
      `${composer}\n› previously submitted task\n  GPT-6-Luna xhigh`,
    ]) {
      expect(backend.getReadyPattern().test(pane)).toBe(false);
      expect(backend.isDeliveryInputReadyPane(pane)).toBe(false);
      expect(backend.isPeriodicRedrawIdlePane(pane)).toBe(false);
    }

    const noStatusLine = backendForStatusLine([]);
    const unconfiguredFooter = `${composer}\n  GPT-6-Luna xhigh`;
    expect(noStatusLine.getReadyPattern().test(unconfiguredFooter)).toBe(false);
    expect(noStatusLine.isDeliveryInputReadyPane(unconfiguredFooter)).toBe(false);
  });

  it("requires the explicit Ready status when run-state is configured and still vetoes Working", () => {
    const backend = backendForStatusLine(["run-state", "model"]);
    const ready = "› Ask Codex to do anything\n  Ready · GPT-6-Luna";
    const working = "• Working (3s) · esc to interrupt\n› Ask Codex to do anything\n  Working · GPT-6-Luna";

    expect(backend.isPeriodicRedrawIdlePane(ready)).toBe(true);
    expect(backend.getReadyPattern().test(working)).toBe(false);
    expect(backend.isDeliveryInputReadyPane(working)).toBe(false);
    expect(backend.isPeriodicRedrawIdlePane(working)).toBe(false);

    const machine = new PaneStateMachine(backend.getReadyPattern(), 60_000, 0, backend.getBusyPattern());
    expect(machine.observe(working, 1_000, { settled: true }).state).toBe("working");
  });

  it("vetoes a Working marker above the empty composer when run-state is not configured", () => {
    // Mutation guard: removing the no-Context busy veto must not let a live
    // composer plus an otherwise valid footer report idle during generation.
    const backend = backendForStatusLine(["model"]);
    const working = [
      "• Working (5s • esc to interrupt)",
      "› Ask Codex to do anything",
      "  gpt-5.5",
    ].join("\n");

    expect(backend.isDeliveryInputReadyPane(working)).toBe(false);
    expect(backend.isPeriodicRedrawIdlePane(working)).toBe(false);
    const machine = new PaneStateMachine(backend.getReadyPattern(), 60_000, 0, backend.getBusyPattern());
    expect(machine.observe(working, 1_000, { settled: true }).state).toBe("working");
  });

  it("fails closed for unknown status_line items, alone or beside a known item", () => {
    // Mutation guard: treating unknown items as arbitrary text would make both
    // footer shapes below false readiness proofs.
    const composer = "› Ask Codex to do anything";
    const unknownOnly = backendForStatusLine(["my-plugin"]);
    const unknownOnlyPane = `${composer}\n  whatever`;
    expect(unknownOnly.getReadyPattern().test(unknownOnlyPane)).toBe(false);
    expect(unknownOnly.isDeliveryInputReadyPane(unknownOnlyPane)).toBe(false);
    expect(unknownOnly.isPeriodicRedrawIdlePane(unknownOnlyPane)).toBe(false);

    const mixed = backendForStatusLine(["model", "my-plugin"]);
    const mixedPane = `${composer}\n  gpt-5.5 · arbitrary text`;
    expect(mixed.getReadyPattern().test(mixedPane)).toBe(false);
    expect(mixed.isDeliveryInputReadyPane(mixedPane)).toBe(false);
    expect(mixed.isPeriodicRedrawIdlePane(mixedPane)).toBe(false);
  });
});

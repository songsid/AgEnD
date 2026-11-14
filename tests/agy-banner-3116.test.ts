import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AntigravityBackend, agyLoginScreenActive, parseAntigravityModelsOutput } from "../src/backend/antigravity.js";
import { Daemon, PaneStateMachine } from "../src/daemon.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures/agy-1.5.9-banner", name), "utf8");
const pane = fixture("announcement.pane.txt");
const b = () => new AntigravityBackend("/nonexistent-agy-3116", "/nonexistent-home", "/nonexistent-agend");
const hint = "> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)";

describe("agy 1.5.9 empty composer under announcement", () => {
  it("keeps the actual netless logged-out frame blocked and preserves restart switching", () => {
    const loggedOut = fixture("logged-out-offline.pane.txt");
    expect(agyLoginScreenActive(loggedOut)).toBe(true);
    expect(b().getReadyPattern().test(loggedOut)).toBe(false);
    expect(b().getModelSwitchStrategy()).toBe("restart");
  });
  it("parses new display names from a dynamic catalogue without a fixed model whitelist", () => {
    // Synthetic transport rows: display names from the screenshot, not claimed vendor model IDs.
    const names = ["Gemini 4 Argon", "Gemini 4 Hydrogen", "Orchestrator (Argon)", "Gemini 4 Carbon"];
    const rows = names.map((label, i) => ({ id: `fixture-model-${i}`, label }));
    expect(parseAntigravityModelsOutput(rows.map(row => `${row.id}\t${row.label}`).join("\n"))).toEqual(rows);
  });
  it("settles idle after work and passes the real delivery gate without sending Esc", () => {
    const backend = b();
    const sm = new PaneStateMachine(backend.getReadyPattern(), 15_000, 0, backend.getBusyPattern());
    sm.observe("working", 0);
    expect(sm.observe(pane, 2_000, { settled: true }).state).toBe("idle");
    const daemon = Object.create(Daemon.prototype) as any;
    daemon.backend = backend;
    expect(daemon.paneAuthoritativelyIdle(pane)).toBe(true);
    expect(sm.observe(pane, 60_000, { settled: true }).state).toBe("idle");
  });
  it("does not require a particular announcement to recognize the same empty composer", () => {
    const empty = pane.slice(pane.indexOf("─"));
    expect(b().getReadyPattern().test(empty)).toBe(true);
    expect(b().getReadyPattern().test(empty.replace(/\n/g, "\r\n"))).toBe(true);
    expect(b().getReadyPattern().test(empty.replace("Context 22% used", ""))).toBe(true);
  });
  it("a generating spinner above this composer still vetoes idle", () => {
    const busy = pane.replace(/\n─/, "\n⣯  Generating...\n─");
    const backend = b();
    expect(backend.getBusyPattern().test(busy)).toBe(true);
    const sm = new PaneStateMachine(backend.getReadyPattern(), 15_000, 0, backend.getBusyPattern());
    expect(sm.observe(busy, 0).state).toBe("working");
  });
  it.each([
    pane.replace(hint, `${hint} draft`),
    pane.replace(hint, "> Please summarize this room"),
    pane.replace(hint, `  ${hint}`),
    pane.replace("Context 22% used", "unrecognized footer"),
    pane + fixture("model-picker.pane.txt"),
    pane + "Do you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit\n↑/↓ Navigate · enter Confirm\n",
    pane.split("\n").map(row => `  ${row}`).join("\n"),
  ])("a draft, quoted composer or following dialog is not ready", input => {
    expect(b().getReadyPattern().test(input)).toBe(false);
  });
});

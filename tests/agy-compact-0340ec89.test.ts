/**
 * Board 0340ec89: an agy compact is agy's own /compact, never /clear — the web's Compact button used to wipe agy
 * conversations. Verified live on agy 1.3.6 (tests/fixtures/agy-1.3.6-compact.pane.txt); agy's release notes add it in
 * 1.3.5, so that is the floor. An agy known to be older is refused with nothing sent; one whose version is not known yet
 * gets /compact.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGY_COMPACT_MIN_VERSION, TopicCommands, compactCommandForBackend } from "../src/topic-commands.js";
import { setLocale, t } from "../src/locale.js";

afterEach(() => { setLocale("en"); });

describe("agy 1.3.6's /compact (the saved capture)", () => {
  it("summarizes the conversation in place: 'Conversation compacted · N steps summarized'", () => {
    const pane = readFileSync(new URL("./fixtures/agy-1.3.6-compact.pane.txt", import.meta.url), "utf8");
    expect(pane).toContain("Antigravity CLI 1.3.6");
    expect(pane).toMatch(/^> \/compact$/m);
    expect(pane).toContain("Conversation compacted");
    expect(pane).toMatch(/\d+ steps summarized/);
    expect(AGY_COMPACT_MIN_VERSION).toBe("1.3.5");
  });
});

describe("compactCommandForBackend", () => {
  it.each([
    ["1.3.5", "/compact"], ["1.3.6", "/compact"], ["1.3.7", "/compact"], ["1.4.0", "/compact"], ["2.0.0", "/compact"],
    ["agy 1.3.6 (build)", "/compact"], [null, "/compact"], [undefined, "/compact"], ["unknown", "/compact"],
    ["agy 1.3.5 (build)", "/compact"], ["1.3.4", null], ["agy 1.3.4", null], ["1.0.10", null], ["agy 1.2.9", null],
  ] as const)("antigravity %s → %s", (version, expected) => {
    expect(compactCommandForBackend("antigravity", version)).toBe(expected);
  });
  it("every other backend: /compact whatever version is given", () => {
    for (const b of ["claude-code", "codex", "kiro-cli", "grok", "muse", "opencode"]) expect(compactCommandForBackend(b, "0.0.1")).toBe("/compact");
  });
});

describe("the command an agy instance gets", () => {
  function rig(version: string | null) {
    const sent: Array<{ content: string }> = [];
    const commands = new TopicCommands({
      fleetConfig: { defaults: { backend: "claude-code" }, instances: { w: { backend: "antigravity" } } },
      instanceIpcClients: new Map([["w", { connected: true, send: (m: { content: string }) => { sent.push(m); return true; } }]]),
      getBackendCliVersionSnapshot: () => ({ antigravity: { version, probing: false } }),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any);
    return { commands, sent };
  }
  it.each(["1.3.5", "1.3.6"])("%s: /compact is pasted (not /clear)", async version => {
    setLocale("en");
    const r = rig(version);
    expect(r.commands.compactInstance("w")).toEqual({ sent: true, text: t("compact.sent", "/compact") });
    expect(r.sent.map(m => m.content)).toEqual(["/compact"]);
  });
  it("an agy known to be older: refused, nothing sent — never a /clear", async () => {
    setLocale("en");
    const r = rig("1.3.4");
    const answer = r.commands.compactInstance("w");
    expect(answer).toEqual({ sent: false, text: t("compact.unsupported_version", "antigravity", "1.3.4", "1.3.5") });
    expect(answer.text).toContain("nothing was sent");
    expect(r.sent).toEqual([]);
    expect(await r.commands.sendCompact("w")).toBe(answer.text);
  });
  it("version not known yet: /compact", () => {
    const r = rig(null);
    r.commands.compactInstance("w");
    expect(r.sent.map(m => m.content)).toEqual(["/compact"]);
  });
});

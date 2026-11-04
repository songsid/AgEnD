/**
 * #2981 (the user, hmsg-b2832097): a bare `/login` showed Antigravity's text. Root cause: promptLoginBackends lists every
 * installed backend it cannot sign in remotely before the chooser, and for one declared remoteLogin "unsupported"
 * (antigravity) that line was the whole ⛔ refusal `/login agy` gives — a paragraph about agy's agent CLI, to someone who
 * asked about no backend at all. Now that list line is one short host-only sentence; `/login agy` keeps the full refusal.
 * muse (no LOGIN_FLOWS entry) gets the generic no-remote line, never OpenCode's API-key sentence (f83c684b).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale, t } from "../src/locale.js";

describe("#2981: a bare /login", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `login-bare-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => { setLocale("en"); rmSync(tmpDir, { recursive: true, force: true }); });

  function setup(installed: string[]) {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: {}, instances: {} } as any;
    vi.spyOn(fm, "isCliInstalled").mockReturnValue(true);
    vi.spyOn(fm, "isCliInstalledOffLoop").mockResolvedValue(true);
    vi.spyOn(fm as any, "probeInstalledBackends").mockReturnValue(new Set(installed));
    const notifyAlert = vi.fn(async (chatId: string) => ({ messageId: "prompt-1", chatId }));
    const sendText = vi.fn().mockResolvedValue({ messageId: "m1" });
    const adapter = { id: "discord", type: "discord", notifyAlert, sendText, editMessageRemoveButtons: vi.fn() } as any;
    return { fm, notifyAlert, sendText, chat: { adapter, adapterId: "discord", chatId: "chat", threadId: "topic" } };
  }
  const said = (m: { mock: { calls: unknown[][] } }) => m.mock.calls.map((c) => String(c[1])).join("\n");

  it.each(["en", "zh-TW"])("%s: never Antigravity's refusal paragraph — one short host-only line; the chooser still posted", async (lang) => {
    setLocale(lang as "en" | "zh-TW");
    const { fm, notifyAlert, sendText, chat } = setup(["antigravity", "codex", "muse", "opencode"]);
    await fm.promptLoginBackends(chat);
    const text = said(sendText);
    const refusal = t("login.remote_unsupported_agent_cli", "antigravity", "agy");
    expect(text).not.toContain(refusal);
    expect(text).not.toContain(refusal.slice(0, 20));
    expect(text).not.toMatch(/full agent CLI|no isolated login command|完整的 agent CLI/);
    const agyLine = text.split("\n").find((l) => l.startsWith("antigravity"))!;
    expect(agyLine).toContain(t("login.host_only", "agy"));
    expect(agyLine.length).toBeLessThan(120);
    // muse: the generic line, not OpenCode's API-key sentence; opencode keeps its own.
    const museLine = text.split("\n").find((l) => l.startsWith("muse"))!;
    expect(museLine).toContain(t("login.no_remote_flow", "muse"));
    expect(museLine.toLowerCase()).not.toContain("opencode");
    expect(text.split("\n").find((l) => l.startsWith("opencode"))).toContain(t("login.unsupported", "opencode"));
    expect(notifyAlert).toHaveBeenCalledTimes(1);                                   // the chooser (codex to sign in)
  });

  it("no backend that cannot sign in remotely installed: no guidance at all, only the chooser", async () => {
    const { fm, notifyAlert, sendText, chat } = setup(["codex"]);
    await fm.promptLoginBackends(chat);
    expect(sendText).not.toHaveBeenCalled();
    expect(notifyAlert).toHaveBeenCalledTimes(1);
  });

  it("the words in both languages", () => {
    for (const lang of ["en", "zh-TW"] as const) {
      setLocale(lang);
      expect(t("login.host_only", "agy")).toContain("`agy`");
      expect(t("login.host_only", "agy")).not.toBe("login.host_only");
    }
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginController, type LoginControllerDeps, type LoginChat } from "../src/login-controller.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { registerExecutableFixture } from "./support/process-guard.js";

/**
 * M-2284 repro: the real WebTerminalSession (its own private tmux server) runs a stub `codex` that prints codex
 * 0.166's device screen byte for byte (device_code_auth.rs: ANSI blue URL/code, gray expiry, the new warning line).
 * The question: does AgEnD ever post the link and code to the chat after the device-login button?
 */
const SCREEN = "\nWelcome to Codex [v0.166.0]\n\x1b[90mOpenAI's command-line coding agent\x1b[0m\n"
  + "\nFollow these steps to sign in with ChatGPT using device code authorization:\n"
  + "\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n"
  + "\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mTEST-CODE9\x1b[0m\n"
  + "\nContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\n\n";

let dir = "";
let oldPath = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "m2284-"));
  writeFileSync(join(dir, "screen.txt"), SCREEN);
  writeFileSync(join(dir, "codex"), `#!/bin/sh\ncat '${join(dir, "screen.txt")}'\nsleep 30\n`);
  chmodSync(join(dir, "codex"), 0o755);
  registerExecutableFixture(join(dir, "codex"));
  oldPath = process.env.PATH ?? "";
  process.env.PATH = `${dir}:${oldPath}`;
});
afterAll(() => { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });

describe("codex device login on a real pane", () => {
  it.each(["telegram", "discord"] as const)("%s: the button's start posts the provider link and code", async type => {
    const sent: string[] = [];
    const adapter = { id: type, type, sendText: vi.fn(async (_c: string, text: string) => { sent.push(text); return { messageId: "m", chatId: "chat" }; }) };
    const lock = new LoginWindowLock();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deps: LoginControllerDeps = {
      logger,
      fleetConfig: () => ({ defaults: {}, instances: {}, hostname: "localhost" }) as never,
      isFleetAdmin: () => true,
      eventLog: () => ({ insert: () => {} }),
      recoverBackendInstances: async () => ({ woken: [], restarted: [], pending: [] }),
      postButtons: async () => {},
      claimWindow: backend => lock.tryClaim("web", backend),
      releaseWindow: c => { lock.release(c); },
      isClaimCurrent: c => lock.isCurrent(c),
      windowBusyMessage: () => lock.busyMessage(),
      checkAuth: async () => "invalid",
    } as LoginControllerDeps;
    const controller = new LoginController(deps);
    const chat = { adapter, adapterId: type, chatId: "chat", threadId: "topic", userId: "admin-1" } as unknown as LoginChat;
    const started = await controller.start("codex", chat, { skipAuthCheck: true });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !sent.some(s => s.includes("TEST-CODE9"))) await new Promise(r => setTimeout(r, 100));
    await controller.cancel();
    expect(started).toMatch(/codex/);
    expect(sent.join("\n")).toContain("https://auth.openai.com/codex/device");
    expect(sent.join("\n")).toContain("TEST-CODE9");
  }, 20000);
});

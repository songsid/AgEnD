import { performance } from "node:perf_hooks";
import { readFileSync, existsSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeSetupTokens, type SetupTokenOwner } from "../src/claude-setup-token.js";
import { createClaudeSetupTokenTransport } from "../src/claude-setup-token-transport.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
const controllers: ClaudeSetupTokens[] = [];
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.close(); vi.restoreAllMocks(); vi.useRealTimers(); });
it("a recorded unrecognized CLI step reaches the shared five-second failure, without exposing private output or sending a key", async () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const fixture = readFileSync(new URL("./fixtures/claude-2.1.318-onboarding-theme.pane.txt", import.meta.url), "utf8");
  let launch: any;
  const native: any = { start: vi.fn(async (opts: any) => { launch = opts; opts.onOutput(Buffer.from(fixture)); }), paneStatus: vi.fn(async () => ({ alive: true })),
    sendInput: vi.fn(), capture: vi.fn(() => { throw Error("private capture forbidden"); }), kill: vi.fn(async () => {}) };
  const transport = createClaudeSetupTokenTransport({ native, env: { PATH: "/usr/bin" } });
  const lock = new LoginWindowLock(), commit = vi.fn();
  const owner: SetupTokenOwner = { handle: "synthetic", actor: { adapterId: "host", userId: "operator" }, current: () => true };
  const controller = new ClaudeSetupTokens({ lock, metadata: () => null, transport: () => transport, commit });
  controllers.push(controller);
  const start = await controller.operation(owner, { operation: "start", profile: null, revision: 0 });
  expect(start.login.phase).toBe("waiting"); expect(lock.isHeld).toBe(true);
  expect(await transport.capture()).not.toContain("Dark mode");
  await vi.advanceTimersByTimeAsync(4999);
  expect((await controller.operation(owner, { operation: "read", id: start.login.id })).login.phase).toBe("waiting");
  await vi.advanceTimersByTimeAsync(1);
  const end = await controller.operation(owner, { operation: "read", id: start.login.id });
  expect(end.login).toMatchObject({ phase: "failed", reason: "unsupported_prompt" });
  expect(JSON.stringify(end)).not.toContain("Dark mode");
  expect(commit).not.toHaveBeenCalled(); expect(native.sendInput).not.toHaveBeenCalled(); expect(native.capture).not.toHaveBeenCalled();
  expect(native.kill).toHaveBeenCalledOnce(); expect(existsSync(launch.cwd)).toBe(false); expect(lock.isHeld).toBe(false);
});

it("the recorded 2.1.330 APC graphics query is removed before parsing the synthetic auth/code screen", async () => {
  const recording = JSON.parse(readFileSync(new URL("./fixtures/claude-2.1.330-private-auth.redacted.json", import.meta.url), "utf8"));
  const native: any = { start: vi.fn(async (opts: any) => { opts.onOutput(Buffer.from(recording.raw)); }), paneStatus: vi.fn(async () => ({ alive: true })), sendInput: vi.fn(), kill: vi.fn(async () => {}) };
  const transport = createClaudeSetupTokenTransport({ native, env: { PATH: "/usr/bin" } });
  try {
    await transport.start({ argv: ["claude", "setup-token"] }, new AbortController().signal);
    const { structuredSignInPrompt } = await import("../src/structured-signin.js");
    const view = structuredSignInPrompt("claude-code", await transport.capture());
    expect(view).toMatchObject({ phase: "code", url: "https://claude.ai/oauth/authorize?fixture=1" });
    expect(await transport.capture()).not.toContain("\x1b"); expect(native.sendInput).not.toHaveBeenCalled();
  } finally { await transport.close(); }
});

it("keeps a split opaque APC unavailable until complete and never treats its payload as visible auth", async () => {
  let output: (chunk: Buffer) => void = () => {};
  const native: any = { start: vi.fn(async (opts: any) => { output = opts.onOutput; }), paneStatus: vi.fn(async () => ({ alive: true })), sendInput: vi.fn(), kill: vi.fn(async () => {}) };
  const transport = createClaudeSetupTokenTransport({ native, env: { PATH: "/usr/bin" } });
  try {
    await transport.start({ argv: ["claude", "setup-token"] }, new AbortController().signal);
    output(Buffer.from("\x1b_Ghttps://claude.ai/oauth/authorize?hidden=1"));
    expect(await transport.capture()).toBe("Unrecognized setup-token screen");
    output(Buffer.from("\x1b\\"));
    expect(await transport.capture()).toBe("");
    output(Buffer.from("\nhttps://claude.ai/oauth/authorize?fixture=1\nPaste code here if prompted >\n"));
    expect(await transport.capture()).toBe("https://claude.ai/oauth/authorize?fixture=1\nPaste code here if prompted >");
  } finally { await transport.close(); }
});

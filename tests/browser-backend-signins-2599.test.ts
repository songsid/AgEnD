import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserBackendSignIns } from "../src/browser-backend-signins.js";
import { readPendingBackendSignIns, writePendingBackendSignIns } from "../src/backend-signin-pending.js";
import { createStructuredSignInTransport, structuredSignInEnvironment } from "../src/structured-signin-transport.js";
import type { TerminalBackend } from "../src/web-terminal.js";
import type { StructuredBackend } from "../src/structured-signin.js";

const dirs: string[] = [], coordinators: BrowserBackendSignIns[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "agend-signins-test-")); dirs.push(dir); return dir; };
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { await Promise.all(coordinators.splice(0).map(c => c.close())); vi.clearAllTimers(); vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
function rig() {
  const dir = temp(), owner = {}, other = {};
  const state = { current: true, pane: "https://auth.openai.com/codex/device\nTEST-CODE\n", auth: "invalid" as "valid" | "invalid" | "unknown" };
  const transport = { start: vi.fn(async () => {}), capture: vi.fn(async () => state.pane), status: vi.fn(async () => ({ alive: true })), write: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const installed = vi.fn(async () => ["codex", "kiro-cli", "claude-code", "antigravity"]);
  const checkAuth = vi.fn(async (_backend: StructuredBackend) => state.auth);
  const c = new BrowserBackendSignIns({ dataDir: dir, selected: ["codex", "kiro-cli", "antigravity"], current: who => who === owner && state.current, installed, checkAuth, transport: () => transport });
  coordinators.push(c);
  return { c, dir, owner, other, state, transport, installed, checkAuth };
}
it("only canonical IDs are persisted privately; existing data is never authentication proof", async () => {
  const h = rig(); await h.c.refresh(h.owner);
  const path = join(h.dir, "backend-signin-pending.json");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readPendingBackendSignIns(h.dir)).toEqual({ version: 1, selected: ["codex", "kiro-cli", "antigravity"], pending: ["codex", "kiro-cli", "antigravity"] });
  expect(() => writePendingBackendSignIns(h.dir, { version: 1, selected: ["codex;sh"] as any, pending: [] })).toThrow();
  expect(() => writePendingBackendSignIns(h.dir, { version: 1, selected: ["codex"], pending: ["claude-code"] })).toThrow();
  expect(h.c.ready).toBe(false);
  writeFileSync(path, JSON.stringify({ version: 1, selected: ["codex"], pending: [], url: "https://bad.invalid" }), { mode: 0o600 });
  const c = new BrowserBackendSignIns({ dataDir: h.dir, current: () => true, installed: h.installed, checkAuth: h.checkAuth, transport: () => h.transport }); coordinators.push(c);
  expect(c.snapshot(h.owner).pending).toEqual(["codex"]);
});
it("ignores unsafe checklist files and never follows a symlink", () => {
  const dir = temp(), target = join(dir, "target"), file = join(dir, "backend-signin-pending.json");
  writeFileSync(target, JSON.stringify({ version: 1, selected: ["codex"], pending: ["codex"] }), { mode: 0o600 });
  symlinkSync(target, file);
  expect(readPendingBackendSignIns(dir).selected).toEqual([]);
  rmSync(file); writeFileSync(file, "x".repeat(4097), { mode: 0o600 });
  expect(readPendingBackendSignIns(dir).selected).toEqual([]);
});
it("refresh probes once per explicit refresh and keeps agy console-only", async () => {
  const h = rig(); const first = await h.c.refresh(h.owner); await h.c.refresh(h.owner);
  expect(h.checkAuth).toHaveBeenCalledTimes(2); expect(first.states.antigravity).toBe("console_only");
  await expect(h.c.begin(h.owner, "antigravity")).rejects.toThrow("signin_console_only");
  expect(h.transport.start).not.toHaveBeenCalled();
  h.state.auth = "valid"; const current = await h.c.refresh(h.owner, true);
  expect(current.pending).toEqual(["antigravity"]); expect(current.ready).toBe(false);
  await h.c.skip(h.owner, "antigravity"); expect(h.c.ready).toBe(true);
});
it("duplicate begin joins the same run, owner-only hints, then skip waits for cleanup and preserves pending IDs", async () => {
  const h = rig(); const a = await h.c.begin(h.owner, "codex"); const b = await h.c.begin(h.owner, "codex");
  expect(a.login?.id).toBe(b.login?.id); expect(a.login?.code).toBe("TEST-CODE"); expect(h.transport.start).toHaveBeenCalledOnce();
  expect(() => h.c.snapshot(h.other)).toThrow("signin_session_expired");
  const close = deferred(); h.transport.close.mockReturnValue(close.promise);
  const skip = h.c.skip(h.owner, "codex"); await Promise.resolve();
  expect(h.c.ready).toBe(false); close.resolve(); const skipped = await skip;
  expect(skipped.skipped).toContain("codex"); expect(skipped.pending).toContain("codex");
  expect(readFileSync(join(h.dir, "backend-signin-pending.json"), "utf8")).not.toContain("TEST-CODE");
});
it("failed cleanup blocks replacement attempts and handoff", async () => {
  const h = rig(); await h.c.begin(h.owner, "codex"); h.transport.close.mockRejectedValue(new Error("private vendor text"));
  await expect(h.c.skip(h.owner, "codex")).rejects.toThrow("signin_cleanup_failed");
  await expect(h.c.begin(h.owner, "kiro-cli")).rejects.toThrow("signin_cleanup_failed");
  expect(await h.c.close()).toBe(false); expect(h.transport.start).toHaveBeenCalledOnce(); expect(h.c.ready).toBe(false);
});
it("a parser failure awaiting reap cannot be replaced just because its phase says failed", async () => {
  const h = rig(); const first = await h.c.begin(h.owner, "codex");
  const close = deferred(); h.transport.close.mockReturnValue(close.promise);
  h.state.pane = "\x1b";
  const poll = vi.advanceTimersByTimeAsync(500); await vi.waitFor(() => expect(h.transport.close).toHaveBeenCalled());
  const joined = await h.c.begin(h.owner, "kiro-cli"); expect(joined.login?.id).toBe(first.login?.id); expect(h.transport.start).toHaveBeenCalledOnce();
  expect(h.c.ready).toBe(false); close.resolve(); await poll;
});
it("revocation during installed probe cannot create a login child", async () => {
  const h = rig(), installed = deferred<string[]>(); h.installed.mockReturnValue(installed.promise);
  const begin = h.c.begin(h.owner, "codex"); h.state.current = false; installed.resolve(["codex"]);
  await expect(begin).rejects.toThrow("signin_session_expired"); expect(h.transport.start).not.toHaveBeenCalled();
});

it.each([{ values: [] }, { values: ["kiro-cli"] }])("a held auth refresh follows the new checklist, never persisting stale IDs: $values", async ({ values }) => {
  const h = rig(), auth = deferred<"invalid">(); h.checkAuth.mockReturnValueOnce(auth.promise);
  const refresh = h.c.refresh(h.owner); await vi.waitFor(() => expect(h.checkAuth).toHaveBeenCalledOnce());
  const selected = h.c.select(h.owner, values); await Promise.resolve(); auth.resolve("invalid");
  const both = Promise.all([refresh, selected]); await expect(both).resolves.toHaveLength(2); const results = await both;
  for (const view of results) { expect(view.selected).toEqual(values); expect(view.pending).toEqual(values); expect(Object.keys(view.states)).toEqual(values); }
  expect(readPendingBackendSignIns(h.dir)).toEqual({ version: 1, selected: values, pending: values });
  expect((await h.c.refresh(h.owner)).pending).toEqual(values); expect(h.transport.start).not.toHaveBeenCalled();
});

it("an older invalid auth scan cannot overwrite a subsequently verified login", async () => {
  const h = rig(), auth = deferred<"invalid">(); h.checkAuth.mockReturnValueOnce(auth.promise);
  const refresh = h.c.refresh(h.owner); await vi.waitFor(() => expect(h.checkAuth).toHaveBeenCalledOnce());
  await h.c.begin(h.owner, "codex"); h.state.auth = "valid"; h.state.pane = "";
  h.transport.status.mockResolvedValue({ alive: false }); await vi.advanceTimersByTimeAsync(500);
  expect(h.c.snapshot(h.owner).login?.phase).toBe("done");
  auth.resolve("invalid"); const current = await refresh;
  expect(current.states.codex).toBe("valid"); expect(current.pending).not.toContain("codex");
  expect(readPendingBackendSignIns(h.dir).pending).not.toContain("codex");
});

it("passive refresh cannot certify the old credentials while confirmed re-login is in flight", async () => {
  const h = rig(); h.state.auth = "valid"; await h.c.select(h.owner, ["codex"]);
  const started = deferred(); h.transport.start.mockImplementation(async () => { await started.promise; h.state.auth = "invalid"; throw new Error("new login failed"); });
  const login = h.c.begin(h.owner, "codex", true); await vi.waitFor(() => expect(h.transport.start).toHaveBeenCalled());
  try {
    const during = await h.c.refresh(h.owner, true);
    expect(during.pending).toEqual(["codex"]); expect(during.states.codex).toBe("unknown");
    expect(readPendingBackendSignIns(h.dir).pending).toEqual(["codex"]);
  } finally { started.resolve(); await login; }
  const failed = h.c.snapshot(h.owner); expect(failed.login?.reason).toBe("transport_failed"); expect(failed.ready).toBe(false); expect(failed.pending).toEqual(["codex"]);
  expect((await h.c.refresh(h.owner)).pending).toEqual(["codex"]);
});

function nativeRig() {
  const native: TerminalBackend = { start: vi.fn(async () => {}), sendInput: vi.fn(async () => {}), resize: vi.fn(async () => {}), capture: vi.fn(async () => "pane"), paneStatus: vi.fn(async () => ({ alive: true })), kill: vi.fn(async () => {}) };
  const env = { HOME: temp(), PATH: "/stub/bin", LANG: "en_US.UTF-8", AGEND_INSTANCE: "live-must-not-inherit", TMUX: "live", BASH_ENV: "/unsafe", ANTHROPIC_API_KEY: "synthetic-no-credential" };
  return { native, env, transport: createStructuredSignInTransport({ native, env }) };
}
it("native adapter uses an empty private directory, unique socket, clean env and exec boundary", async () => {
  const h = nativeRig(); const abort = new AbortController();
  await h.transport.start({ argv: ["codex", "login", "--device-auth"] }, abort.signal);
  const opts = vi.mocked(h.native.start).mock.calls[0]![0];
  expect(opts.socket).toMatch(/^agend-signin-[0-9a-f]{32}$/); expect(statSync(opts.cwd).mode & 0o777).toBe(0o700);
  expect(opts.command).toContain("exec env -i"); expect(opts.command).toContain("BROWSER=false"); expect(opts.command).toContain("--device-auth");
  for (const bad of ["live-must-not-inherit", "TMUX=", "BASH_ENV", "synthetic-no-credential"]) expect(opts.command).not.toContain(bad);
  expect(structuredSignInEnvironment(h.env)).toEqual({ HOME: h.env.HOME, PATH: "/stub/bin", LANG: "en_US.UTF-8", TERM: "xterm-256color", BROWSER: "false", EDITOR: "false", VISUAL: "false" });
  await h.transport.close(); expect(h.native.kill).toHaveBeenCalledWith(opts.socket);
});
it("code bytes use the existing stdin-buffer sender, are absent from the launch argv, and abort fences Enter", async () => {
  const h = nativeRig(), abort = new AbortController(); await h.transport.start({ argv: ["claude", "auth", "login"] }, abort.signal);
  const code = ["synthetic", "code"].join("_");
  vi.mocked(h.native.sendInput).mockImplementation(async (_socket, bytes) => { if (bytes.toString().includes(code)) abort.abort(); });
  await expect(h.transport.write("\x15" + code + "\r", abort.signal)).rejects.toThrow("signin_cancelled");
  const bytes = vi.mocked(h.native.sendInput).mock.calls.map(call => call[1].toString());
  expect(bytes).toEqual(["\x15", code]); expect(JSON.stringify(vi.mocked(h.native.start).mock.calls)).not.toContain(code);
  await h.transport.close();
});
it("null native status is unknown, and a held input is reaped before cleanup returns", async () => {
  const h = nativeRig(), abort = new AbortController(); await h.transport.start({ argv: ["codex", "login", "--device-auth"] }, abort.signal);
  vi.mocked(h.native.paneStatus).mockResolvedValue(null);
  await expect(h.transport.status()).rejects.toThrow("signin_status_unknown");
  const input = deferred(); vi.mocked(h.native.sendInput).mockReturnValue(input.promise);
  const sending = h.transport.write("test", abort.signal); await Promise.resolve();
  const closing = h.transport.close(); expect(h.native.kill).not.toHaveBeenCalled(); input.resolve();
  await Promise.allSettled([sending, closing]); expect(h.native.kill).toHaveBeenCalledOnce();
});

it("agy remains console-only but an independently verified console login clears its pending hint", async () => {
  const h = rig();
  const check = vi.fn(async () => "valid" as const);
  (h.c as any).deps.checkConsoleAuth = check;
  await h.c.select(h.owner, ["antigravity"]);
  expect(h.c.snapshot(h.owner)).toMatchObject({ pending: [], states: { antigravity: "valid" } });
  expect(check).toHaveBeenCalledOnce(); expect(h.transport.start).not.toHaveBeenCalled();
  await expect(h.c.begin(h.owner, "antigravity" as any)).rejects.toThrow("signin_console_only");
});
it("console auth unknown or a held console writer cannot clear agy pending", async () => {
  const h = rig(); const lock = (h.c as any).lock;
  (h.c as any).deps.checkConsoleAuth = vi.fn(async () => "unknown");
  await h.c.select(h.owner, ["antigravity"]);
  expect(h.c.snapshot(h.owner)).toMatchObject({ pending: ["antigravity"], states: { antigravity: "console_only" } });
  const check = vi.fn(async () => "valid"); (h.c as any).deps.checkConsoleAuth = check;
  const release = lock.tryClaim("web", "antigravity"); expect(release).not.toBeNull();
  await h.c.refresh(h.owner, true);
  expect(check).not.toHaveBeenCalled(); expect(h.c.snapshot(h.owner).pending).toEqual(["antigravity"]);
  lock.release(release); await h.c.refresh(h.owner, true); expect(h.c.snapshot(h.owner).pending).toEqual([]);
});

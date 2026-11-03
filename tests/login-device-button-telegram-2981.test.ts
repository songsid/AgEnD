import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// The install session must never touch a real tmux server in unit tests.
const fakeSessions: Array<{ flow: any; events: any; started: boolean; cancelled: boolean }> = [];
// #1361: TmuxManager.socketName is null until setSocketName, so every tmux
// call below used to go to the live default server (orphaning agend-<hash>
// sessions). The suite pins a private socket AND stubs tmux behind an -L
// guard: any tmux invocation without the private -L fails loudly instead of
// reaching the live server. Removing setSocketName turns the suite red.
const TMUX_SOCKET = "agend-test-install-cli";
const tmuxGuard = vi.hoisted(() => ({ withoutL: [] as string[][] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const sessions = new Set<string>();
  const fakeChild = { stdin: { on() {}, end() {} } };
  const fakeExecFile = (file: string, args: unknown, opts: unknown, cb: unknown) => {
    const callback = (typeof opts === "function" ? opts : cb) as ((...a: any[]) => void) | undefined;
    if (file !== "tmux") return (real.execFile as any)(file, args, opts, cb);
    const argv: string[] = Array.isArray(args) ? args : [];
    if (argv[0] !== "-L" || typeof argv[1] !== "string" || argv[1].length === 0) {
      tmuxGuard.withoutL.push(argv);
      const err = new Error(`tmux without socket isolation: tmux ${argv.join(" ")}`);
      if (callback) { queueMicrotask(() => callback(err)); return fakeChild; }
      throw err;
    }
    const rest = argv.slice(2);
    const flag = (name: string) => { const i = rest.indexOf(name); return i === -1 ? undefined : rest[i + 1]; };
    const done = () => {
      if (!callback) return;
      const sub = rest[0];
      if (sub === "has-session") {
        const name = flag("-t") ?? "";
        if (sessions.has(name)) { callback(null, "", ""); return; }
        // sessionExistsStrict only treats exit 1 + this stderr as absent —
        // anything else rejects, so reproduce the real shape exactly.
        const err = Object.assign(new Error(`can't find session: ${name}`),
          { code: 1, stdout: "", stderr: `can't find session: ${name}` });
        callback(err);
        return;
      }
      if (sub === "new-session") { const name = flag("-s"); if (name) sessions.add(name); callback(null, "", ""); return; }
      if (sub === "kill-session") { const name = flag("-t"); if (name) sessions.delete(name); callback(null, "", ""); return; }
      if (sub === "kill-server") { sessions.clear(); callback(null, "", ""); return; }
      callback(null, "", "");
    };
    queueMicrotask(done);
    return fakeChild;
  };
  return { ...real, execFile: fakeExecFile };
});
vi.mock("../src/login-manager.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/login-manager.js")>();
  class FakeLoginSession {
    state = "starting";
    flow: any; events: any;
    constructor(flow: any, _tmux: any, events: any) {
      this.flow = flow; this.events = events;
      fakeSessions.push({ flow, events, started: false, cancelled: false });
    }
    async start() { fakeSessions[fakeSessions.length - 1].started = true; }
    async cancel() {
      fakeSessions[fakeSessions.length - 1].cancelled = true;
      await this.events.onDone({ ok: false, detail: "cancelled" });
    }
  }
  return { ...real, LoginSession: FakeLoginSession };
});
// The already-installed guard must not depend on what this machine has on PATH.
const installedBinaries = new Set<string>();
vi.mock("../src/instance-lifecycle.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/instance-lifecycle.js")>();
  return { ...real, checkBinaryInstalled: (binary: string) => installedBinaries.has(binary) };
});

import { FleetManager } from "../src/fleet-manager.js";
import { setLocale, t } from "../src/locale.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { setAuthCheckRunnerForTests } from "../src/login-flows.js";

/** M-2284: the codex device-login button on Telegram, from /login in General (AgEnD topic "1", flat on the wire). */
describe("Telegram codex device button reaches the sign-in", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `m2284-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    installedBinaries.clear(); installedBinaries.add("codex");
    TmuxManager.setSocketName(TMUX_SOCKET);
    setAuthCheckRunnerForTests(async () => ({ code: 1, output: "Not logged in" }));
  });
  afterEach(() => { setAuthCheckRunnerForTests(null); TmuxManager.setSocketName(null); setLocale("en"); rmSync(tmpDir, { recursive: true, force: true }); });

  it.each([["General", "1", undefined], ["a topic", "77", "77"]] as const)("from %s: press → buttons retired with 'starting', sign-in started", async (_n, logical, wire) => {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: {}, instances: {} } as any;
    vi.spyOn(fm, "isFleetAdmin").mockReturnValue(true);
    // The sign-in path under test: codex counts as installed whatever this host has on PATH (CI has none — /login
    // would install it first, #1131).
    vi.spyOn(fm, "isCliInstalled").mockReturnValue(true);
    vi.spyOn(fm, "isCliInstalledOffLoop").mockResolvedValue(true);
    const notifyAlert = vi.fn(async (chatId: string) => ({ messageId: "501", chatId, threadId: wire }));
    const sendText = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "-100" });
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "telegram", type: "telegram", notifyAlert, sendText, editMessageRemoveButtons } as any;
    const chat = { adapter, adapterId: "telegram", chatId: "-100", threadId: logical, userId: "42" };
    const first = await fm.startLoginSession("codex", chat);
    expect(first).toBeNull();
    expect(notifyAlert).toHaveBeenCalledOnce();
    const ids = (notifyAlert.mock.calls[0] as any)[1].choices.map((c: { id: string }) => c.id);
    const go = ids.find((id: string) => /:go$/.test(id))!;
    expect(Buffer.byteLength(go)).toBeLessThanOrEqual(64);
    const ctl = (fm as any).webLogin;
    const start = vi.spyOn(ctl, "start").mockResolvedValue("login started");
    const ack = vi.fn();
    // Exactly what telegram.ts builds from callback_query (message_thread_id absent for General).
    await (fm as any).receiveAdapterCallback({ callbackData: go, chatId: "-100", threadId: wire, messageId: "501", userId: "42", username: "u", ack }, "telegram", adapter, () => true);
    expect(start).toHaveBeenCalledWith("codex", expect.anything(), expect.objectContaining({ skipAuthCheck: true }));
    expect(JSON.stringify(editMessageRemoveButtons.mock.calls)).toContain(t("login.starting_backend", "codex"));
    expect(ack.mock.calls.every(c => c.length === 0 || c[0] === undefined)).toBe(true);
  });
});

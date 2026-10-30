/**
 * Log only (user, 2026-10-30, hmsg-56891567): a root user unit restarted every 15 minutes because READY never reached
 * systemd. /run/user/0, home of the user manager's notify socket, was gone (logind removes it when the last session
 * ends without linger). A failed systemd-notify, and once the fleet's start, now say why when the socket says so: a
 * filesystem socket whose file is gone gets `socketMissing: true` and a hint. An abstract socket ('@') has no file and
 * gets nothing; an existing one gets nothing. No chat, no locale, no rate change.
 *
 * Isolation: temp dirs; nothing is spawned.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSdNotifier, notifySocketProblem, reportNotifySocketAtStart } from "../src/sd-notify.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-sdn-")); dirs.push(d); return d; };
const user = userInfo().username;

describe("notifySocketProblem: exists / missing / abstract", () => {
  it("a socket whose file exists: nothing to say", () => {
    const f = join(tmp(), "notify"); writeFileSync(f, "");
    expect(notifySocketProblem(f)).toBeNull();
  });
  it("an abstract socket ('@…') has no file: nothing to say, and the file system is not asked", () => {
    const exists = vi.fn(() => false);
    expect(notifySocketProblem("@/org/freedesktop/systemd1/notify/123", exists)).toBeNull();
    expect(exists).not.toHaveBeenCalled();
  });
  it("no socket: nothing", () => { expect(notifySocketProblem(undefined)).toBeNull(); expect(notifySocketProblem("")).toBeNull(); });
  it("a user manager's socket that is gone: socketMissing and the linger hint, with that uid", () => {
    expect(notifySocketProblem("/run/user/0/systemd/notify", () => false)).toEqual({
      socketMissing: true, socket: "/run/user/0/systemd/notify",
      hint: `the user manager's notify socket is gone (/run/user/0 was removed or replaced without its systemd/ dir): systemctl restart user@0.service (recreates /run/user/0/systemd/notify); if \`loginctl show-user ${user} -p Linger\` says no, also loginctl enable-linger ${user}`,
    });
  });
  it("any other path that is gone: socketMissing and a plain hint (no linger advice for a system manager)", () => {
    const missing = join(tmp(), "gone", "notify");
    expect(notifySocketProblem(missing)).toEqual({ socketMissing: true, socket: missing, hint: `systemd's notify socket ${missing} does not exist` });
  });
  it("a check that throws says nothing rather than guessing", () => {
    expect(notifySocketProblem("/run/user/0/systemd/notify", () => { throw new Error("EACCES"); })).toBeNull();
  });
});

describe("a failed systemd-notify says why", () => {
  const failing = (socket: string, extra: Partial<Parameters<typeof createSdNotifier>[0]> = {}) => {
    const warn = vi.fn();
    const notify = createSdNotifier({
      socket, pid: () => 7, recordedPid: () => 7, warn: () => warn, now: () => 0,
      send: (_s, _sock, done) => done(Object.assign(new Error("Command failed: systemd-notify"), { code: 1 })), ...extra,
    });
    notify("READY=1");
    return warn;
  };
  it("missing socket: the failure carries socketMissing and the hint (the real file check)", () => {
    const missing = join(tmp(), "gone", "notify");
    const warn = failing(missing);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ state: "READY=1", code: 1, socketMissing: true, socket: missing,
      hint: `systemd's notify socket ${missing} does not exist` });
    expect(warn.mock.calls[0]![1]).toBe("systemd-notify failed; systemd's watchdog may not be fed");
  });
  it("existing socket: the same failure line, with no socketMissing", () => {
    const f = join(tmp(), "notify"); writeFileSync(f, "");
    const warn = failing(f);
    expect(warn.mock.calls[0]![0]).not.toHaveProperty("socketMissing");
    expect(warn.mock.calls[0]![0]).toMatchObject({ state: "READY=1", code: 1 });
  });
  it("abstract socket: no socketMissing", () => {
    expect(failing("@notify").mock.calls[0]![0]).not.toHaveProperty("socketMissing");
  });
  it("a successful ping says nothing and does not look at the socket", () => {
    const warn = vi.fn(), socketProblem = vi.fn(() => ({ socketMissing: true }));
    createSdNotifier({ socket: "/x", pid: () => 7, recordedPid: () => 7, warn: () => warn, socketProblem,
      send: (_s, _sock, done) => done(null) })("WATCHDOG=1");
    expect(warn).not.toHaveBeenCalled();
    expect(socketProblem).not.toHaveBeenCalled();
  });
});

describe("once at the fleet's start", () => {
  it("a missing socket is said once, with why", () => {
    const warn = vi.fn();
    expect(reportNotifySocketAtStart(warn, "/run/user/0/systemd/notify", s => notifySocketProblem(s, () => false))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ socketMissing: true, socket: "/run/user/0/systemd/notify" }),
      "systemd's notify socket is missing; READY and WATCHDOG cannot reach systemd");
  });
  it.each([["no socket", undefined], ["abstract", "@notify"]])("%s: nothing", (_n, socket) => {
    const warn = vi.fn();
    expect(reportNotifySocketAtStart(warn, socket)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
  it("an existing socket: nothing", () => {
    const f = join(tmp(), "notify"); writeFileSync(f, "");
    const warn = vi.fn();
    expect(reportNotifySocketAtStart(warn, f)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the fleet's own start: setSdNotifyWarn reports once", () => {
  it("with NOTIFY_SOCKET at a missing path, the first sink gets the line; a second sink does not", async () => {
    vi.resetModules();
    const missing = join(tmp(), "gone", "notify");
    const before = process.env.NOTIFY_SOCKET;
    process.env.NOTIFY_SOCKET = missing;           // read (and removed from the environment) when the module loads
    try {
      const m = await import("../src/sd-notify.js");
      const first = vi.fn(), second = vi.fn();
      m.setSdNotifyWarn(first); m.setSdNotifyWarn(second);
      expect(first).toHaveBeenCalledTimes(1);
      expect(first).toHaveBeenCalledWith(expect.objectContaining({ socketMissing: true, socket: missing }),
        "systemd's notify socket is missing; READY and WATCHDOG cannot reach systemd");
      expect(second).not.toHaveBeenCalled();
      expect(process.env.NOTIFY_SOCKET, "the capability is still taken out of the environment").toBeUndefined();
    } finally { if (before === undefined) delete process.env.NOTIFY_SOCKET; else process.env.NOTIFY_SOCKET = before; }
  });
});

describe("only a socket that is really gone is called missing", () => {
  it.runIf(typeof process.getuid === "function" && process.getuid() !== 0)("a path this process may not look into (EACCES) is not 'missing'", async () => {
    const { chmodSync } = await import("node:fs");
    const dir = tmp(), sock = join(dir, "locked", "notify");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "locked")); writeFileSync(sock, ""); chmodSync(join(dir, "locked"), 0o000);
    try { expect(notifySocketProblem(sock)).toBeNull(); } finally { chmodSync(join(dir, "locked"), 0o700); }
  });
});

describe("agend doctor's import has no side effect", () => {
  it("loading notify-socket.ts leaves NOTIFY_SOCKET in the environment (sd-notify.ts takes it out)", async () => {
    vi.resetModules();
    const before = process.env.NOTIFY_SOCKET;
    process.env.NOTIFY_SOCKET = "/run/user/0/systemd/notify";
    try {
      await import("../src/notify-socket.js");
      expect(process.env.NOTIFY_SOCKET).toBe("/run/user/0/systemd/notify");
    } finally { if (before === undefined) delete process.env.NOTIFY_SOCKET; else process.env.NOTIFY_SOCKET = before; }
  });
});

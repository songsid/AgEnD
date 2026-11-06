/**
 * M-2457 PR C §6 rule 2 (docs/design/bundled-tmux.md): the bundled tmux's server across a pin change. A server still
 * on the socket is kept when it is the recorded one from this same binary, ended by its RECORDED client when it is the
 * recorded one from another pin, ended by pid only when that pid is provably the recorded server, and otherwise the
 * fleet is held with nothing killed. Every end waits for a positive exit (pid gone AND the socket refusing).
 * Isolation: temp dirs; the real-tmux case runs on a private agend-test- socket.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DecideInputs, type ServerProbes, type ServerRecord, decideServer, holdMessage, pruneCopies, readServerRecord, realProbes,
  reconcileServer, recordServer, sha256File, socketPath, writeServerRecord,
} from "../src/tmux-server.js";

const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-tmuxsrv-")); roots.push(d); return d; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const SHA_A = "a".repeat(64), SHA_B = "b".repeat(64);
const REC: ServerRecord = { socket: "agend", binary: "/h/tmux/3.8-aaaaaaaaaaaa/bin/tmux", version: "3.8", sha256: SHA_A, serverPid: 4242, serverStart: 1_800_000_000 };
const base: DecideInputs = { socket: "agend", current: { binary: REC.binary, sha256: SHA_A }, alive: true, record: REC,
  recordedClientIntact: true, facts: { version: "3.8", pid: 4242, start: 1_800_000_000 }, recordedPidOurs: true };

describe("decideServer (pure)", () => {
  it.each<[string, Partial<DecideInputs>, string]>([
    ["no server on the socket", { alive: false, record: null }, "fresh"],
    ["the recorded server, from this same binary", {}, "same"],
    ["the recorded server, from another pin", { current: { binary: "/h/tmux/3.9-bbbbbbbbbbbb/bin/tmux", sha256: SHA_B } }, "handover"],
    ["no record, pid unknown", { record: null, recordedPidOurs: false }, "hold"],
    ["the recorded client gone, the pid provably ours", { recordedClientIntact: false, facts: null }, "pid-fallback"],
    ["the recorded client gone, the pid not ours", { recordedClientIntact: false, facts: null, recordedPidOurs: false }, "hold"],
    ["the server does not answer its own client (protocol)", { facts: { error: "protocol version mismatch" }, recordedPidOurs: false }, "hold"],
    ["another server than the recorded one", { facts: { version: "3.8", pid: 999, start: 1 }, recordedPidOurs: false }, "hold"],
    ["the record names another socket", { record: { ...REC, socket: "agend-1a2b3c" } }, "hold"],
  ])("%s → %s", (_why, over, kind) => {
    expect(decideServer({ ...base, ...over }).kind).toBe(kind);
  });

  it("a handover names the recorded client, never this start's", () => {
    expect(decideServer({ ...base, current: { binary: "/new/tmux", sha256: SHA_B } })).toEqual({ kind: "handover", client: REC.binary, pid: 4242 });
  });
});

/** Fake probes: a server that is alive until `exitsAfter` waits after the end request (Infinity = never). */
function fakes(o: { alive?: boolean; facts?: string | Error; proc?: { start: number; exe: string } | null; exitsAfter?: number } = {}) {
  const calls: string[] = [];
  let ended = false, polls = 0, t = 0;
  const gone = () => ended && polls >= (o.exitsAfter ?? 1);
  const p: ServerProbes = {
    async accepts() { return (o.alive ?? true) && !gone(); },
    async run(bin, args) {
      calls.push(`${bin} ${args.join(" ")}`);
      if (args.includes("kill-server")) { ended = true; return ""; }
      if (o.facts instanceof Error) throw o.facts;
      return o.facts ?? "3.8 4242 1800000000";
    },
    async proc() { return gone() || o.proc === null ? null : o.proc ?? { start: REC.serverStart, exe: REC.binary }; },
    kill(pid, sig) { calls.push(`kill ${sig} ${pid}`); ended = true; },
    async sleep(ms) { t += ms; if (ended) polls++; },
    now: () => t,
  };
  return { p, calls };
}

/** A home whose record names a real file (so the recorded client is intact), and a different current binary. */
function home(opts: { record?: boolean; client?: "intact" | "changed" | "gone" } = {}) {
  const h = scratch();
  const bin = join(h, "tmux", "3.8-aaaaaaaaaaaa", "bin", "tmux");
  mkdirSync(join(h, "tmux", "3.8-aaaaaaaaaaaa", "bin"), { recursive: true });
  writeFileSync(bin, "#!/bin/sh\n"); chmodSync(bin, 0o755);
  const rec = { ...REC, binary: bin, sha256: sha256File(bin) };
  if (opts.record !== false) writeServerRecord(h, rec);
  if (opts.client === "changed") writeFileSync(bin, "#!/bin/sh\necho changed\n");
  if (opts.client === "gone") rmSync(bin);
  return { h, rec, next: { binary: join(h, "tmux", "3.9-bbbbbbbbbbbb", "bin", "tmux"), sha256: SHA_B } };
}

describe("reconcileServer: the actions", () => {
  it("a pin change: kill-server from the RECORDED client, then a positive exit → go ahead", async () => {
    const { h, rec, next } = home();
    const { p, calls } = fakes({ exitsAfter: 3 });
    expect(await reconcileServer({ agendHome: h, socket: "agend", current: next, probes: p })).toBeNull();
    expect(calls).toEqual([`${rec.binary} -L agend display-message -p #{version} #{pid} #{start_time}`, `${rec.binary} -L agend kill-server`]);
  });

  it("the same server from this binary is kept: nothing ended", async () => {
    const { h, rec } = home();
    const { p, calls } = fakes();
    expect(await reconcileServer({ agendHome: h, socket: "agend", current: { binary: rec.binary, sha256: rec.sha256 }, probes: p })).toBeNull();
    expect(calls.some(c => c.includes("kill"))).toBe(false);
  });

  it("a server that does not exit in time holds the fleet (no instance starts on top of it)", async () => {
    const { h, next } = home();
    const { p } = fakes({ exitsAfter: Infinity });
    expect(await reconcileServer({ agendHome: h, socket: "agend", current: next, probes: p }))
      .toBe(holdMessage("it did not exit after kill-server from its own tmux"));
  });

  it("the recorded client changed: SIGTERM to the recorded pid only when it is provably that server", async () => {
    const { h, rec, next } = home({ client: "changed" });
    const ours = fakes({ proc: { start: REC.serverStart + 1, exe: rec.binary } });   // tmux's start_time vs the OS's: ±2 s
    expect(await reconcileServer({ agendHome: h, socket: "agend", current: next, probes: ours.p })).toBeNull();
    expect(ours.calls).toEqual(["kill SIGTERM 4242"]);
    // Started at another time (a reused pid): held, nothing killed.
    const reused = fakes({ proc: { start: REC.serverStart + 60, exe: "/somewhere/else" } });
    const hold = await reconcileServer({ agendHome: h, socket: "agend", current: next, probes: reused.p });
    expect(hold).toMatch(/can't be verified: the tmux that started it .* is missing or changed/);
    expect(reused.calls).toEqual([]);
  });

  it("no record at all: held, nothing run or killed", async () => {
    const { h, next } = home({ record: false });
    const { p, calls } = fakes();
    expect(await reconcileServer({ agendHome: h, socket: "agend", current: next, probes: p })).toBe(holdMessage("no record of the server AgEnD started"));
    expect(calls).toEqual([]);
  });

  it("no server on the socket: go ahead, nothing asked", async () => {
    const { h, next } = home();
    const { p, calls } = fakes({ alive: false });
    expect(await reconcileServer({ agendHome: h, socket: "agend", current: next, probes: p })).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("the record and the copies", () => {
  it("a malformed record is no record", () => {
    const h = scratch();
    mkdirSync(join(h, "tmux"), { recursive: true });
    for (const bad of ["{", JSON.stringify({ ...REC, sha256: "x" }), JSON.stringify({ ...REC, serverPid: 1 })]) {
      writeFileSync(join(h, "tmux", "server.json"), bad);
      expect(readServerRecord(h)).toBeNull();
    }
  });

  it("prunes copies that neither this start nor the record names; keeps both, and anything else in the folder", () => {
    const h = scratch();
    for (const n of ["3.6a-111111111111", "3.8-aaaaaaaaaaaa", "3.9-bbbbbbbbbbbb", "3.7b-222222222222"]) mkdirSync(join(h, "tmux", n, "bin"), { recursive: true });
    writeFileSync(join(h, "tmux", "agend-tmux.conf"), "x");
    const removed = pruneCopies(h, [join(h, "tmux", "3.9-bbbbbbbbbbbb", "bin", "tmux"), join(h, "tmux", "3.8-aaaaaaaaaaaa", "bin", "tmux")]);
    expect(removed.sort()).toEqual(["3.6a-111111111111", "3.7b-222222222222"]);
    expect(["3.8-aaaaaaaaaaaa", "3.9-bbbbbbbbbbbb", "agend-tmux.conf"].every(n => existsSync(join(h, "tmux", n)))).toBe(true);
  });
});

const TMUX = (() => { try { return execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim() || null; } catch { return null; } })();

describe.skipIf(!TMUX)("a real handover on a private socket", () => {
  it("records the server, then a pin change ends it through the recorded client with a positive exit", async () => {
    const h = scratch();
    const socket = `agend-test-srv-${process.pid}`;
    execFileSync(TMUX!, ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "srv", "sleep 600"]);
    try {
      const current = { binary: TMUX!, sha256: sha256File(TMUX!) };
      const rec = await recordServer({ agendHome: h, socket, current, version: "" });
      expect(rec).toMatchObject({ socket, binary: TMUX, sha256: current.sha256 });
      expect(readServerRecord(h)).toEqual(rec);
      expect(await realProbes.accepts(socketPath(socket))).toBe(true);
      // The same binary: kept.
      expect(await reconcileServer({ agendHome: h, socket, current })).toBeNull();
      expect(await realProbes.accepts(socketPath(socket))).toBe(true);
      // A new pin: ended by the recorded client; gone positively.
      expect(await reconcileServer({ agendHome: h, socket, current: { binary: "/new/pin/tmux", sha256: SHA_B } })).toBeNull();
      expect(await realProbes.accepts(socketPath(socket))).toBe(false);
      expect(await realProbes.proc(rec!.serverPid)).toBeNull();
    } finally {
      try { execFileSync(TMUX!, ["-L", socket, "kill-server"], { stdio: "ignore" }); } catch { /* gone */ }
    }
  });
});

describe("Needs-you: a tmux hold", () => {
  it("a fleet hold is one Settings-group line with the reason; an instance hold is that instance's", async () => {
    const { deriveNeedsYou } = await import("../src/needs-you.js");
    const items = deriveNeedsYou({ prompts: [], instances: [], deliveries: [], ownerOf: () => undefined,
      tmuxHolds: [{ instance: null, key: "server:1", detail: holdMessage("no record of the server AgEnD started"), since: 1 },
        { instance: "dev", key: "legacy:@3", detail: "An old tmux window for dev may still be running", since: 2 }] });
    expect(items.map(i => [i.id, i.type, i.instance, i.reason])).toEqual([
      ["tmux-hold:-:server:1", "config", "", "tmux_hold"], ["tmux-hold:dev:legacy:@3", "instance", "dev", "tmux_hold"]].sort((a, b) => (a[2]! < b[2]! ? -1 : 1)));
  });

  it("while held, TmuxManager creates no session (every way in is refused with the reason)", async () => {
    const { TmuxManager } = await import("../src/tmux-manager.js");
    TmuxManager.setHold("held for the test");
    try { await expect(TmuxManager.ensureSession("agend-test-held")).rejects.toThrow("held for the test"); }
    finally { TmuxManager.setHold(null); }
  });
});

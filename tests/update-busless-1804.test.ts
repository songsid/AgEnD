/**
 * #1804: on a host with no D-Bus user bus (no dbus-user-session), `busctl --user` cannot connect while systemd's own
 * private socket (`$XDG_RUNTIME_DIR/systemd/private`, what `systemctl` uses there) still answers. The readers then make
 * the same D-Bus calls over that socket — the same exact values (argv as `as`, environments as `as`), the same proof —
 * and every failure says which of: neither reachable, systemd does not know the unit, the call refused, not proven.
 *
 * The codec is checked against real systemd 249 bytes (tests/fixtures/systemd-249-private-socket); the worker runs
 * against a local fake server in a child process that behaves as sd-bus does at BEGIN. No systemd, no fleet.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, lstatSync as lstatSyncReal, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { activateService, readLoadedUnit } from "../src/service-activation.js";
import { busUnreachable, readSystemdRuntime } from "../src/systemd-runtime.js";
import { callPeer, peerCodec, peerEndpoint, peerReplyAsBusctl, peerRequestFor, peerUnreachable, privateSocketPath, type PeerBus } from "../src/systemd-peer-bus.js";
import { guardSystemd } from "../src/restart-guard.js";
import type { CommandResult } from "../src/update-install.js";
import { activationWorld } from "./support/activation-world-1490.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "systemd-249-private-socket", "capture.json");
const capture = JSON.parse(readFileSync(FIXTURES, "utf8")) as Record<string, { args: string[]; request: string; reply: string }>;
const NO_BUS: CommandResult = { status: 1, signal: null, stdout: "", stderr: "Failed to connect to bus: No such file or directory\n" };
const ok = (stdout = ""): CommandResult => ({ status: 0, signal: null, stdout, stderr: "" });
const json = (type: string, data: unknown) => ok(`${JSON.stringify({ type, data })}\n`);

describe("which busctl failures mean 'no bus'", () => {
  it.each([
    ["Failed to connect to bus (no user bus socket)", NO_BUS, true],
    ["busctl not spawned at all", { status: null, signal: null, stdout: "", stderr: "" }, true],
    ["a call the bus refused", { status: 1, signal: null, stdout: "", stderr: "Call failed: Unit name x is not valid.\n" }, false],
    ["busctl killed by our timeout", { status: null, signal: "SIGTERM" as NodeJS.Signals, stdout: "", stderr: "" }, false],
    ["success", ok("{}"), false],
  ])("%s → %s", (_name, result, want) => expect(busUnreachable(result)).toBe(want));
});

describe("the wire format, against real systemd 249 bytes", () => {
  const codec = peerCodec();
  it("the capture is whole", () => expect(Object.keys(capture)).toHaveLength(12));

  it("every request this client sends is byte-identical to one systemd 249 answered", () => {
    for (const { args, request } of Object.values(capture)) expect(codec.encodeCall(peerRequestFor(args)!, 1).toString("hex"), args.join(" ")).toBe(request);
  });

  const reply = (key: string) => codec.decode(Buffer.from(capture[key]!.reply, "hex"))!;
  it("argv and environments exactly as systemd holds them — what `systemctl show` cannot print", () => {
    expect(reply("execStart").values).toEqual([{ type: "a(sasbttttuii)", data: [["/bin/sl eep", ["/bin/sl eep", "a b", "c", 'd"e', "f'g", "h\\i", "%", "$$x", ";"], false, 0, 0, 0, 0, 0, 0, 0]] }]);
    expect(reply("environment").values).toEqual([{ type: "as", data: ["P=a b", 'Q=x"y', "R=z$$w", "S=t\\u", "T="] }]);
    expect(reply("unsetEnvironment").values).toEqual([{ type: "as", data: ["U=a b", "V", "W=$$x"] }]);
    // show-environment prints NODE_OPTIONS=$'--require /x.js'; the bus value is the value.
    expect((reply("managerEnvironment").values[0] as { data: string[] }).data).toEqual(expect.arrayContaining(["NODE_OPTIONS=--require /x.js", "Q=a b"]));
  });

  it("the other shapes the readers use: o, a(sb) empty and not, b, s, (uo) idle and queued, and an error", () => {
    expect(reply("loadUnit")).toMatchObject({ type: 2, replySerial: 1, signature: "o", values: ["/org/freedesktop/systemd1/unit/t_2eservice"] });
    expect(reply("environmentFilesEmpty").values).toEqual([{ type: "a(sb)", data: [] }]);
    expect(reply("environmentFiles").values).toEqual([{ type: "a(sb)", data: [["/root/x.env", false], ["/root/y.env", true]] }]);
    expect(reply("needDaemonReload").values).toEqual([{ type: "b", data: false }]);
    expect(reply("loadStateNotFound").values).toEqual([{ type: "s", data: "not-found" }]);
    expect(reply("jobIdle").values).toEqual([{ type: "(uo)", data: [0, "/"] }]);
    expect(reply("jobQueued").values).toEqual([{ type: "(uo)", data: [7, "/org/freedesktop/systemd1/job/7"] }]);
    expect(reply("unknownProperty")).toMatchObject({ type: 3, errorName: "org.freedesktop.DBus.Error.UnknownProperty", values: ["Unknown interface org.freedesktop.systemd1.Service or property NoSuchProp."] });
  });

  it("partial input waits; malformed input is refused, never guessed", () => {
    const whole = Buffer.from(capture.execStart!.reply, "hex");
    expect(codec.decode(whole.subarray(0, whole.length - 1))).toBeNull();
    const bool = Buffer.from(capture.needDaemonReload!.reply, "hex");
    bool[bool.length - 4] = 2;
    expect(() => codec.decode(bool)).toThrow(/boolean/);
    const version = Buffer.from(whole);
    version[3] = 2;
    expect(() => codec.decode(version)).toThrow(/version/);
    const string = Buffer.from(whole);
    string[string.indexOf(Buffer.from("/bin/sl eep")) + 11] = 0x41;   // the NUL after the program, overwritten
    expect(() => codec.decode(string)).toThrow();
    const load = Buffer.from(capture.loadUnit!.reply, "hex");
    const longer = Buffer.concat([load, Buffer.alloc(4)]);
    longer.writeUInt32LE(load.readUInt32LE(4) + 4, 4);               // a body longer than its signature
    expect(() => codec.decode(longer)).toThrow(/body length/);
  });

  it("as busctl --json=short prints it: a property unwrapped, a call's out-arguments as an array, errors and connect failures", () => {
    const get = capture.execStart!.args, call = capture.loadUnit!.args;
    const r = (key: string) => ({ ok: true as const, signature: reply(key).signature, values: reply(key).values });
    expect(JSON.parse(peerReplyAsBusctl(get, r("execStart"), "/s").stdout)).toEqual({ type: "a(sasbttttuii)", data: [["/bin/sl eep", ["/bin/sl eep", "a b", "c", 'd"e', "f'g", "h\\i", "%", "$$x", ";"], false, 0, 0, 0, 0, 0, 0, 0]] });
    expect(JSON.parse(peerReplyAsBusctl(call, r("loadUnit"), "/s").stdout)).toEqual({ type: "o", data: ["/org/freedesktop/systemd1/unit/t_2eservice"] });
    expect(peerReplyAsBusctl(get, { ok: false, stage: "call", message: "org.freedesktop.DBus.Error.AccessDenied: no" }, "/s")).toEqual({ status: 1, signal: null, stdout: "", stderr: "Call failed: org.freedesktop.DBus.Error.AccessDenied: no\n" });
    const refused = peerReplyAsBusctl(get, { ok: false, stage: "connect", message: "connect ENOENT /s" }, "/s");
    expect(refused.stderr).toBe("Failed to connect to /s: connect ENOENT /s\n");
    expect(peerUnreachable(refused)).toBe(true);
    expect(peerUnreachable(peerReplyAsBusctl(get, { ok: false, stage: "protocol", message: "x" }, "/s"))).toBe(false);
  });

  it("only systemd's calls are mapped; the socket is the manager's own", () => {
    expect(peerRequestFor(["call", "org.freedesktop.DBus", "/", "org.freedesktop.DBus", "Hello"])).toBeNull();
    expect(peerRequestFor(["call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "LoadUnit", "s"])).toBeNull();
    expect(privateSocketPath(true, { XDG_RUNTIME_DIR: "/run/user/0" }, 0)).toBe("/run/user/0/systemd/private");
    expect(privateSocketPath(true, {}, 1000)).toBe("/run/user/1000/systemd/private");
    expect(privateSocketPath(false, {}, 0)).toBe("/run/systemd/private");
  });
});

/**
 * A local stand-in for the manager's private socket, in a child process (the caller blocks its own thread). Like sd-bus
 * 249, it drops whatever arrives in the same read as BEGIN; it answers each captured request with its captured reply.
 */
const SERVER = String.raw`
const net = require("net"), fs = require("fs");
const [socket, fixtures, mode] = process.argv.slice(1);
const replies = new Map(Object.values(JSON.parse(fs.readFileSync(fixtures, "utf8"))).map(v => [v.request, v.reply]));
net.createServer(c => {
  let stage = "auth", buf = Buffer.alloc(0);
  c.on("error", () => {});
  c.on("data", chunk => {
    if (stage !== "call") {
      let text = chunk.toString("latin1");
      if (stage === "auth") {
        if (!/^\0AUTH EXTERNAL [0-9a-f]+\r\n/.test(text)) return c.destroy();
        if (mode === "refuse") { c.write("REJECTED EXTERNAL\r\n"); return; }
        c.write("OK 0123456789abcdef0123456789abcdef\r\n"); stage = "begin"; text = text.slice(text.indexOf("\r\n") + 2);
      }
      if (text.startsWith("BEGIN\r\n")) { stage = "call"; if (mode === "close") c.destroy(); }
      return;                                          // the rest of this read is dropped, as sd-bus does
    }
    buf = Buffer.concat([buf, chunk]);
    if (buf.length < 16) return;
    const total = Math.ceil((16 + buf.readUInt32LE(12)) / 8) * 8 + buf.readUInt32LE(4);
    if (buf.length < total) return;
    const reply = replies.get(buf.subarray(0, total).toString("hex"));
    if (!reply || mode === "silent") return;
    c.write(Buffer.from(reply, "hex"));
  });
}).listen(socket, () => process.stdout.write("ready\n"));
`;

describe("the worker: a real connection, as systemdPeerBus makes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "agend-peer-"));
  const servers: ChildProcess[] = [];
  const serve = (name: string, mode = "") => new Promise<string>((resolve, reject) => {
    const socket = join(dir, name);
    const child = spawn(process.execPath, ["-e", SERVER, socket, FIXTURES, mode], { stdio: ["ignore", "pipe", "inherit"] });
    servers.push(child);
    child.on("error", reject);
    child.stdout!.once("data", () => resolve(socket));
  });
  afterAll(() => { for (const s of servers) s.kill(); rmSync(dir, { recursive: true, force: true }); });

  it("authenticates, waits for OK before the call, and returns what busctl would print", async () => {
    const socket = await serve("ok");
    for (const key of ["loadUnit", "execStart", "managerEnvironment", "jobQueued"]) {
      const result = callPeer(true, capture[key]!.args, { socket, timeoutMs: 5000 });
      const decoded = peerCodec().decode(Buffer.from(capture[key]!.reply, "hex"))!;
      const want = key === "loadUnit" ? { type: "o", data: decoded.values } : decoded.values[0];
      expect(result.status, `${key}: ${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(want);
    }
  });

  it("an error reply is a failed call, not an unreachable socket", async () => {
    const socket = await serve("err");
    const result = callPeer(true, capture.unknownProperty!.args, { socket, timeoutMs: 5000 });
    expect(result).toMatchObject({ status: 1, stderr: "Call failed: org.freedesktop.DBus.Error.UnknownProperty: Unknown interface org.freedesktop.systemd1.Service or property NoSuchProp.\n" });
    expect(peerUnreachable(result)).toBe(false);
  });

  it("no socket, a refused authentication, a closed connection, a silent server", async () => {
    const missing = callPeer(true, capture.loadUnit!.args, { socket: join(dir, "missing"), timeoutMs: 5000 });
    expect(missing.stderr).toMatch(/^Failed to connect to .*missing: .*ENOENT/);
    expect(peerUnreachable(missing)).toBe(true);
    const refused = callPeer(true, capture.loadUnit!.args, { socket: await serve("refuse", "refuse"), timeoutMs: 5000 });
    expect(refused.stderr).toMatch(/^Failed to connect to .*: authentication refused \("REJECTED EXTERNAL"\)/);
    const closed = callPeer(true, capture.loadUnit!.args, { socket: await serve("close", "close"), timeoutMs: 5000 });
    // Closed after BEGIN: depending on timing our call meets the closed socket (write EPIPE, read ECONNRESET — seen on CI)
    // or waits for a reply that never comes. Each is a failed call after authentication, never "unreachable".
    expect(closed).toMatchObject({ status: 1, signal: null, stderr: expect.stringMatching(/^Call failed: (the connection closed before a reply|write EPIPE|read ECONNRESET)\n$/) });
    expect(peerUnreachable(closed)).toBe(false);
    const silentSocket = await serve("silent", "silent");
    const started = performance.now();
    const silent = callPeer(true, capture.loadUnit!.args, { socket: silentSocket, timeoutMs: 300 });
    expect(performance.now() - started).toBeLessThan(3000);         // bounded: the update never hangs on the socket
    expect(silent).toMatchObject({ status: null, signal: "SIGTERM", stderr: expect.stringMatching(/did not answer within 0\.3s/) });
    expect(busUnreachable(silent) || peerUnreachable(silent)).toBe(false);
  });
});

/** The #1490 world (private files, scripted manager) with busctl unable to connect; its bus answers come over `peer`. */
function buslessWorld(root: string) {
  const w = activationWorld(root);
  const peerCalls: string[] = [];
  const run = (command: string, args: string[]): CommandResult => {
    if (command === "busctl") { w.calls.push("busctl (no bus)"); return NO_BUS; }
    return w.run(command, args);
  };
  const peer: PeerBus = (user, args) => { peerCalls.push(args.at(-1)!); return w.run("busctl", [...(user ? ["--user"] : []), "--json=short", ...args]); };
  return { ...w, peerCalls, deps: { ...w.deps, run, peerBus: peer } };
}

describe("agend update on a host without a user bus", () => {
  const roots: string[] = [];
  const root = () => { const r = mkdtempSync(join(tmpdir(), "agend-busless-")); roots.push(r); return r; };
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  const manager = (w: { unitPath: string }) => ({ kind: "systemd" as const, unit: "com.agend.fleet", user: true, unitPath: w.unitPath });

  it("the loaded unit starts the verified install: the update restarts through systemd, every read over the private socket", () => {
    const w = buslessWorld(root());
    w.setRestart("restarted");
    expect(activateService(manager(w), w.verified, w.deps)).toEqual({ ok: true, via: "restart" });
    expect(w.calls).toContain("restart");
    expect(w.peerCalls).toEqual(expect.arrayContaining(["com.agend.fleet.service", "ExecStart", "Environment", "NeedDaemonReload", "MainPID"]));
    expect(w.calls).not.toContain("restore-package");
  });

  // Prism r1 P1-1: the file on disk says one thing, the manager still holds another — read from the manager, refused.
  it("systemd still holds the old ExecStart although the file is new: refused, rolled back, nothing stopped", () => {
    const w = buslessWorld(root());
    w.setRestart("restarted");
    w.setLoadedArgv([w.oldNode, w.entry, "fleet", "start"]);
    const outcome = activateService(manager(w), w.verified, w.deps) as { ok: boolean; stopped: boolean; message: string };
    expect(outcome).toMatchObject({ ok: false, stopped: false });
    expect(outcome.message).toContain(`does not start the verified install: it starts ${w.oldNode}`);
    expect(w.calls).not.toContain("restart");
    expect(w.version()).toBe("2.1.12");
  });

  // Prism r1 P1-2/P1-3: the environment is systemd's own, exactly — an unset that does not match keeps NODE_OPTIONS.
  it.each([
    ["an unset whose value differs only by $$", ["NODE_OPTIONS=--require=/x$.js"], ["NODE_OPTIONS=--require=/x$$.js"]],
    ["an unset written as show-environment prints the value", ["NODE_OPTIONS=--require /evil.js"], ["NODE_OPTIONS=$'--require /evil.js'"]],
  ])("%s: NODE_OPTIONS stays, refused", (_name, managerEnv, unset) => {
    const w = buslessWorld(root());
    w.setRestart("restarted");
    w.setManagerEnv(managerEnv);
    const peer: PeerBus = (user, args) => (args.at(-1) === "UnsetEnvironment" ? json("as", unset) : w.deps.peerBus(user, args));
    const outcome = activateService(manager(w), w.verified, { ...w.deps, peerBus: peer }) as { ok: boolean; message: string };
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("it sets NODE_OPTIONS");
    expect(w.calls).not.toContain("restart");
  });

  it("a failed restart is recovered over the private socket too: previous package and unit back, the previous service running", () => {
    const w = buslessWorld(root());
    w.setRestart("failed");
    expect(activateService(manager(w), w.verified, w.deps)).toEqual({ ok: false, stopped: false,
      message: "  ✗ Fleet restart failed. The previous package and loaded unit were restored; the previous service is running. The update did not succeed." });
    expect(w.deps.readFile(w.unitPath)).toBe(w.oldUnit);
    expect(w.version()).toBe("2.1.12");
    expect(w.state).toMatchObject({ active: "active", sub: "running", pid: 222 });
  });

  it("with the bus: unchanged — the private socket is never used", () => {
    const w = activationWorld(root());
    w.setRestart("restarted");
    const peer: PeerBus = () => { throw Error("the private socket must not be used when busctl reaches the bus"); };
    expect(activateService(manager(w), w.verified, { ...w.deps, peerBus: peer })).toEqual({ ok: true, via: "restart" });
  });
});

describe("the four reasons stay apart", () => {
  const PATH = "/org/freedesktop/systemd1/unit/com_2eagend_2efleet_2eservice";
  const unreachable: PeerBus = () => ({ status: 1, signal: null, stdout: "", stderr: "Failed to connect to /run/user/0/systemd/private: connect ENOENT /run/user/0/systemd/private\n" });
  it("1. neither busctl nor the private socket reaches the manager", () => {
    expect(readLoadedUnit(() => NO_BUS, true, "com.agend.fleet", unreachable)).toEqual({ ok: false,
      reason: "neither busctl nor the systemd --user manager's private socket can be reached (busctl exited 1: Failed to connect to bus: No such file or directory; exited 1: Failed to connect to /run/user/0/systemd/private: connect ENOENT /run/user/0/systemd/private)" });
  });
  it("2. systemd does not know the unit (LoadState=not-found), on either channel", () => {
    const answer = (args: string[]): CommandResult => (args.includes("LoadUnit") ? json("o", [PATH]) : args.at(-1) === "LoadState" ? json("s", "not-found") : { status: 1, signal: null, stdout: "", stderr: "Call failed\n" });
    expect(readLoadedUnit(() => NO_BUS, true, "com.agend.fleet", (_u, args) => answer(args))).toEqual({ ok: false, reason: "systemd does not know com.agend.fleet.service" });
    expect(readLoadedUnit((_c, args) => answer(args.slice(2)), true, "com.agend.fleet")).toEqual({ ok: false, reason: "systemd does not know com.agend.fleet.service" });
  });
  it("3. the call is refused on a reachable channel: no fallback", () => {
    const peerCalls: string[] = [];
    const peer: PeerBus = (_u, args) => { peerCalls.push(args[0]!); return NO_BUS; };
    expect(readLoadedUnit(() => ({ status: 1, signal: null, stdout: "", stderr: "Call failed: Access denied\n" }), true, "com.agend.fleet", peer))
      .toEqual({ ok: false, reason: "busctl could not load com.agend.fleet.service (exited 1: Call failed: Access denied)" });
    expect(peerCalls).toEqual([]);
    const refusing: PeerBus = () => ({ status: 1, signal: null, stdout: "", stderr: "Call failed: org.freedesktop.DBus.Error.AccessDenied: no\n" });
    expect(readLoadedUnit(() => NO_BUS, true, "com.agend.fleet", refusing)).toEqual({ ok: false,
      reason: "the D-Bus user bus cannot be reached (busctl exited 1: Failed to connect to bus: No such file or directory), and systemd could not load com.agend.fleet.service over its private socket (exited 1: Call failed: org.freedesktop.DBus.Error.AccessDenied: no)" });
  });
  it("4. reachable but not proven: the bus path's own reasons (here EnvironmentFile=)", () => {
    const answers: Record<string, CommandResult> = {
      ExecStart: json("a(sasbttttuii)", [["/n", ["/n", "/c", "fleet", "start"], false, 0, 0, 0, 0, 0, 0, 0]]),
      EnvironmentFiles: json("a(sb)", [["/root/x.env", false]]),
    };
    const peer: PeerBus = (_u, args) => (args.includes("LoadUnit") ? json("o", [PATH]) : answers[args.at(-1)!] ?? { status: 1, signal: null, stdout: "", stderr: "Call failed\n" });
    expect(readLoadedUnit(() => NO_BUS, true, "com.agend.fleet", peer)).toEqual({ ok: false, reason: "it reads EnvironmentFile=, whose effect cannot be proven here" });
  });
  it("a LoadUnit reply that is not a unit's object path is a refused call on either channel", () => {
    const notAUnit = () => json("o", ["/org/freedesktop/systemd1"]);
    expect(readLoadedUnit(notAUnit, true, "com.agend.fleet")).toMatchObject({ ok: false, reason: expect.stringMatching(/^busctl could not load com\.agend\.fleet\.service \(exited 0: .*"\/org\/freedesktop\/systemd1"\]/) });
    expect(readLoadedUnit(() => NO_BUS, true, "com.agend.fleet", notAUnit)).toMatchObject({ ok: false, reason: expect.stringMatching(/could not load com\.agend\.fleet\.service over its private socket/) });
  });
  it("and with no private socket offered, a host without a bus is refused, saying so", () => {
    expect(readLoadedUnit(() => NO_BUS, true, "com.agend.fleet")).toEqual({ ok: false,
      reason: "the D-Bus user bus cannot be reached (busctl exited 1: Failed to connect to bus: No such file or directory), and systemd's private socket was not tried" });
  });
});

describe("runtime state and agend restart's guard over the private socket", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  const world = () => { const r = mkdtempSync(join(tmpdir(), "agend-busless-")); roots.push(r); return buslessWorld(r); };

  it("readSystemdRuntime: the same evidence, a queued job included; none without a private socket", () => {
    const w = world();
    expect(readSystemdRuntime(w.deps.run, true, "com.agend.fleet", w.deps.peerBus)).toEqual({ active: "active", sub: "running", pid: 111, control: 0, job: 0, type: "notify", killMode: "mixed", sendSigkill: true });
    w.state.job = 7;
    expect(readSystemdRuntime(w.deps.run, true, "com.agend.fleet", w.deps.peerBus)?.job).toBe(7);
    expect(readSystemdRuntime(w.deps.run, true, "com.agend.fleet")).toBeNull();
  });

  it("guardSystemd: allowed over the private socket, refused without one", () => {
    const w = world();
    w.setLoadedArgv([w.newNode, w.entry, "fleet", "start"]);       // the world's old Node went with the old package
    const expected = { node: w.newNode, entry: w.entry };
    const deps = { realpath: w.deps.realpath, isExecutable: w.deps.isExecutable };
    expect(guardSystemd(w.deps.run, true, "com.agend.fleet", expected, deps, w.deps.peerBus)).toEqual({ ok: true });
    expect(guardSystemd(w.deps.run, true, "com.agend.fleet", expected, deps)).toMatchObject({ ok: false, reason: expect.stringMatching(/private socket was not tried/) });
  });
});

/**
 * A METHOD_RETURN as systemd would send it (little-endian, reply serial 1), for values no capture holds. Supports the
 * shapes these tests need: s o g b u i t, arrays, structs, variants ({ type, data }).
 */
function encodeReply(signature: string, values: unknown[]): Buffer {
  const bytes: number[] = [];
  const ALIGN: Record<string, number> = { y: 1, b: 4, u: 4, i: 4, t: 8, s: 4, o: 4, g: 1, v: 1, a: 4, "(": 8 };
  const pad = (n: number) => { while (bytes.length % n) bytes.push(0); };
  const u32 = (n: number) => { pad(4); const b = Buffer.alloc(4); b.writeUInt32LE(n); bytes.push(...b); };
  const end = (sig: string, i: number): number => sig[i] === "a" ? end(sig, i + 1) : sig[i] === "(" ? (() => { let j = i + 1; while (sig[j] !== ")") j = end(sig, j); return j + 1; })() : i + 1;
  const split = (sig: string) => { const out: string[] = []; for (let i = 0; i < sig.length;) { const e = end(sig, i); out.push(sig.slice(i, e)); i = e; } return out; };
  const write = (type: string, value: unknown): void => {
    pad(ALIGN[type[0]!]!);
    switch (type[0]) {
      case "b": u32(value ? 1 : 0); return;
      case "u": u32(value as number); return;
      case "i": { const b = Buffer.alloc(4); b.writeInt32LE(value as number); bytes.push(...b); return; }
      case "t": { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value as number)); bytes.push(...b); return; }
      case "s": case "o": { const b = Buffer.from(value as string, "utf8"); u32(b.length); bytes.push(...b, 0); return; }
      case "g": { const b = Buffer.from(value as string, "ascii"); bytes.push(b.length, ...b, 0); return; }
      case "v": { const v = value as { type: string; data: unknown }; write("g", v.type); write(v.type, v.data); return; }
      case "a": {
        u32(0); const at = bytes.length - 4; pad(ALIGN[type[1]!]!); const start = bytes.length;
        for (const item of value as unknown[]) write(type.slice(1), item);
        const n = bytes.length - start; bytes[at] = n & 255; bytes[at + 1] = (n >> 8) & 255; bytes[at + 2] = (n >> 16) & 255; bytes[at + 3] = n >>> 24; return;
      }
      case "(": split(type.slice(1, -1)).forEach((t, k) => write(t, (value as unknown[])[k])); return;
      default: throw Error(`encodeReply: ${type}`);
    }
  };
  split(signature).forEach((t, k) => write(t, values[k]));
  const body = Buffer.from(bytes);
  bytes.length = 0;
  bytes.push(0x6c, 2, 1, 1); u32(body.length); u32(2); u32(0);
  pad(8); bytes.push(5); write("g", "u"); u32(1);                       // REPLY_SERIAL 1
  pad(8); bytes.push(8); write("g", "g"); write("g", signature);        // SIGNATURE
  const fields = bytes.length - 16; bytes[12] = fields & 255; bytes[13] = (fields >> 8) & 255;
  pad(8);
  return Buffer.concat([Buffer.from(bytes), body]);
}

describe("Prism r2 P1-1: a leading U+FEFF is part of a string", () => {
  const codec = peerCodec();
  it("encodeReply round-trips through the codec (control for the helper)", () => {
    expect(codec.decode(encodeReply("v", [{ type: "as", data: ["a", "b c"] }]))).toMatchObject({ type: 2, replySerial: 1, signature: "v", values: [{ type: "as", data: ["a", "b c"] }] });
  });
  it("kept in a scalar and inside argv; invalid UTF-8 still refused", () => {
    expect(codec.decode(encodeReply("v", [{ type: "s", data: "\uFEFFfleet" }]))!.values).toEqual([{ type: "s", data: "\uFEFFfleet" }]);
    expect(codec.decode(encodeReply("v", [{ type: "as", data: ["\uFEFF/x/cli.js", "fleet"] }]))!.values).toEqual([{ type: "as", data: ["\uFEFF/x/cli.js", "fleet"] }]);
    const bad = encodeReply("v", [{ type: "s", data: "ab" }]);
    bad[bad.length - 3] = 0xff;                                           // "a" → an invalid UTF-8 byte
    expect(() => codec.decode(bad)).toThrow();
  });

  /** The whole path: the decoded reply, as busctl JSON, into readLoadedUnit and agend restart's guard. */
  const guardOver = (argv: string[]) => {
    const PATH = "/org/freedesktop/systemd1/unit/com_2eagend_2efleet_2eservice";
    const replies: Record<string, Buffer> = {
      ExecStart: encodeReply("v", [{ type: "a(sasbttttuii)", data: [[argv[0], argv, false, 0, 0, 0, 0, 0, 0, 0]] }]),
      Environment: encodeReply("v", [{ type: "as", data: ["PATH=/usr/bin"] }]),
      EnvironmentFiles: encodeReply("v", [{ type: "a(sb)", data: [] }]),
      PassEnvironment: encodeReply("v", [{ type: "as", data: [] }]),
      UnsetEnvironment: encodeReply("v", [{ type: "as", data: [] }]),
      NeedDaemonReload: encodeReply("v", [{ type: "b", data: false }]),
      LoadState: encodeReply("v", [{ type: "s", data: "loaded" }]),
    };
    const peer: PeerBus = (_u, args) => {
      if (args.includes("LoadUnit")) return json("o", [PATH]);
      const m = codec.decode(replies[args.at(-1)!] ?? replies.Environment!)!;
      return peerReplyAsBusctl(args, { ok: true, signature: m.signature, values: m.values }, "/s");
    };
    const real = (p: string) => p;
    return guardSystemd(() => NO_BUS, true, "com.agend.fleet", { node: "/verified/node", entry: "/verified/dist/cli.js" }, { realpath: real, isExecutable: () => true }, peer);
  };
  it("a BOM'd entry or argument is not the verified one: refused; the exact argv: allowed", () => {
    expect(guardOver(["/verified/node", "/verified/dist/cli.js", "fleet", "start"])).toEqual({ ok: true });
    expect(guardOver(["/verified/node", "\uFEFF/verified/dist/cli.js", "fleet", "start"])).toMatchObject({ ok: false, reason: expect.stringMatching(/starts \uFEFF\/verified\/dist\/cli\.js, not/) });
    expect(guardOver(["/verified/node", "/verified/dist/cli.js", "\uFEFFfleet", "start"])).toMatchObject({ ok: false, reason: expect.stringMatching(/its arguments are/) });
  });
});

describe("Prism r2 P2-1: only root's or this user's socket is systemd's", () => {
  type Fake = { uid: number; mode: number; kind: "dir" | "sock" | "link" };
  const fs = (tree: Record<string, Fake>, euid: number, links: Record<string, string> = {}) => ({
    euid,
    realpath: (p: string) => links[p] ?? p,
    lstat: (p: string) => {
      const f = tree[p];
      if (!f) throw Object.assign(Error(`ENOENT: no such file or directory, lstat '${p}'`), { code: "ENOENT" });
      return { uid: f.uid, mode: f.mode, isSocket: () => f.kind === "sock", isDirectory: () => f.kind === "dir", isSymbolicLink: () => f.kind === "link" };
    },
  });
  const root = (mode = 0o755): Fake => ({ uid: 0, mode, kind: "dir" });
  const base = { "/": root(), "/run": root(), "/run/user": root() };

  it.each([
    ["root's manager: /run/user/0/systemd/private", { ...base, "/run/user/0": root(0o700), "/run/user/0/systemd": root(), "/run/user/0/systemd/private": { uid: 0, mode: 0o755, kind: "sock" } }, 0, "/run/user/0/systemd/private", null],
    ["a user's manager: its own 0700 directory", { ...base, "/run/user/1000": { uid: 1000, mode: 0o700, kind: "dir" }, "/run/user/1000/systemd": { uid: 1000, mode: 0o755, kind: "dir" }, "/run/user/1000/systemd/private": { uid: 1000, mode: 0o755, kind: "sock" } }, 1000, "/run/user/1000/systemd/private", null],
    ["the system manager, as a user", { "/": root(), "/run": root(), "/run/systemd": root(), "/run/systemd/private": { uid: 0, mode: 0o777, kind: "sock" } }, 1000, "/run/systemd/private", null],
    ["under a root sticky /tmp, in our own directory", { "/": root(), "/tmp": root(0o1777), "/tmp/x": { uid: 1000, mode: 0o700, kind: "dir" }, "/tmp/x/s": { uid: 1000, mode: 0o755, kind: "sock" } }, 1000, "/tmp/x/s", null],
  ])("%s → trusted, connected at that path", (_n, tree, euid, socket, want) => expect(peerEndpoint(socket, fs(tree as Record<string, Fake>, euid))).toEqual(want === null ? { ok: true, path: socket } : want));

  it.each([
    ["another user's socket", { ...base, "/run/user/1001": { uid: 1001, mode: 0o700, kind: "dir" }, "/run/user/1001/systemd": { uid: 1001, mode: 0o755, kind: "dir" }, "/run/user/1001/systemd/private": { uid: 1001, mode: 0o755, kind: "sock" } }, 1000, "/run/user/1001/systemd/private", /^\/run\/user\/1001\/systemd\/private is owned by uid 1001, neither root nor 1000$/],
    ["another user's socket in our own directory", { ...base, "/run/user/1000": { uid: 1000, mode: 0o700, kind: "dir" }, "/run/user/1000/s": { uid: 1001, mode: 0o755, kind: "sock" } }, 1000, "/run/user/1000/s", /^\/run\/user\/1000\/s is owned by uid 1001/],
    ["a sticky world-writable directory of ours (not root's)", { "/": root(), "/shared": { uid: 1000, mode: 0o1777, kind: "dir" }, "/shared/s": { uid: 1000, mode: 0o755, kind: "sock" } }, 1000, "/shared/s", /^\/shared is writable by others \(mode 1777\)$/],
    ["a protected directory under an open one", { "/": root(), "/scratch": root(0o777), "/scratch/mine": { uid: 1000, mode: 0o700, kind: "dir" }, "/scratch/mine/s": { uid: 1000, mode: 0o755, kind: "sock" } }, 1000, "/scratch/mine/s", /^\/scratch is writable by others \(mode 777\)$/],
    ["our socket in another user's directory", { ...base, "/run/user/1001": { uid: 1001, mode: 0o755, kind: "dir" }, "/run/user/1001/s": { uid: 1000, mode: 0o755, kind: "sock" } }, 1000, "/run/user/1001/s", /\/run\/user\/1001 is owned by uid 1001/],
    ["a group-writable directory of ours", { ...base, "/run/user/1000": { uid: 1000, mode: 0o770, kind: "dir" }, "/run/user/1000/s": { uid: 1000, mode: 0o755, kind: "sock" } }, 1000, "/run/user/1000/s", /writable by others \(mode 770\)/],
    ["a world-writable directory without the sticky bit", { "/": root(), "/scratch": root(0o777), "/scratch/s": { uid: 1000, mode: 0o755, kind: "sock" } }, 1000, "/scratch/s", /writable by others \(mode 777\)/],
    ["a sticky directory not owned by root", { "/": root(), "/shared": { uid: 1001, mode: 0o1777, kind: "dir" }, "/shared/s": { uid: 1000, mode: 0o755, kind: "sock" } }, 1000, "/shared/s", /owned by uid 1001/],
    ["a symlink where the socket should be", { ...base, "/run/user/1000": { uid: 1000, mode: 0o700, kind: "dir" }, "/run/user/1000/s": { uid: 1000, mode: 0o777, kind: "link" } }, 1000, "/run/user/1000/s", /is not a socket/],
    ["no socket", { ...base }, 1000, "/run/user/1000/s", /ENOENT/],
  ])("%s → refused before connecting", (_n, tree, euid, socket, reason) => {
    const endpoint = peerEndpoint(socket, fs(tree as Record<string, Fake>, euid));
    expect(endpoint.ok).toBe(false);
    expect((endpoint as { reason: string }).reason).toMatch(reason);
  });

  it("a directory reached through a symlink is judged where it really is", () => {
    const tree = { ...base, "/run/user/1000": { uid: 1000, mode: 0o700, kind: "dir" as const }, "/home": root(), "/home/evil": { uid: 1001, mode: 0o755, kind: "dir" as const }, "/home/evil/s": { uid: 1000, mode: 0o755, kind: "sock" as const } };
    expect(peerEndpoint("/run/user/1000/link/s", fs(tree, 1000, { "/run/user/1000/link": "/home/evil" }))).toEqual({ ok: false, reason: "/home/evil is owned by uid 1001, neither root nor 1000" });
  });

  // Prism r3: the path checked is the path connected — resolved once, never the original alias again.
  it("an alias through an open directory is judged, and connected, at its canonical path", () => {
    const tree = { ...base, "/scratch": root(0o777), "/run/user/1000": { uid: 1000, mode: 0o700, kind: "dir" as const }, "/run/user/1000/systemd": { uid: 1000, mode: 0o755, kind: "dir" as const }, "/run/user/1000/systemd/private": { uid: 1000, mode: 0o755, kind: "sock" as const } };
    expect(peerEndpoint("/scratch/alias/private", fs(tree, 1000, { "/scratch/alias": "/run/user/1000/systemd" }))).toEqual({ ok: true, path: "/run/user/1000/systemd/private" });
  });

  it.each([
    ["an unresolvable directory", "/gone/private", /ENOENT|no such/],
    ["a trailing slash", "/run/user/1000/", /does not name a socket/],
    ["a relative path", "run/user/1000/systemd/private", /not an absolute path/],
  ])("%s → refused", (_n, socket, reason) => {
    const deps = { ...fs({ ...base }, 1000), realpath: (p: string) => { if (p.startsWith("/gone")) throw Error(`ENOENT: no such file or directory, realpath '${p}'`); return p; } };
    const endpoint = peerEndpoint(socket, deps);
    expect(endpoint.ok).toBe(false);
    expect((endpoint as { reason: string }).reason).toMatch(reason);
  });

  it("live: a listening socket in a directory others can write is refused before any connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-peer-open-"));
    const open = join(dir, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const accepted: import("node:net").Socket[] = [];
    const server = createServer(socket => { accepted.push(socket); });
    await new Promise<void>(resolve => server.listen(join(open, "private"), resolve));
    try {
      const result = callPeer(true, capture.loadUnit!.args, { socket: join(open, "private"), timeoutMs: 2000 });
      expect(result.stderr).toMatch(/not systemd's own socket \(.*open is writable by others \(mode 777\)\)/);
      expect(peerUnreachable(result)).toBe(true);
      chmodSync(open, 0o755);                                              // control: the same socket, protected
      expect(callPeer(true, capture.loadUnit!.args, { socket: join(open, "private"), timeoutMs: 300 }).stderr).not.toMatch(/not systemd's own socket/);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(accepted).toHaveLength(1);                                    // only the control connected
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Prism r3: a symlink retargeted after the check cannot move the connection", () => {
  const listen = async (path: string) => {
    const accepted: import("node:net").Socket[] = [];
    const server = createServer(socket => { accepted.push(socket); });
    await new Promise<void>(resolve => server.listen(path, resolve));
    return { accepted, close: async () => { for (const s of accepted) s.destroy(); await new Promise(resolve => server.close(resolve)); } };
  };
  const real = { lstat: (p: string) => lstatSyncReal(p), realpath: (p: string) => realpathSync(p), euid: process.geteuid?.() ?? 0 };

  it("the alias resolves to A, is retargeted to B mid-check: A is connected, B never", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agend-peer-alias-")));
    const a = join(dir, "a"), b = join(dir, "b"), open = join(dir, "open");
    for (const d of [a, b]) mkdirSync(d, { mode: 0o700 });
    mkdirSync(open); chmodSync(open, 0o777);
    const link = join(open, "link");
    symlinkSync(a, link);
    const serverA = await listen(join(a, "private")), serverB = await listen(join(b, "private"));
    try {
      const racing = { ...real, realpath: (p: string) => { const r = realpathSync(p); if (p === link) { unlinkSync(link); symlinkSync(b, link); } return r; } };
      const result = callPeer(true, capture.loadUnit!.args, { socket: join(link, "private"), timeoutMs: 300, endpoint: racing });
      expect(result.stderr).not.toMatch(/not systemd's own socket/);           // A passed the check, and A was dialled
      expect(realpathSync(link)).toBe(b);                                     // the alias really points at B now
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(serverA.accepted).toHaveLength(1);
      expect(serverB.accepted).toHaveLength(0);
      // controls: the protected endpoint directly, and through the (now B) alias without a race
      callPeer(true, capture.loadUnit!.args, { socket: join(a, "private"), timeoutMs: 300, endpoint: real });
      callPeer(true, capture.loadUnit!.args, { socket: join(link, "private"), timeoutMs: 300, endpoint: real });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect([serverA.accepted.length, serverB.accepted.length]).toEqual([2, 1]);
      // a dangling alias: unresolvable, refused
      unlinkSync(link); symlinkSync(join(dir, "gone"), link);
      const dangling = callPeer(true, capture.loadUnit!.args, { socket: join(link, "private"), timeoutMs: 300, endpoint: real });
      expect(dangling.stderr).toMatch(/not systemd's own socket \(ENOENT/);
      expect(peerUnreachable(dangling)).toBe(true);
    } finally {
      await serverA.close(); await serverB.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

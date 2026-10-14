/**
 * #1804: systemd's private socket — `$XDG_RUNTIME_DIR/systemd/private` for a user manager, `/run/systemd/private` for
 * the system one — the manager's own peer-to-peer D-Bus endpoint, which `systemctl` uses when there is no bus (a host
 * without dbus-user-session). busctl cannot use it: it always sends Hello(), which a peer connection has no bus driver
 * to answer ("Invalid request descriptor"; busctl 249 has no way to skip it). This speaks the D-Bus wire protocol to it
 * directly — SASL EXTERNAL, then one method call, no Hello — and returns what `busctl --json=short` prints for the same
 * call, so every reader keeps the exact D-Bus values (argv as `as`, never `systemctl show`'s joined text) and the same
 * proof as on a bus.
 *
 * The update's code is synchronous, so the call runs in a worker thread while this thread waits on an Atomics flag,
 * bounded. The worker's code is this module's own function text, evaluated: nothing is loaded from disk, where npm may
 * already have put the next package (#1450 C6).
 */
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname } from "node:path";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import type { CommandResult } from "./update-install.js";

/** A busctl stand-in for systemd's private socket: busctl's arguments after `--json=short`, busctl's output. */
export type PeerBus = (user: boolean, args: string[]) => CommandResult;

export interface PeerRequest {
  path: string;
  iface: string;
  member: string;
  /** The body's signature: "" (none), "s" or "ss". */
  signature: string;
  body: string[];
}

export type PeerReply =
  | { ok: true; signature: string; values: unknown[] }
  | { ok: false; stage: "connect" | "call" | "protocol"; message: string };

/** How long one call may take, connection and authentication included. */
export const PEER_TIMEOUT_MS = 10_000;

export type PeerCodec = ReturnType<typeof peerCodecFactory>;

/**
 * The D-Bus wire format (specification, "Message Protocol"): what this client sends and reads. Self-contained, like
 * peerWorker: the worker receives it as source text.
 */
function peerCodecFactory() {
  const ALIGN: Record<string, number> = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, h: 4, s: 4, o: 4, g: 1, v: 1, a: 4, "(": 8, "{": 8 };
  /** The end of the single complete type starting at `i`. */
  const typeEnd = (sig: string, i: number): number => {
    const c = sig[i];
    if (c === undefined) throw Error(`truncated signature ${JSON.stringify(sig)}`);
    if (c === "a") return typeEnd(sig, i + 1);
    if (c === "(" || c === "{") {
      const close = c === "(" ? ")" : "}";
      let j = i + 1;
      while (sig[j] !== close) { if (j >= sig.length) throw Error(`unclosed ${c} in ${JSON.stringify(sig)}`); j = typeEnd(sig, j); }
      if (j === i + 1) throw Error(`empty struct in ${JSON.stringify(sig)}`);
      return j + 1;
    }
    if (!(c in ALIGN)) throw Error(`unsupported type ${JSON.stringify(c)}`);
    return i + 1;
  };
  const types = (sig: string): string[] => { const out: string[] = []; for (let i = 0; i < sig.length;) { const e = typeEnd(sig, i); out.push(sig.slice(i, e)); i = e; } return out; };

  function encodeCall(request: PeerRequest, serial: number): Buffer {
    const bytes: number[] = [];
    const pad = (n: number) => { while (bytes.length % n) bytes.push(0); };
    const u32 = (n: number) => { pad(4); bytes.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff); };
    const str = (s: string) => { const b = Buffer.from(s, "utf8"); u32(b.length); bytes.push(...b, 0); };
    const sig = (s: string) => { const b = Buffer.from(s, "ascii"); bytes.push(b.length, ...b, 0); };
    if (request.signature !== "" && request.signature !== "s".repeat(request.body.length)) throw Error(`unsupported call signature ${request.signature}`);
    // Body first, to know its length: every argument is a string, starting 8-aligned (the body's own offset 0).
    for (const arg of request.body) str(arg);
    const body = Buffer.from(bytes);
    bytes.length = 0;
    bytes.push(0x6c, 1, 0, 1);                                     // little-endian, METHOD_CALL, no flags, version 1
    u32(body.length); u32(serial); u32(0);                          // the field array's length, filled in below
    const fields: Array<[number, string, string]> = [
      [1, "o", request.path], [2, "s", request.iface], [3, "s", request.member], [6, "s", "org.freedesktop.systemd1"],
      ...(request.signature ? [[8, "g", request.signature] as [number, string, string]] : []),
    ];
    for (const [code, type, value] of fields) {
      pad(8); bytes.push(code); sig(type);
      if (type === "g") sig(value); else str(value);
    }
    const fieldBytes = bytes.length - 16;
    bytes[12] = fieldBytes & 0xff; bytes[13] = (fieldBytes >>> 8) & 0xff; bytes[14] = (fieldBytes >>> 16) & 0xff; bytes[15] = (fieldBytes >>> 24) & 0xff;
    pad(8);
    return Buffer.concat([Buffer.from(bytes), body]);
  }

  /** One whole message from the start of `buf`, or null if more bytes are needed. Malformed input throws. */
  function decode(buf: Buffer): { length: number; type: number; replySerial: number | null; signature: string; errorName: string | null; values: unknown[] } | null {
    if (buf.length < 16) return null;
    const le = buf[0] === 0x6c;
    if (!le && buf[0] !== 0x42) throw Error(`bad endianness byte ${buf[0]}`);
    if (buf[3] !== 1) throw Error(`unsupported protocol version ${buf[3]}`);
    const u32at = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const bodyLength = u32at(4), fieldBytes = u32at(12);
    if (bodyLength > 1 << 27 || fieldBytes > 1 << 26) throw Error("message too large");
    const bodyStart = Math.ceil((16 + fieldBytes) / 8) * 8, total = bodyStart + bodyLength;
    if (buf.length < total) return null;
    const msg = buf.subarray(0, total);
    let pos = 0;
    const align = (n: number) => {
      const next = Math.ceil(pos / n) * n;
      for (let k = pos; k < next; k++) if (msg[k] !== 0) throw Error("nonzero padding");
      pos = next;
    };
    const need = (n: number) => { if (pos + n > total) throw Error("value runs past the message"); };
    const read = (type: string): unknown => {
      const c = type[0]!;
      align(ALIGN[c] ?? 1);
      switch (c) {
        case "y": need(1); return msg[pos++];
        case "b": { need(4); const v = le ? msg.readUInt32LE(pos) : msg.readUInt32BE(pos); pos += 4; if (v > 1) throw Error(`boolean ${v}`); return v === 1; }
        case "n": { need(2); const v = le ? msg.readInt16LE(pos) : msg.readInt16BE(pos); pos += 2; return v; }
        case "q": { need(2); const v = le ? msg.readUInt16LE(pos) : msg.readUInt16BE(pos); pos += 2; return v; }
        case "i": { need(4); const v = le ? msg.readInt32LE(pos) : msg.readInt32BE(pos); pos += 4; return v; }
        case "u": case "h": { need(4); const v = le ? msg.readUInt32LE(pos) : msg.readUInt32BE(pos); pos += 4; return v; }
        case "x": { need(8); const v = le ? msg.readBigInt64LE(pos) : msg.readBigInt64BE(pos); pos += 8; return Number(v); }
        case "t": { need(8); const v = le ? msg.readBigUInt64LE(pos) : msg.readBigUInt64BE(pos); pos += 8; return Number(v); }
        case "d": { need(8); const v = le ? msg.readDoubleLE(pos) : msg.readDoubleBE(pos); pos += 8; return v; }
        case "s": case "o": {
          need(4); const n = le ? msg.readUInt32LE(pos) : msg.readUInt32BE(pos); pos += 4;
          need(n + 1); if (msg[pos + n] !== 0) throw Error("unterminated string");
          // ignoreBOM: a leading U+FEFF is part of the string (Prism r2): stripped, "\uFEFF/x/cli.js" would read as "/x/cli.js".
          const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(msg.subarray(pos, pos + n));
          if (text.includes("\0")) throw Error("NUL inside a string");
          pos += n + 1; return text;
        }
        case "g": {
          need(1); const n = msg[pos++]!; need(n + 1); if (msg[pos + n] !== 0) throw Error("unterminated signature");
          const text = msg.subarray(pos, pos + n).toString("ascii"); pos += n + 1; return text;
        }
        case "v": {
          const sig = read("g") as string;
          const inner = types(sig);
          if (inner.length !== 1) throw Error(`variant signature ${JSON.stringify(sig)}`);
          return { type: sig, data: read(sig) };
        }
        case "a": {
          need(4); const n = le ? msg.readUInt32LE(pos) : msg.readUInt32BE(pos); pos += 4;
          if (n > 1 << 26) throw Error("array too large");
          const element = type.slice(1);
          align(ALIGN[element[0]!] ?? 1);
          const end = pos + n;
          if (end > total) throw Error("array runs past the message");
          const items: unknown[] = [];
          while (pos < end) items.push(read(element));
          if (pos !== end) throw Error("array length mismatch");
          return items;
        }
        case "(": case "{": return types(type.slice(1, -1)).map(read);
        default: throw Error(`unsupported type ${JSON.stringify(c)}`);
      }
    };
    pos = 12;
    const fields = read("a(yv)") as Array<[number, { type: string; data: unknown }]>;
    align(8);
    if (pos !== bodyStart) throw Error("header length mismatch");
    const field = (code: number, type: string): unknown => {
      const f = fields.find(([c]) => c === code);
      if (!f) return null;
      if (f[1].type !== type) throw Error(`header field ${code} has type ${f[1].type}`);
      return f[1].data;
    };
    const signature = (field(8, "g") as string | null) ?? "";
    const values = types(signature).map(read);
    if (pos !== total) throw Error("body length mismatch");
    return { length: total, type: msg[1]!, replySerial: field(5, "u") as number | null, signature, errorName: field(4, "s") as string | null, values };
  }
  return { encodeCall, decode };
}

/**
 * The worker: connect, authenticate, one call, post the reply, set the flag. Self-contained — it runs from its own
 * source text, so it may use nothing from this module's scope but what it is handed.
 */
function peerWorker(require: NodeJS.Require, codecFactory: () => PeerCodec): void {
  const codec = codecFactory();
  const net = require("node:net") as typeof import("node:net");
  const { workerData } = require("node:worker_threads") as typeof import("node:worker_threads");
  const { socket, uid, request, port, flag } = workerData as {
    socket: string; uid: number; request: PeerRequest; port: import("node:worker_threads").MessagePort; flag: Int32Array;
  };
  let finished = false;
  const finish = (reply: PeerReply) => {
    if (finished) return;
    finished = true;
    port.postMessage(reply);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
    conn.destroy();
  };
  let authed = false;
  let pending = Buffer.alloc(0);
  const conn = net.createConnection(socket);
  conn.on("error", error => finish({ ok: false, stage: authed ? "protocol" : "connect", message: error.message }));
  conn.on("close", () => finish({ ok: false, stage: authed ? "protocol" : "connect", message: "the connection closed before a reply" }));
  // As systemctl does: AUTH and BEGIN together, the call only after the server's OK. systemd 249 drops bytes that
  // arrive in the same read as BEGIN — a call written right behind it is never answered.
  conn.on("connect", () => {
    conn.write(Buffer.concat([Buffer.from([0]), Buffer.from(`AUTH EXTERNAL ${Buffer.from(String(uid)).toString("hex")}\r\nBEGIN\r\n`, "ascii")]));
  });
  conn.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    try {
      if (!authed) {
        const end = pending.indexOf("\r\n");
        if (end < 0) return;
        const line = pending.subarray(0, end).toString("latin1");
        pending = pending.subarray(end + 2);
        if (!/^OK [0-9a-f]{32}$/.test(line)) return finish({ ok: false, stage: "connect", message: `authentication refused (${JSON.stringify(line.slice(0, 80))})` });
        authed = true;
        conn.write(codec.encodeCall(request, 1));
      }
      for (;;) {
        const message = codec.decode(pending);
        if (!message) return;
        pending = pending.subarray(message.length);
        if (message.replySerial !== 1) continue;                     // not ours (a signal): skip it
        if (message.type === 3) {
          const text = typeof message.values[0] === "string" ? `: ${message.values[0]}` : "";
          return finish({ ok: false, stage: "call", message: `${message.errorName ?? "error"}${text}` });
        }
        if (message.type !== 2) return finish({ ok: false, stage: "protocol", message: `unexpected message type ${message.type}` });
        return finish({ ok: true, signature: message.signature, values: message.values });
      }
    } catch (error) {
      finish({ ok: false, stage: "protocol", message: error instanceof Error ? error.message : String(error) });
    }
  });

}

/** The codec the worker uses, for tests. */
export const peerCodec = (): PeerCodec => peerCodecFactory();

/** busctl arguments → the method call: `call <dest> <path> <iface> <member> [<sig> <args…>]` or `get-property <dest> <path> <iface> <prop>`. */
export function peerRequestFor(args: string[]): PeerRequest | null {
  if (args[0] === "call" && args[1] === "org.freedesktop.systemd1" && args.length >= 5) {
    const [, , path, iface, member, signature = "", ...body] = args as [string, string, string, string, string, string?, ...string[]];
    return signature === "s".repeat(body.length) ? { path, iface, member, signature, body } : null;
  }
  if (args[0] === "get-property" && args[1] === "org.freedesktop.systemd1" && args.length === 5) {
    return { path: args[2]!, iface: "org.freedesktop.DBus.Properties", member: "Get", signature: "ss", body: [args[3]!, args[4]!] };
  }
  return null;
}

/** A reply as `busctl --json=short` prints it: a call's out-arguments as an array, a property's variant unwrapped. */
export function peerReplyAsBusctl(args: string[], reply: PeerReply, socket: string): CommandResult {
  if (!reply.ok) {
    return { status: 1, signal: null, stdout: "", stderr: reply.stage === "connect" ? `Failed to connect to ${socket}: ${reply.message}\n` : `Call failed: ${reply.message}\n` };
  }
  if (args[0] === "get-property") {
    const variant = reply.values[0] as { type?: unknown; data?: unknown } | undefined;
    if (reply.signature !== "v" || !variant || typeof variant.type !== "string") return { status: 1, signal: null, stdout: "", stderr: `Call failed: Get returned ${reply.signature}\n` };
    return { status: 0, signal: null, stdout: `${JSON.stringify({ type: variant.type, data: variant.data })}\n`, stderr: "" };
  }
  return { status: 0, signal: null, stdout: `${JSON.stringify({ type: reply.signature, data: reply.values })}\n`, stderr: "" };
}

/** Where the manager's private socket is. */
export function privateSocketPath(user: boolean, env: NodeJS.ProcessEnv = process.env, uid: number = process.getuid?.() ?? 0): string {
  return user ? `${env.XDG_RUNTIME_DIR || `/run/user/${uid}`}/systemd/private` : "/run/systemd/private";
}

export interface EndpointDeps {
  lstat(path: string): Pick<Stats, "uid" | "mode" | "isSocket" | "isDirectory" | "isSymbolicLink">;
  realpath(path: string): string;
  euid: number;
}

/**
 * Prism r2/r3: whose server answers. SASL EXTERNAL proves who WE are; systemctl separately accepts only a peer running
 * as root or as itself (bus_check_peercred). Node cannot read a unix socket's peer credentials, so the same boundary is
 * established from ownership instead: only root or this user can have bound the socket when the socket itself is owned
 * by one of them, and every directory above it is owned by one of them and writable by no one else (a root-owned
 * sticky directory such as /tmp excepted: no one else can replace an entry in it).
 *
 * The path is resolved ONCE, here: the canonical socket path (its directory's realpath + its own name) is the one
 * checked and the one returned for connecting — never the original, whose symlinks someone else could retarget between
 * the check and the connect (r3). Every component of the canonical path is then a real directory nobody but root or
 * this user can change. Anything unknown or unresolvable is refused.
 */
export function peerEndpoint(socket: string, deps: EndpointDeps): { ok: true; path: string } | { ok: false; reason: string } {
  const trusted = (uid: number) => uid === 0 || uid === deps.euid;
  const refuse = (reason: string) => ({ ok: false as const, reason });
  try {
    if (!socket.startsWith("/")) return refuse(`${socket} is not an absolute path`);
    const name = basename(socket);
    if (!name || name === "." || name === ".." || socket.endsWith("/")) return refuse(`${socket} does not name a socket`);
    const parent = deps.realpath(dirname(socket));
    if (!parent.startsWith("/")) return refuse(`${dirname(socket)} resolves to ${parent}, not an absolute path`);
    const path = parent === "/" ? `/${name}` : `${parent}/${name}`;
    const own = deps.lstat(path);
    if (!own.isSocket()) return refuse(`${path} is not a socket`);
    if (!trusted(own.uid)) return refuse(`${path} is owned by uid ${own.uid}, neither root nor ${deps.euid}`);
    for (let dir = parent; ; dir = dirname(dir)) {
      const st = deps.lstat(dir);
      if (!st.isDirectory()) return refuse(`${dir} is not a directory`);
      if (!trusted(st.uid)) return refuse(`${dir} is owned by uid ${st.uid}, neither root nor ${deps.euid}`);
      const othersWrite = (st.mode & 0o022) !== 0, sticky = (st.mode & 0o1000) !== 0;
      if (othersWrite && !(sticky && st.uid === 0)) return refuse(`${dir} is writable by others (mode ${(st.mode & 0o7777).toString(8)})`);
      if (dir === "/") return { ok: true, path };
    }
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
}

/** One call over a private socket, synchronously, bounded. `socket`/`timeoutMs`/`endpoint` are for tests. */
export function callPeer(user: boolean, args: string[], opts: { socket?: string; timeoutMs?: number; endpoint?: EndpointDeps } = {}): CommandResult {
  const request = peerRequestFor(args);
  if (!request) return { status: 2, signal: null, stdout: "", stderr: `unsupported call ${args.slice(0, 2).join(" ")}\n` };
  const named = opts.socket ?? privateSocketPath(user);
  const endpoint = peerEndpoint(named, opts.endpoint ?? { lstat: path => lstatSync(path), realpath: path => realpathSync(path), euid: process.geteuid?.() ?? 0 });
  if (!endpoint.ok) return { status: 1, signal: null, stdout: "", stderr: `Failed to connect to ${named}: not systemd's own socket (${endpoint.reason})\n` };
  const socket = endpoint.path;                                        // the checked path, and only it, is connected
  const timeoutMs = opts.timeoutMs ?? PEER_TIMEOUT_MS;
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  let worker: Worker;
  try {
    worker = new Worker(`(${peerWorker.toString()})(require, ${peerCodecFactory.toString()})`, {
      eval: true, workerData: { socket, uid: process.getuid?.() ?? 0, request, port: port2, flag }, transferList: [port2],
    });
  } catch (error) {
    port1.close();
    return { status: null, signal: null, stdout: "", stderr: `the private-socket worker did not start: ${error instanceof Error ? error.message : String(error)}\n` };
  }
  worker.unref();
  Atomics.wait(flag, 0, 0, timeoutMs);
  const received = receiveMessageOnPort(port1);
  port1.close();
  void worker.terminate();
  if (!received) return { status: null, signal: "SIGTERM", stdout: "", stderr: `${socket} did not answer within ${timeoutMs / 1000}s\n` };
  return peerReplyAsBusctl(args, received.message as PeerReply, socket);
}

/** The production PeerBus: the manager's own private socket. */
export const systemdPeerBus: PeerBus = (user, args) => callPeer(user, args);

/** The private socket could not be reached or authenticated to (not: the call failed). */
export const peerUnreachable = (result: CommandResult): boolean =>
  result.signal === null && result.status !== 0 && /^Failed to connect to /m.test(result.stderr);

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { acceptWebSocket, isWebSocketUpgrade, type WsConnection } from "../src/ws-server.js";

/**
 * The hand-rolled RFC 6455 server subset is exercised against a REAL client
 * (Node's built-in WebSocket, undici) for the happy paths, and against raw
 * sockets for the malformed frames a browser would never send.
 */
const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();               // a raw client left open would otherwise hold close() forever
    await new Promise(r => s.close(() => r(null)));
  }
});

async function startEcho(maxPayload?: number, extra: { maxFramesPerSecond?: number; maxBufferedBytes?: number } = {}): Promise<{ port: number; conns: WsConnection[]; errors: Array<{ code: number; reason: string }>; received: Array<string | Buffer> }> {
  const conns: WsConnection[] = [];
  const errors: Array<{ code: number; reason: string }> = [];
  const received: Array<string | Buffer> = [];
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on("upgrade", (req, socket, head) => {
    const ws = acceptWebSocket(req, socket as Socket, head, { maxPayload, ...extra });
    if (!ws) return;
    conns.push(ws);
    ws.on("protocolError", (e: { code: number; reason: string }) => errors.push(e));
    ws.on("message", (data: Buffer | string, isBinary: boolean) => { received.push(data); ws.send(isBinary ? (data as Buffer) : `echo:${data as string}`); });
    ws.on("error", () => { /* raw-socket tests tear down abruptly */ });
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, conns, errors, received };
}

function client(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("client failed"));
  });
}
function nextMessage(ws: WebSocket): Promise<string | ArrayBuffer> {
  return new Promise(resolve => { ws.onmessage = ev => resolve(ev.data as string | ArrayBuffer); });
}
function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise(resolve => { ws.onclose = ev => resolve({ code: ev.code, reason: ev.reason }); });
}

/** Build a client frame by hand (masked unless told otherwise). */
function frame(opcode: number, payload: Buffer, opts: { fin?: boolean; mask?: boolean; rsv?: number } = {}): Buffer {
  const fin = opts.fin ?? true;
  const mask = opts.mask ?? true;
  const b0 = (fin ? 0x80 : 0) | ((opts.rsv ?? 0) << 4) | opcode;
  let header: Buffer;
  if (payload.length < 126) header = Buffer.from([b0, (mask ? 0x80 : 0) | payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = b0; header[1] = (mask ? 0x80 : 0) | 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = b0; header[1] = (mask ? 0x80 : 0) | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(payload.length, 6); }
  if (!mask) return Buffer.concat([header, payload]);
  const key = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3];
  return Buffer.concat([header, key, masked]);
}

/** Raw handshake, returns the socket after 101 and a promise of the close frame code the server sends. */
async function rawClient(port: number): Promise<{ socket: Socket; closeCode: () => Promise<number> }> {
  const socket = netConnect(port, "127.0.0.1");
  sockets.push(socket);
  await new Promise<void>(r => socket.once("connect", () => r()));
  socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
  const head = await new Promise<Buffer>(r => socket.once("data", (d: Buffer | string) => r(Buffer.isBuffer(d) ? d : Buffer.from(d))));
  expect(head.toString()).toMatch(/^HTTP\/1\.1 101/);
  expect(head.toString()).toContain("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");   // RFC 6455 §1.3 sample key
  // Walk the (unmasked, <126-byte) server frames — pongs may precede the Close.
  const closeCode = () => new Promise<number>(resolve => {
    const chunks: Buffer[] = [];
    const onData = (d: Buffer) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      let i = 0;
      while (i + 2 <= buf.length) {
        const opcode = buf[i] & 0x0f;
        const len = buf[i + 1] & 0x7f;
        if (opcode === 0x8) {
          if (i + 4 <= buf.length) { socket.off("data", onData); resolve(buf.readUInt16BE(i + 2)); }
          return;
        }
        i += 2 + len;
      }
    };
    socket.on("data", onData);
  });
  return { socket, closeCode };
}

describe("ws-server: handshake", () => {
  it("accepts a valid upgrade and rejects malformed ones with 400", async () => {
    const { port } = await startEcho();
    const ws = await client(port);
    ws.close();
    await closed(ws);
    // Bad key → 400, socket closed by server.
    const socket = netConnect(port, "127.0.0.1"); sockets.push(socket);
    await new Promise<void>(r => socket.once("connect", () => r()));
    socket.write("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: short\r\nSec-WebSocket-Version: 13\r\n\r\n");
    const reply = await new Promise<Buffer>(r => socket.once("data", (d: Buffer | string) => r(Buffer.isBuffer(d) ? d : Buffer.from(d))));
    expect(reply.toString()).toMatch(/^HTTP\/1\.1 400/);
  });

  it("isWebSocketUpgrade requires version 13 and a 16-byte key", () => {
    const mk = (h: Record<string, string>) => ({ method: "GET", headers: h }) as never;
    expect(isWebSocketUpgrade(mk({ upgrade: "websocket", connection: "keep-alive, Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" }))).toBe(true);
    expect(isWebSocketUpgrade(mk({ upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "8" }))).toBe(false);
    expect(isWebSocketUpgrade(mk({ upgrade: "h2c", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" }))).toBe(false);
  });
});

describe("ws-server: real client round trips", () => {
  it("echoes text, binary, a 126..65535 length frame, and answers ping", async () => {
    const { port, conns } = await startEcho(70_000);
    const ws = await client(port);
    ws.send("hi");
    expect(await nextMessage(ws)).toBe("echo:hi");
    ws.send(new Uint8Array([1, 2, 3, 250]));
    const bin = await nextMessage(ws);
    expect(Array.from(new Uint8Array(bin as ArrayBuffer))).toEqual([1, 2, 3, 250]);
    const big = "x".repeat(60_000);
    ws.send(big);
    expect(await nextMessage(ws)).toBe(`echo:${big}`);
    // Server-initiated ping is answered by the client; our parser must accept the pong silently.
    conns[0].ping(Buffer.from("p"));
    ws.send("after-ping");
    expect(await nextMessage(ws)).toBe("echo:after-ping");
    ws.close(1000, "bye");
    const c = await closed(ws);
    expect(c.code).toBe(1000);
  });

  it("server-initiated close reaches the client with code and reason", async () => {
    const { port, conns } = await startEcho();
    const ws = await client(port);
    ws.send("x"); await nextMessage(ws);
    const c = closed(ws);
    conns[0].close(4000, "replaced");
    expect(await c).toEqual({ code: 4000, reason: "replaced" });
    expect(conns[0].closed).toBe(true);
  });

  it("closes with 1009 when a data frame exceeds maxPayload", async () => {
    const { port, errors } = await startEcho(64);
    const ws = await client(port);
    const c = closed(ws);
    ws.send("y".repeat(65));
    expect((await c).code).toBe(1009);
    expect(errors[0]).toMatchObject({ code: 1009 });
  });
});

describe("ws-server: malformed frames a browser never sends", () => {
  it("unmasked client frame → 1002", async () => {
    const { port } = await startEcho();
    const { socket, closeCode } = await rawClient(port);
    const code = closeCode();
    socket.write(frame(0x1, Buffer.from("hi"), { mask: false }));
    expect(await code).toBe(1002);
  });
  it("reserved bits set → 1002", async () => {
    const { port } = await startEcho();
    const { socket, closeCode } = await rawClient(port);
    const code = closeCode();
    socket.write(frame(0x1, Buffer.from("hi"), { rsv: 4 }));
    expect(await code).toBe(1002);
  });
  it("fragmented data frame → 1003 (fragmentation unsupported by design)", async () => {
    const { port } = await startEcho();
    const { socket, closeCode } = await rawClient(port);
    const code = closeCode();
    socket.write(frame(0x1, Buffer.from("part"), { fin: false }));
    expect(await code).toBe(1003);
  });
  it("continuation frame → 1003", async () => {
    const { port } = await startEcho();
    const { socket, closeCode } = await rawClient(port);
    const code = closeCode();
    socket.write(frame(0x0, Buffer.from("part")));
    expect(await code).toBe(1003);
  });
  it("unknown opcode → 1002", async () => {
    const { port } = await startEcho();
    const { socket, closeCode } = await rawClient(port);
    const code = closeCode();
    socket.write(frame(0x3, Buffer.from("x")));
    expect(await code).toBe(1002);
  });
  it("control frame longer than 125 bytes → 1002", async () => {
    const { port } = await startEcho(70_000);
    const { socket, closeCode } = await rawClient(port);
    const code = closeCode();
    socket.write(frame(0x9, Buffer.alloc(126, 1)));
    expect(await code).toBe(1002);
  });
  it("64-bit length with high word set → 1009 before any allocation", async () => {
    const { port } = await startEcho();
    const { socket, closeCode } = await rawClient(port);
    const code = closeCode();
    const header = Buffer.from([0x82, 0x80 | 127, 0, 0, 0, 1, 0, 0, 0, 0, 1, 2, 3, 4]);
    socket.write(header);
    expect(await code).toBe(1009);
  });
  it("invalid UTF-8 in a text frame → 1007", async () => {
    const { port } = await startEcho();
    const { socket, closeCode } = await rawClient(port);
    const code = closeCode();
    socket.write(frame(0x1, Buffer.from([0xff, 0xfe, 0x41])));
    expect(await code).toBe(1007);
  });
  it("B3: after a protocol failure nothing more is delivered, and the inbound buffer stays bounded under a flood", async () => {
    const { port, conns, received } = await startEcho();
    const { socket } = await rawClient(port);
    socket.write(frame(0x1, Buffer.from([0xff, 0xfe])));       // invalid UTF-8 → 1007, closing
    await new Promise(r => setTimeout(r, 50));
    expect(conns[0].closed).toBe(true);
    for (let i = 0; i < 50; i++) socket.write(frame(0x2, Buffer.from("STILL-ACCEPTED?")));
    await new Promise(r => setTimeout(r, 100));
    expect(received).toHaveLength(0);
    expect(conns[0].pendingInboundBytes).toBeLessThanOrEqual(14 + 125);
  });

  it("B3: after WE close (replacement), the peer's frames are ignored and a non-Close flood destroys the socket with nothing retained", async () => {
    const { port, conns, received } = await startEcho();
    const { socket } = await rawClient(port);
    conns[0].close(4000, "replaced");
    await new Promise(r => setTimeout(r, 20));
    socket.write(frame(0x2, Buffer.alloc(3000, 1)));            // one late oversized chunk
    await new Promise(r => setTimeout(r, 50));
    expect(received).toHaveLength(0);
    expect(conns[0].pendingInboundBytes).toBe(0);
  });

  it("B4: a ping flood counts against the frame rate and is closed with 1008", async () => {
    const { port } = await startEcho(undefined, { maxFramesPerSecond: 10 });
    const { socket, closeCode } = await rawClient(port);
    const code = closeCode();
    for (let i = 0; i < 20; i++) socket.write(frame(0x9, Buffer.from("p")));
    expect(await code).toBe(1008);
  });

  it("M3: two legitimate frames coalesced in one TCP chunk above maxPayload are NOT misjudged as too large", async () => {
    const { port, received } = await startEcho(4096);
    const { socket } = await rawClient(port);
    const a = frame(0x2, Buffer.alloc(3000, 0x61));
    const b = frame(0x2, Buffer.alloc(3000, 0x62));
    socket.write(Buffer.concat([a, b]));
    await new Promise(r => setTimeout(r, 100));
    expect(received).toHaveLength(2);
  });

  it("M3: Close frame conformance — 1-byte payload and invalid status codes are 1002, bad UTF-8 reason is 1007", async () => {
    for (const [payload, expected] of [
      [Buffer.from([0x03]), 1002],
      [Buffer.from([0x03, 0xed]), 1002],                     // 1005 may not be sent on the wire
      [Buffer.from([0x00, 0x64]), 1002],                     // 100
      [Buffer.from([0x03, 0xe8, 0xff, 0xfe]), 1007],         // 1000 + invalid UTF-8 reason
    ] as Array<[Buffer, number]>) {
      const { port } = await startEcho();
      const { socket, closeCode } = await rawClient(port);
      const code = closeCode();
      socket.write(frame(0x8, payload));
      expect(await code).toBe(expected);
    }
  });

  it("M2: a slow consumer is dropped with 1008 instead of growing the socket queue without bound", async () => {
    // Deterministic: a fake socket whose writable queue never drains.
    const { EventEmitter } = await import("node:events");
    const { WsConnection } = await import("../src/ws-server.js");
    const fake = Object.assign(new EventEmitter(), {
      writableLength: 0, destroyed: false, writable: true,
      setNoDelay() {},
      write(buf: Buffer) { this.writableLength += buf.length; return this.writableLength < 16_384; },
      end() { this.destroyed = true; },
      destroy() { this.destroyed = true; },
    });
    const conn = new WsConnection(fake as never, Buffer.alloc(0), { maxBufferedBytes: 10_000 });
    const errors: Array<{ code: number }> = [];
    conn.on("protocolError", (e: { code: number }) => errors.push(e));
    let sent = 0;
    for (let i = 0; i < 200 && conn.send(Buffer.alloc(1000, 1)); i++) sent++;
    expect(sent).toBe(9);                                       // 9 KB queued, the 10th would cross 10 KB
    expect(conn.closed).toBe(true);
    expect(errors[0]).toMatchObject({ code: 1008 });
    expect(fake.writableLength).toBeLessThan(10_000 + 200);     // 9 frames + the Close frame, nothing more
    expect(conn.send("after")).toBe(false);
  });

  it("a peer that vanishes (half-close) is reported as 1006 and the server side is released", async () => {
    const { port, conns } = await startEcho();
    const { socket } = await rawClient(port);
    const closedCode = new Promise<number>(r => conns[0].on("close", (code: number) => r(code)));
    socket.end();                                   // FIN without a close frame
    expect(await closedCode).toBe(1006);
    expect(conns[0].closed).toBe(true);
  });

  it("a frame split across TCP chunks is reassembled", async () => {
    const { port } = await startEcho();
    const { socket } = await rawClient(port);
    const f = frame(0x1, Buffer.from("split"));
    const reply = new Promise<Buffer>(resolve => {
      const chunks: Buffer[] = [];
      socket.on("data", (d: Buffer | string) => { chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)); const b = Buffer.concat(chunks); if (b.length >= 2 + (b[1] & 0x7f)) resolve(b); });
    });
    socket.write(f.subarray(0, 3));
    await new Promise(r => setTimeout(r, 20));
    socket.write(f.subarray(3));
    const r = await reply;
    expect(r[0]).toBe(0x81);                       // FIN + text, unmasked (server → client)
    expect(r.subarray(2).toString()).toBe("echo:split");
  });
});

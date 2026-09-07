/**
 * Minimal RFC 6455 WebSocket *server* side, for the web terminal.
 *
 * Deliberately a subset — one trusted browser client per connection, small
 * frames, no extensions, no fragmentation — so the whole attack surface fits
 * on one screen and there is no npm dependency to pin or audit:
 *   - handshake: Upgrade + Sec-WebSocket-Key → Sec-WebSocket-Accept (SHA-1)
 *   - client frames must be masked (1002 otherwise), RSV bits must be zero
 *   - no fragmentation: a continuation frame or a data frame without FIN → 1003
 *   - payload above `maxPayload` → 1009; invalid UTF-8 in a text frame → 1007
 *   - ping answered with pong; close answered with close, then the socket ends
 *   - no extension or subprotocol is ever negotiated (headers are ignored)
 *
 * Verified against Node's built-in (undici) WebSocket client in the tests.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_PAYLOAD = 4096;
const CLOSE_GRACE_MS = 1_000;

export const enum Opcode {
  Continuation = 0x0,
  Text = 0x1,
  Binary = 0x2,
  Close = 0x8,
  Ping = 0x9,
  Pong = 0xa,
}

export interface WsServerOptions {
  /** Largest accepted client payload in bytes (control frames are capped at 125 by the RFC). */
  maxPayload?: number;
}

/** True when the request is a syntactically valid WebSocket upgrade for version 13. */
export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  const connection = String(req.headers.connection ?? "").toLowerCase();
  const key = String(req.headers["sec-websocket-key"] ?? "");
  const version = String(req.headers["sec-websocket-version"] ?? "");
  return req.method === "GET"
    && upgrade === "websocket"
    && connection.split(/\s*,\s*/).includes("upgrade")
    && version === "13"
    && /^[A-Za-z0-9+/]{22}==$/.test(key)
    && Buffer.from(key, "base64").length === 16;
}

/** Refuse an upgrade with a plain HTTP response and close the socket. */
export function rejectUpgrade(socket: Socket, status: number, reason: string): void {
  if (socket.destroyed) return;
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + "Connection: close\r\n"
    + "Content-Type: text/plain; charset=utf-8\r\n"
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + "\r\n"
    + body,
  );
}

/**
 * Complete the handshake and return the connection, or reject with 400 and
 * return null. `head` is whatever the client already sent after the request.
 */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  opts: WsServerOptions = {},
): WsConnection | null {
  if (!isWebSocketUpgrade(req)) {
    rejectUpgrade(socket, 400, "Bad WebSocket handshake");
    return null;
  }
  const accept = createHash("sha1")
    .update(`${String(req.headers["sec-websocket-key"])}${GUID}`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n"
    + "Upgrade: websocket\r\n"
    + "Connection: Upgrade\r\n"
    + `Sec-WebSocket-Accept: ${accept}\r\n`
    + "\r\n",
  );
  return new WsConnection(socket, head, opts);
}

export class WsConnection extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxPayload: number;
  private closeSent = false;
  private closeReceived = false;
  private closedEmitted = false;
  private closeTimer: NodeJS.Timeout | null = null;
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly socket: Socket, head: Buffer, opts: WsServerOptions) {
    super();
    this.maxPayload = opts.maxPayload ?? DEFAULT_MAX_PAYLOAD;
    socket.setNoDelay(true);
    socket.on("data", chunk => this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on("error", err => this.emit("error", err));
    // The peer half-closed (browser tab killed, network gone). http upgraded
    // sockets allow half-open, so without this the server side would linger
    // and hold server.close() open.
    socket.on("end", () => { this.closeReceived = true; this.socket.end(); this.emitClosed(1006, "connection lost"); });
    socket.on("close", () => this.emitClosed(1006, "connection lost"));
    if (head.length > 0) this.onData(head);
  }

  get closed(): boolean { return this.closeSent || this.closeReceived || this.socket.destroyed; }

  /** Send a text (string) or binary (Buffer) message. Returns false once closing. */
  send(data: string | Buffer): boolean {
    if (this.closed) return false;
    const opcode = Buffer.isBuffer(data) ? Opcode.Binary : Opcode.Text;
    const payload: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    return this.writeFrame(opcode, payload);
  }

  ping(payload: Buffer = Buffer.alloc(0)): boolean {
    if (this.closed) return false;
    return this.writeFrame(Opcode.Ping, payload.subarray(0, 125));
  }

  /** Start the closing handshake; the socket is destroyed when the peer echoes or after a grace period. */
  close(code = 1000, reason = ""): void {
    if (this.closeSent) return;
    this.closeSent = true;
    const reasonBuf = Buffer.from(reason, "utf8").subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this.writeFrame(Opcode.Close, payload);
    if (this.closeReceived) {
      this.socket.end();
      return;
    }
    this.closeTimer = setTimeout(() => this.socket.destroy(), CLOSE_GRACE_MS);
    this.closeTimer.unref?.();
  }

  private writeFrame(opcode: Opcode, payload: Buffer): boolean {
    if (this.socket.destroyed) return false;
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }
    return this.socket.write(Buffer.concat([header, payload]));
  }

  private fail(code: number, reason: string): void {
    this.emit("protocolError", { code, reason });
    this.close(code, reason);
  }

  private onData(chunk: Buffer): void {
    if (this.closeReceived) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    // A peer that keeps sending without ever completing a frame is bounded by
    // the payload cap plus the largest header.
    if (this.buffer.length > this.maxPayload + 14) {
      this.fail(1009, "frame too large");
      return;
    }
    for (;;) {
      const parsed = this.parseFrame();
      if (parsed === null) return;                 // need more bytes
      if (parsed === false) return;                // protocol error already handled
    }
  }

  /** @returns null = incomplete, false = failed (connection closing), true = one frame consumed */
  private parseFrame(): boolean | null {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = (b0 & 0x0f) as Opcode;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;

    if (rsv !== 0) { this.fail(1002, "reserved bits set"); return false; }
    if (!masked) { this.fail(1002, "client frame not masked"); return false; }

    if (length === 126) {
      if (buf.length < 4) return null;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return null;
      const high = buf.readUInt32BE(2);
      const low = buf.readUInt32BE(6);
      if (high !== 0 || low > 0x7fffffff) { this.fail(1009, "frame too large"); return false; }
      length = low;
      offset = 10;
    }

    const isControl = opcode >= Opcode.Close;
    if (isControl && (length > 125 || !fin)) { this.fail(1002, "bad control frame"); return false; }
    if (!isControl && length > this.maxPayload) { this.fail(1009, "frame too large"); return false; }
    if (opcode === Opcode.Continuation || (!isControl && !fin)) { this.fail(1003, "fragmentation not supported"); return false; }
    if (opcode !== Opcode.Text && opcode !== Opcode.Binary && opcode !== Opcode.Close
      && opcode !== Opcode.Ping && opcode !== Opcode.Pong) {
      this.fail(1002, "unknown opcode");
      return false;
    }

    const total = offset + 4 + length;
    if (buf.length < total) return null;
    const mask = buf.subarray(offset, offset + 4);
    const payload = Buffer.from(buf.subarray(offset + 4, total));   // copy: the buffer is about to be sliced
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buffer = buf.subarray(total);

    switch (opcode) {
      case Opcode.Text: {
        let text: string;
        try { text = this.utf8.decode(payload); } catch { this.fail(1007, "invalid utf-8"); return false; }
        this.emit("message", text, false);
        return true;
      }
      case Opcode.Binary:
        this.emit("message", payload, true);
        return true;
      case Opcode.Ping:
        this.writeFrame(Opcode.Pong, payload);
        return true;
      case Opcode.Pong:
        return true;
      case Opcode.Close: {
        this.closeReceived = true;
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        if (!this.closeSent) {
          this.closeSent = true;
          this.writeFrame(Opcode.Close, payload.subarray(0, 125));
        }
        if (this.closeTimer) clearTimeout(this.closeTimer);
        this.socket.end();
        this.emitClosed(code, reason);
        return true;
      }
      default:
        return true;
    }
  }

  private emitClosed(code: number, reason: string): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.emit("close", code, reason);
  }
}

/**
 * Per-session HTTP listener for one WebTerminalSession.
 *
 * One `127.0.0.1:0` listener per session, closed with the session — it is not
 * the dashboard/health server, so a tunnel pointed at it (phase 3) can reach
 * nothing else. Routes (sid must match exactly, everything else is 404):
 *
 *   GET  /t/<sid>                static page — NO side effects (link-preview
 *                                bots fetch it), NO secret in the URL
 *   GET  /t/<sid>/assets/<file>  vendored xterm.js + page script/style
 *   POST /t/<sid>/open           {token} → token gate → HttpOnly cookie
 *   GET  /t/<sid>/ws (upgrade)   cookie + Origin → WebSocket to the pane
 *
 * Origin must equal Host on /open and /ws (CSRF/cross-site WS). Cookie is
 * HttpOnly; SameSite=Strict; Path=/t/<sid>. Payload/rate limits: 4 KB frames,
 * 64 frames/s, 1 KB /open body; resize clamped by the session.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { acceptWebSocket, rejectUpgrade, type WsConnection } from "./ws-server.js";
import type { WebTerminalSession, TerminalLogger } from "./web-terminal.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ASSETS_DIR = join(__dirname, "ui", "web-terminal");

const MAX_OPEN_BODY = 1024;
const MAX_WS_FRAME = 4096;
const MAX_FRAMES_PER_SECOND = 64;

const ASSETS: Record<string, { file: string; type: string }> = {
  "terminal.js": { file: "terminal.js", type: "text/javascript; charset=utf-8" },
  "terminal.css": { file: "terminal.css", type: "text/css; charset=utf-8" },
  "xterm.js": { file: join("vendor", "xterm.js"), type: "text/javascript; charset=utf-8" },
  "xterm.css": { file: join("vendor", "xterm.css"), type: "text/css; charset=utf-8" },
  "addon-fit.js": { file: join("vendor", "addon-fit.js"), type: "text/javascript; charset=utf-8" },
  "addon-web-links.js": { file: join("vendor", "addon-web-links.js"), type: "text/javascript; charset=utf-8" },
};

export interface WebTerminalHttpOptions {
  /** Interface to bind. Default 127.0.0.1 — reach it via SSH/tailscale/reverse proxy, like /dashboard. */
  bind?: string;
  /** Host name used in the URL handed to the admin (fleet `hostname`, default "localhost"). */
  hostname?: string;
  assetsDir?: string;
}

export class WebTerminalHttpServer {
  private server: Server | null = null;
  private port = 0;
  private ws: WsConnection | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly assetsDir: string;
  private readonly bind: string;
  private readonly hostname: string;
  private unsubscribeFinished: (() => void) | null = null;

  constructor(
    private readonly session: WebTerminalSession,
    private readonly logger: TerminalLogger,
    opts: WebTerminalHttpOptions = {},
  ) {
    this.assetsDir = opts.assetsDir ?? DEFAULT_ASSETS_DIR;
    this.bind = opts.bind ?? "127.0.0.1";
    this.hostname = opts.hostname ?? "localhost";
  }

  get pagePath(): string { return `/t/${this.session.sid}`; }

  /** Start listening; returns the URL to hand the admin (it contains no secret). */
  async listen(): Promise<{ port: number; url: string }> {
    if (this.server) throw new Error("already listening");
    const server = createServer((req, res) => { void this.handle(req, res); });
    server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket as Socket, head));
    server.on("connection", socket => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, this.bind, () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    const onFinished = () => { void this.close(); };
    this.session.once("finished", onFinished);
    this.unsubscribeFinished = () => this.session.off("finished", onFinished);
    return { port: this.port, url: `http://${this.hostname}:${this.port}${this.pagePath}` };
  }

  async close(): Promise<void> {
    this.unsubscribeFinished?.();
    this.unsubscribeFinished = null;
    const server = this.server;
    this.server = null;
    try { this.ws?.close(1001, "session closed"); } catch { /* gone */ }
    this.ws = null;
    if (!server) return;
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      // Idle keep-alive connections would otherwise hold close() open.
      for (const s of this.sockets) s.destroy();
      setTimeout(resolve, 500).unref?.();
    });
  }

  // ── HTTP ──

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const base = this.pagePath;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");

    if (path === base || path === `${base}/`) {
      if (req.method !== "GET") return this.text(res, 405, "method not allowed");
      return this.page(res);
    }
    if (path.startsWith(`${base}/assets/`)) {
      if (req.method !== "GET") return this.text(res, 405, "method not allowed");
      return this.asset(res, path.slice(`${base}/assets/`.length));
    }
    if (path === `${base}/open`) {
      if (req.method !== "POST") return this.text(res, 405, "method not allowed");
      return this.open(req, res);
    }
    if (path === `${base}/ws`) return this.text(res, 426, "upgrade required");
    return this.text(res, 404, "not found");
  }

  private page(res: ServerResponse): void {
    const html = this.readAsset("terminal.html");
    if (!html) return this.text(res, 500, "terminal page missing");
    res.setHeader("Content-Security-Policy",
      // xterm.js injects a <style> element for its DOM renderer, hence 'unsafe-inline' for styles only.
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  private asset(res: ServerResponse, name: string): void {
    const entry = ASSETS[name];
    if (!entry) return this.text(res, 404, "not found");
    const body = this.readAsset(entry.file);
    if (!body) return this.text(res, 404, "not found");
    res.writeHead(200, { "Content-Type": entry.type });
    res.end(body);
  }

  private readAsset(rel: string): Buffer | null {
    const p = join(this.assetsDir, rel);
    if (!existsSync(p)) return null;
    try { return readFileSync(p); } catch { return null; }
  }

  private open(req: IncomingMessage, res: ServerResponse): void {
    if (!this.originMatchesHost(req)) return this.json(res, 403, { error: "origin mismatch" });
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      return this.json(res, 415, { error: "json required" });
    }
    let size = 0;
    const chunks: Buffer[] = [];
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_OPEN_BODY) { tooLarge = true; this.json(res, 413, { error: "body too large" }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return;
      let token = "";
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { token?: unknown };
        token = typeof parsed.token === "string" ? parsed.token : "";
      } catch {
        return this.json(res, 400, { error: "bad json" });
      }
      if (!token) return this.json(res, 400, { error: "token required" });
      const outcome = this.session.redeemToken(token);
      switch (outcome.result) {
        case "ok": {
          const secure = this.isHttps(req) ? "; Secure" : "";
          res.setHeader("Set-Cookie", `${this.cookieName}=${outcome.cookie}; HttpOnly; SameSite=Strict; Path=${this.pagePath}${secure}`);
          return this.json(res, 204, null);
        }
        case "bad": return this.json(res, 403, { error: "invalid token", remaining: outcome.remaining });
        case "used": return this.json(res, 409, { error: "token already used" });
        case "locked": return this.json(res, 410, { error: "session destroyed after repeated failures" });
        case "finished": return this.json(res, 410, { error: "session ended" });
      }
    });
    req.on("error", () => { /* client went away */ });
  }

  // ── WebSocket ──

  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== `${this.pagePath}/ws`) return rejectUpgrade(socket, 404, "Not Found");
    if (!this.originMatchesHost(req)) return rejectUpgrade(socket, 403, "Forbidden");
    if (!this.session.checkCookie(this.cookie(req))) return rejectUpgrade(socket, 403, "Forbidden");
    if (this.session.state !== "running") return rejectUpgrade(socket, 410, "Gone");

    const ws = acceptWebSocket(req, socket, head, { maxPayload: MAX_WS_FRAME });
    if (!ws) return;
    if (this.ws && this.ws !== ws) { try { this.ws.close(4000, "replaced"); } catch { /* gone */ } }
    this.ws = ws;

    let windowStart = Date.now();
    let frames = 0;
    const detach = this.session.attachClient({
      send: data => { ws.send(data); },
      close: (code, reason) => { ws.close(code, reason); },
    });
    ws.on("message", (data: Buffer | string, isBinary: boolean) => {
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; frames = 0; }
      if (++frames > MAX_FRAMES_PER_SECOND) { ws.close(1008, "too many frames"); return; }
      if (isBinary) {
        void this.session.input(data as Buffer).catch(err =>
          this.logger.warn({ err: (err as Error).message }, "web terminal input failed"));
        return;
      }
      let msg: { t?: unknown; cols?: unknown; rows?: unknown };
      try { msg = JSON.parse(data as string); } catch { return; }
      if (msg.t === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
        void this.session.resize(msg.cols, msg.rows).catch(() => { /* pane gone */ });
      }
    });
    ws.on("close", () => { detach(); if (this.ws === ws) this.ws = null; });
    ws.on("error", () => { /* surfaced via close */ });
    this.logger.info({ sid: this.session.sid, ip: req.socket.remoteAddress, ua: String(req.headers["user-agent"] ?? "").slice(0, 120) }, "web_terminal_ws_connected");
  }

  // ── Helpers ──

  private get cookieName(): string { return `agend_term_${this.session.sid.slice(0, 12)}`; }

  private cookie(req: IncomingMessage): string | undefined {
    const raw = String(req.headers.cookie ?? "");
    for (const part of raw.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === this.cookieName) return v.join("=");
    }
    return undefined;
  }

  /** Origin must be present and its host must equal the Host header (what the browser typed). */
  private originMatchesHost(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!origin || !host) return false;
    try { return new URL(String(origin)).host === String(host); } catch { return false; }
  }

  private isHttps(req: IncomingMessage): boolean {
    const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
    return proto === "https" || Boolean((req.socket as Socket & { encrypted?: boolean }).encrypted);
  }

  private text(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`${body}\n`);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    if (status === 204) { res.writeHead(204); res.end(); return; }
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }
}

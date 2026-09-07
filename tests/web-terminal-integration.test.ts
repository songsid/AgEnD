import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxTerminalBackend, WebTerminalSession, type WebTerminalResult, type WebTerminalSpec } from "../src/web-terminal.js";
import { WebTerminalHttpServer } from "../src/web-terminal-http.js";

/**
 * The real thing end to end: a real tmux server per session, the real HTTP
 * listener, and Node's real WebSocket client acting as the browser.
 *
 * Every security property from the design (§3) has a case here:
 *   URL alone grants nothing · wrong token ×3 destroys the session ·
 *   token is single-use · Origin must match Host · WS needs the cookie ·
 *   the pane runs only our command and dies with it · TTL kills the tmux server ·
 *   malformed requests never escape as exceptions · keystrokes never touch argv/logs ·
 *   a replaced browser cannot type · startup failures leave no tmux server behind.
 */
function have(bin: string): boolean {
  try { execFileSync(bin, ["-V"], { stdio: "ignore" }); return true; } catch { return false; }
}
const tmuxAvailable = have("tmux");

const ASSETS = join(process.cwd(), "src", "ui", "web-terminal");
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
const sessions: WebTerminalSession[] = [];
const servers: WebTerminalHttpServer[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) if (s.state === "running") await s.cancel("test teardown");
  for (const s of servers.splice(0)) await s.close();
}, 20_000);

function tmuxServerAlive(socket: string): boolean {
  try { execFileSync("tmux", ["-L", socket, "list-sessions"], { stdio: "ignore" }); return true; } catch { return false; }
}

async function launch(command: string, over: Partial<WebTerminalSpec> = {}) {
  const done: WebTerminalResult[] = [];
  const hints: Array<[string, string | null]> = [];
  const spec: WebTerminalSpec = {
    kind: "login", backend: "test", command, cwd: "/tmp", ttlMs: 30_000,
    requester: { adapterId: "t", userId: "admin", chatId: "c" },
    ...over,
  };
  const session = new WebTerminalSession(spec, {
    onDone: r => { done.push(r); },
    onHint: (u, c) => { hints.push([u, c]); },
  }, new TmuxTerminalBackend(), logger);
  sessions.push(session);
  await session.start();
  const http = new WebTerminalHttpServer(session, logger, { assetsDir: ASSETS, hostname: "127.0.0.1" });
  servers.push(http);
  const { url, port } = await http.listen();
  const origin = `http://127.0.0.1:${port}`;
  return { session, http, url, port, origin, done, hints, base: `${origin}/t/${session.sid}` };
}

async function open(base: string, origin: string, token: string, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${base}/open`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...extraHeaders },
    body: JSON.stringify({ token }),
  });
  const cookie = res.headers.get("set-cookie");
  return { status: res.status, cookie, body: res.status === 204 ? null : await res.json().catch(() => null) };
}

function wsConnect(base: string, origin: string, cookie: string | null): Promise<{ ws: WebSocket; messages: Array<string | ArrayBuffer>; closedWith: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { origin };
    if (cookie) headers.cookie = cookie.split(";")[0];
    // Node's WebSocket accepts undici-style init options for headers.
    const ws = new WebSocket(base.replace("http://", "ws://") + "/ws", { headers } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    const messages: Array<string | ArrayBuffer> = [];
    const closedWith = new Promise<number>(r => { ws.addEventListener("close", ev => r(ev.code)); });
    ws.addEventListener("message", ev => messages.push(ev.data as string | ArrayBuffer));
    ws.addEventListener("open", () => resolve({ ws, messages, closedWith }));
    ws.addEventListener("error", () => reject(new Error("ws failed")));
  });
}

const text = (messages: Array<string | ArrayBuffer>) =>
  messages.filter(m => typeof m !== "string").map(m => Buffer.from(m as ArrayBuffer).toString("utf8")).join("");

async function until(pred: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise(r => setTimeout(r, 50));
  }
}

/** Send one raw HTTP request and return whatever comes back (for malformed targets a fetch client cannot produce). */
async function rawRequest(port: number, request: string): Promise<string> {
  const sock = netConnect(port, "127.0.0.1");
  await new Promise<void>(r => sock.once("connect", () => r()));
  sock.write(request);
  const reply = await new Promise<string>(r => {
    let s = "";
    sock.on("data", d => { s += d.toString(); });
    sock.on("end", () => r(s));
    sock.on("close", () => r(s));
    setTimeout(() => r(s), 800);
  });
  sock.destroy();
  return reply;
}

const CRLF = "\r\n";

describe.skipIf(!tmuxAvailable)("web terminal — real tmux, real HTTP, real WebSocket client", { timeout: 20_000 }, () => {
  it("the URL alone grants nothing: page is static, /ws without cookie is 403, unknown paths 404", async () => {
    const { base, origin, session } = await launch("sleep 30");
    const page = await fetch(base);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain("access token");
    expect(html).not.toContain(session.peekAccessToken()!);    // no secret is ever rendered
    // Fetching the page many times is side-effect free (link preview bots).
    for (let i = 0; i < 5; i++) expect((await fetch(base)).status).toBe(200);
    expect(session.peekAccessToken()).not.toBeNull();
    expect(session.state).toBe("running");

    await expect(wsConnect(base, origin, null)).rejects.toThrow();
    expect((await fetch(`${origin}/t/deadbeef`)).status).toBe(404);
    expect((await fetch(`${base}/assets/../../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/assets/xterm.js`)).status).toBe(200);
    expect((await fetch(`${base}/open`, { method: "GET" })).status).toBe(405);
  });

  it("wrong token three times destroys the session and the tmux server; the page then reports 410", async () => {
    const { base, origin, session, done } = await launch("sleep 30");
    const socket = session.socketName;
    expect(tmuxServerAlive(socket)).toBe(true);
    expect((await open(base, origin, "WRONG")).status).toBe(403);
    expect((await open(base, origin, "WRONG")).body).toMatchObject({ remaining: 1 });
    expect((await open(base, origin, "WRONG")).status).toBe(410);
    await until(() => done.length === 1);
    expect(done[0]).toMatchObject({ ok: false, reason: "token_lockout" });
    await until(() => !tmuxServerAlive(socket));
    // Listener is closed with the session.
    await expect(fetch(base)).rejects.toThrow();
  });

  it("Origin must equal Host on /open and on the WebSocket upgrade", async () => {
    const { base, session } = await launch("sleep 30");
    const token = session.peekAccessToken()!;
    expect((await open(base, "http://evil.example", token)).status).toBe(403);
    expect(session.peekAccessToken()).toBe(token);                     // not consumed by a cross-origin attempt
    const noOrigin = await fetch(`${base}/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    expect(noOrigin.status).toBe(403);
    const good = await open(base, new URL(base).origin, token);
    expect(good.status).toBe(204);
    await expect(wsConnect(base, "http://evil.example", good.cookie)).rejects.toThrow();
  });

  it("happy path: token → cookie → WS streams the pane from its FIRST byte, keys reach the process, exit closes everything", async () => {
    const { base, origin, session, done } = await launch(
      `sh -c 'printf "READY\\n"; read -r line; printf "you typed: %s\\n" "$line"; exit 7'`,
    );
    const token = session.peekAccessToken()!;
    const opened = await open(base, origin, token);
    expect(opened.status).toBe(204);
    expect(opened.cookie).toMatch(/^agend_term_[0-9a-f]{12}=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/t\//);
    expect(session.peekAccessToken()).toBeNull();
    // Token is single-use.
    expect((await open(base, origin, token)).status).toBe(409);

    const { ws, messages, closedWith } = await wsConnect(base, origin, opened.cookie);
    await until(() => messages.length >= 1);
    expect(JSON.parse(messages[0] as string)).toMatchObject({ t: "hello", backend: "test", kind: "login" });
    await until(() => text(messages).includes("READY"));      // the very first line, captured through the replay buffer
    ws.send(new TextEncoder().encode("hello\r"));
    await until(() => text(messages).includes("you typed: hello"));
    await until(() => done.length === 1, 10_000);
    expect(done[0]).toMatchObject({ ok: false, reason: "exit", exitCode: 7 });
    expect(done[0].detail).toContain("you typed: hello");
    const exitMsg = messages.filter(m => typeof m === "string").map(m => JSON.parse(m as string)).find(m => m.t === "exit");
    expect(exitMsg).toMatchObject({ t: "exit", exitCode: 7 });
    expect(await closedWith).toBe(1000);
    await until(() => !tmuxServerAlive(session.socketName));
  });

  it("scope: Ctrl-C from the browser ends the one process and therefore the session — nothing else to fall back to", async () => {
    const { base, origin, session, done } = await launch("sleep 30");
    const opened = await open(base, origin, session.peekAccessToken()!);
    const { ws } = await wsConnect(base, origin, opened.cookie);
    ws.send(new Uint8Array([0x03]));
    await until(() => done.length === 1, 10_000);
    expect(done[0].reason).toBe("exit");
    expect(done[0].ok).toBe(false);                           // sleep killed by SIGINT is not a success
    await until(() => !tmuxServerAlive(session.socketName));
  });

  it("device URL + code seen in the pane are posted once via onHint; exit 0 is success", async () => {
    const { base, origin, session, done, hints } = await launch(
      `sh -c 'echo "Code: ABCD-EFGH"; echo "Open this URL: https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH"; sleep 2; echo Logged in successfully; exit 0'`,
      { observe: { codePattern: /Code:\s*([A-Z0-9-]+)/, successPattern: /Logged in successfully/ } },
    );
    await open(base, origin, session.peekAccessToken()!);
    await until(() => hints.length === 1, 6_000);
    expect(hints[0]).toEqual(["https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH", "ABCD-EFGH"]);
    await until(() => done.length === 1, 10_000);
    expect(done[0]).toMatchObject({ ok: true, reason: "exit", exitCode: 0 });
    expect(hints).toHaveLength(1);
  });

  it("TTL lapse kills the tmux server even when nobody ever connected", async () => {
    const { session, done } = await launch("sleep 30", { ttlMs: 1_500 });
    const socket = session.socketName;
    expect(tmuxServerAlive(socket)).toBe(true);
    await until(() => done.length === 1, 5_000);
    expect(done[0]).toMatchObject({ ok: false, reason: "ttl" });
    await until(() => !tmuxServerAlive(socket));
  });

  it("B1: malformed request targets get 400 with NO unhandled rejection / uncaught exception, and the listener keeps serving", async () => {
    const { base, port, origin, session } = await launch("sleep 30");
    const unhandled: unknown[] = [];
    const onRej = (r: unknown) => unhandled.push(r);
    const onExc = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onRej);
    process.on("uncaughtException", onExc);
    try {
      // absolute-form with an invalid host → `new URL` would throw
      expect(await rawRequest(port, `GET http://% HTTP/1.1${CRLF}Host: 127.0.0.1${CRLF}Connection: close${CRLF}${CRLF}`)).toMatch(/^HTTP\/1\.1 400/);
      // same on the upgrade path
      expect(await rawRequest(port, `GET http://% HTTP/1.1${CRLF}Host: 127.0.0.1${CRLF}Upgrade: websocket${CRLF}Connection: Upgrade${CRLF}Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==${CRLF}Sec-WebSocket-Version: 13${CRLF}${CRLF}`)).toMatch(/^HTTP\/1\.1 400/);
      // authority-form target
      expect(await rawRequest(port, `GET 127.0.0.1:80 HTTP/1.1${CRLF}Host: 127.0.0.1${CRLF}Connection: close${CRLF}${CRLF}`)).toMatch(/^HTTP\/1\.1 400/);
      await new Promise(r => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
      // still alive and side-effect free
      expect((await fetch(base)).status).toBe(200);
      expect(session.peekAccessToken()).not.toBeNull();
      const opened = await open(base, origin, session.peekAccessToken()!);
      expect(opened.status).toBe(204);
    } finally {
      process.off("unhandledRejection", onRej);
      process.off("uncaughtException", onExc);
    }
  });

  it("B2: keystrokes never appear in a tmux argv or in any error/log text (sentinel secret), and still reach the pane", async () => {
    const backend = new TmuxTerminalBackend();
    const secret = "SUPER-SECRET-PASSWORD";
    let message = "";
    try { await backend.sendInput("agend-term-does-not-exist", Buffer.from(secret)); } catch (err) { message = String((err as Error).message) + JSON.stringify(err); }
    expect(message).toMatch(/tmux load-buffer failed/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain(Buffer.from(secret).toString("hex").slice(0, 8));
    expect(message).not.toMatch(/53 55 50/);

    const { base, origin, session } = await launch(`sh -c 'while read -r l; do echo "got:$l"; done'`);
    const opened = await open(base, origin, session.peekAccessToken()!);
    const { ws, messages } = await wsConnect(base, origin, opened.cookie);
    ws.send(new TextEncoder().encode(`${secret}\r`));
    await until(() => text(messages).includes(`got:${secret}`));   // paste-buffer transport works end to end
    expect(JSON.stringify(logger.warn.mock.calls) + JSON.stringify(logger.info.mock.calls)).not.toContain(secret);
  });

  it("B3: a replaced browser cannot type any more — its late frames never reach the pane", async () => {
    const { base, origin, session } = await launch(`sh -c 'while read -r l; do echo "got:$l"; done'`);
    const opened = await open(base, origin, session.peekAccessToken()!);
    const a = await wsConnect(base, origin, opened.cookie);
    const b = await wsConnect(base, origin, opened.cookie);
    expect(await a.closedWith).toBe(4000);
    try { a.ws.send(new TextEncoder().encode("FROM-OLD\r")); } catch { /* the browser API refuses on a closing socket */ }
    b.ws.send(new TextEncoder().encode("FROM-NEW\r"));
    await until(() => text(b.messages).includes("got:FROM-NEW"));
    await new Promise(r => setTimeout(r, 300));
    expect(text(b.messages)).not.toContain("got:FROM-OLD");
  });

  it("B5: a failure after new-session (mkdtemp) leaves no tmux server behind", async () => {
    const prevTmp = process.env.TMPDIR;
    process.env.TMPDIR = "/nonexistent/agend-term-tmp";
    const socket = `agend-term-b5-${process.pid}`;
    try {
      await expect(new TmuxTerminalBackend().start({ socket, command: "sleep 30", cwd: "/tmp", cols: 80, rows: 24, onOutput: () => {} })).rejects.toThrow();
    } finally {
      if (prevTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prevTmp;
    }
    expect(tmuxServerAlive(socket)).toBe(false);
  });

  it("B5: a failure in a later stage (set-option) also leaves no tmux server behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-fake-tmux-"));
    const bin = join(dir, "tmux");
    // Real tmux for everything except set-option, which fails.
    writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = set-option ]; then exit 1; fi; done\nexec tmux "$@"\n`);
    chmodSync(bin, 0o755);
    const socket = `agend-term-b5b-${process.pid}`;
    try {
      await expect(new TmuxTerminalBackend(bin).start({ socket, command: "sleep 30", cwd: "/tmp", cols: 80, rows: 24, onOutput: () => {} })).rejects.toThrow(/tmux set-option failed/);
      expect(tmuxServerAlive(socket)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Stop button = real cancel: the browser's cancel message ends the session and kills tmux", async () => {
    const { base, origin, session, done } = await launch("sleep 30");
    const opened = await open(base, origin, session.peekAccessToken()!);
    const { ws } = await wsConnect(base, origin, opened.cookie);
    ws.send(JSON.stringify({ t: "cancel" }));
    await until(() => done.length === 1);
    expect(done[0]).toMatchObject({ ok: false, reason: "cancel" });
    await until(() => !tmuxServerAlive(session.socketName));
  });

  it("a second browser replaces the first (4000) and receives the replayed output; resize reaches tmux", async () => {
    const { base, origin, session } = await launch(`sh -c 'echo FIRST; sleep 30'`);
    const opened = await open(base, origin, session.peekAccessToken()!);
    const a = await wsConnect(base, origin, opened.cookie);
    await until(() => text(a.messages).includes("FIRST"));
    const b = await wsConnect(base, origin, opened.cookie);
    expect(await a.closedWith).toBe(4000);
    await until(() => text(b.messages).includes("FIRST"));
    b.ws.send(JSON.stringify({ t: "resize", cols: 90, rows: 25 }));
    await until(() => {
      try { return execFileSync("tmux", ["-L", session.socketName, "display", "-p", "-t", "main", "#{window_width}x#{window_height}"]).toString().trim() === "90x25"; } catch { return false; }
    });
  });
});

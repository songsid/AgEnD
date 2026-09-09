import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { TmuxTerminalBackend, WebTerminalSession, probeProcess, type ProcessProbe, type WebTerminalResult, type WebTerminalSpec } from "../src/web-terminal.js";
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
/** Cases that need the Linux /proc strong fingerprint (production deliberately has NONE elsewhere). */
const linuxOnly = process.platform === "linux";

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

  it("B2 (PR-B round 6): new-session that creates the server but reports failure to the client is rolled back — no server, no cancel needed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-fake-tmux-"));
    const bin = join(dir, "tmux");
    // Real tmux for everything; new-session REALLY runs (server exists) but the client exits 1 (timeout/reject shape).
    writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = new-session ]; then tmux "$@"; exit 1; fi; done\nexec tmux "$@"\n`);
    chmodSync(bin, 0o755);
    const socket = `agend-term-b2ns-${process.pid}`;
    try {
      await expect(new TmuxTerminalBackend(bin).start({ socket, command: "sleep 30", cwd: "/tmp", cols: 80, rows: 24, onOutput: () => {} })).rejects.toThrow(/new-session failed/);
      expect(tmuxServerAlive(socket)).toBe(false);
    } finally {
      try { execFileSync("tmux", ["-L", socket, "kill-server"]); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("B2: kill-server failing is not 'already gone' — the PID fallback still confirms the server dead", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-fake-tmux-"));
    const bin = join(dir, "tmux");
    // Real tmux except kill-server, which fails (simulates a wedged/misbehaving server command).
    writeFileSync(bin, `#!/bin/sh
for a in "$@"; do if [ "$a" = kill-server ]; then exit 1; fi; done
exec tmux "$@"
`);
    chmodSync(bin, 0o755);
    const done: WebTerminalResult[] = [];
    const audits: string[] = [];
    const session = new WebTerminalSession({
      kind: "login", backend: "test", command: "sleep 30", cwd: "/tmp", ttlMs: 30_000,
      requester: { adapterId: "t", userId: "admin", chatId: "c" },
    }, { onDone: r => { done.push(r); }, onAudit: e => { audits.push(e); } }, new TmuxTerminalBackend(bin), logger);
    sessions.push(session);
    try {
      await session.start();
      expect(tmuxServerAlive(session.socketName)).toBe(true);
      await session.cancel("test");
      expect(done[0].cleanupFailed).toBeUndefined();              // confirmed dead via SIGTERM/SIGKILL fallback
      expect(audits).not.toContain("web_terminal_cleanup_failed");
      expect(tmuxServerAlive(session.socketName)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("B2: killing an already-gone server is success; a server that cannot be reached at all is reported, not swallowed", async () => {
    const backend = new TmuxTerminalBackend();
    await expect(backend.kill("agend-term-never-existed")).resolves.toBeUndefined();
    // A backend that lost its pid and whose kill-server is a no-op cannot confirm death → rejects.
    const dir = mkdtempSync(join(tmpdir(), "agend-fake-tmux-"));
    const bin = join(dir, "tmux");
    writeFileSync(bin, `#!/bin/sh
for a in "$@"; do if [ "$a" = kill-server ]; then exit 0; fi; done
exec tmux "$@"
`);
    chmodSync(bin, 0o755);
    const socket = `agend-term-b2c-${process.pid}`;
    try {
      execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "main", "sleep 30"]);
      await expect(new TmuxTerminalBackend(bin).kill(socket)).rejects.toThrow(/could not be confirmed dead/);
      expect(tmuxServerAlive(socket)).toBe(true);
    } finally {
      try { execFileSync("tmux", ["-L", socket, "kill-server"]); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("B1 (round 3): probes that cannot execute are 'unknown', never 'absent' — kill REJECTS while the real server lives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-fake-tmux-"));
    const bin = join(dir, "tmux");
    // kill-server fails; list-sessions cannot execute (exit 75, e.g. EAGAIN-class failure).
    writeFileSync(bin, `#!/bin/sh
for a in "$@"; do if [ "$a" = kill-server ]; then exit 1; fi; if [ "$a" = list-sessions ]; then exit 75; fi; done
exec tmux "$@"
`);
    chmodSync(bin, 0o755);
    const socket = `agend-term-b1a-${process.pid}`;
    try {
      execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "main", "sleep 30"]);
      const backend = new TmuxTerminalBackend(bin);           // no PID captured: nothing can prove death
      await expect(backend.kill(socket)).rejects.toThrow(/could not be confirmed dead \(unknown\)/);
      expect(tmuxServerAlive(socket)).toBe(true);
      expect(await backend.serverState(socket)).toBe("unknown");
    } finally {
      try { execFileSync("tmux", ["-L", socket, "kill-server"]); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("B1 (round 3): a transient probe error followed by a live final probe still REJECTS (the final probe decides)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-fake-tmux-"));
    const bin = join(dir, "tmux");
    const counter = join(dir, "n");
    // kill-server is a silent no-op; the FIRST list-sessions fails to execute, later ones are real.
    writeFileSync(bin, `#!/bin/sh
for a in "$@"; do
  if [ "$a" = kill-server ]; then exit 0; fi
  if [ "$a" = list-sessions ]; then if [ ! -f "${counter}" ]; then : > "${counter}"; exit 75; fi; fi
done
exec tmux "$@"
`);
    chmodSync(bin, 0o755);
    const socket = `agend-term-b1b-${process.pid}`;
    try {
      execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "main", "sleep 30"]);
      await expect(new TmuxTerminalBackend(bin).kill(socket)).rejects.toThrow(/could not be confirmed dead \(alive\)/);
      expect(tmuxServerAlive(socket)).toBe(true);
    } finally {
      try { execFileSync("tmux", ["-L", socket, "kill-server"]); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!linuxOnly)("B1 (round 3): with the PID captured, an unexecutable tmux probe does not block a real kill — the dead process is positive evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-fake-tmux-"));
    const bin = join(dir, "tmux");
    writeFileSync(bin, `#!/bin/sh
for a in "$@"; do if [ "$a" = kill-server ]; then exit 1; fi; if [ "$a" = list-sessions ]; then exit 75; fi; done
exec tmux "$@"
`);
    chmodSync(bin, 0o755);
    const backend = new TmuxTerminalBackend(bin);
    const socket = `agend-term-b1c-${process.pid}`;
    try {
      await backend.start({ socket, command: "sleep 30", cwd: "/tmp", cols: 80, rows: 24, onOutput: () => {} });
      expect(tmuxServerAlive(socket)).toBe(true);
      await expect(backend.kill(socket)).resolves.toBeUndefined();   // SIGTERM to the captured PID, ESRCH afterwards
      expect(tmuxServerAlive(socket)).toBe(false);
    } finally {
      try { execFileSync("tmux", ["-L", socket, "kill-server"]); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!linuxOnly)("B1 (round 4): a cached PID that now belongs to a DIFFERENT process is never signalled — identity mismatch means our server is dead", async () => {
    // Simulate PID reuse: our "server" record points at a live unrelated process with a fingerprint that does not match.
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    await new Promise(r => setTimeout(r, 50));
    const bystanderProbe = probeProcess(bystander.pid!);
    expect(bystanderProbe.kind).toBe("identified");
    const socket = `agend-term-reuse-${process.pid}`;                   // no tmux server on it: our server "died outside kill()"
    const backend = new TmuxTerminalBackend();
    backend.rememberServerForTests(socket, bystander.pid!, "linux:1:tmux: server");   // stale identity of the dead server
    try {
      expect(await backend.serverState(socket)).toBe("dead");            // PID reused ⇒ positively not our process
      await expect(backend.kill(socket)).resolves.toBeUndefined();
      await new Promise(r => setTimeout(r, 100));
      expect(bystander.exitCode).toBeNull();                              // still running: no TERM, no KILL
      expect(probeProcess(bystander.pid!)).toEqual(bystanderProbe);
    } finally {
      bystander.kill("SIGKILL");
    }
  });

  it.skipIf(!linuxOnly)("B1 (round 4): a matching fingerprint is required before EVERY signal; a live unrelated process on a cached PID survives even when tmux probes cannot run", async () => {
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    await new Promise(r => setTimeout(r, 50));
    const dir = mkdtempSync(join(tmpdir(), "agend-fake-tmux-"));
    const bin = join(dir, "tmux");
    writeFileSync(bin, `#!/bin/sh
exit 75
`);                            // every tmux probe fails to execute
    chmodSync(bin, 0o755);
    const socket = `agend-term-reuse2-${process.pid}`;
    const backend = new TmuxTerminalBackend(bin);
    backend.rememberServerForTests(socket, bystander.pid!, "linux:1:tmux: server");
    try {
      await expect(backend.kill(socket)).resolves.toBeUndefined();       // identity mismatch ⇒ dead, no signal
      expect(bystander.exitCode).toBeNull();
    } finally {
      bystander.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!linuxOnly)("B1 (round 4/5): probeProcess is tri-state — identified with a strong fingerprint, positively gone, or unknown", async () => {
    const a = spawn("sleep", ["30"], { stdio: "ignore" });
    await new Promise(r => setTimeout(r, 50));
    const idA = probeProcess(a.pid!);
    expect(idA.kind).toBe("identified");
    expect((idA as { identity: string }).identity).toMatch(/^linux:\d+$/);       // start time only — nothing mutable
    expect((idA as { comm?: string }).comm).toBe("sleep");                          // diagnostics, not identity
    expect((probeProcess(process.pid) as { identity: string }).identity).not.toBe((idA as { identity: string }).identity);
    a.kill("SIGKILL");
    await new Promise<void>(r => a.on("exit", () => r()));
    expect(probeProcess(a.pid!)).toEqual({ kind: "gone" });               // ESRCH: positive evidence
    expect(probeProcess(0)).toEqual({ kind: "unknown" });                  // nothing can be said
  });

  it.skipIf(!linuxOnly)("M1 (round 6): a live process renaming itself keeps the same identity — comm is not part of the fingerprint", async () => {
    // A child that renames itself via /proc/self/comm while keeping its PID and start time.
    const child = spawn("sh", ["-c", "sleep 0.3; printf renamed > /proc/self/comm; sleep 30"], { stdio: "ignore" });
    await new Promise(r => setTimeout(r, 80));
    const before = probeProcess(child.pid!) as { kind: string; identity: string; comm?: string };
    expect(before.kind).toBe("identified");
    await new Promise(r => setTimeout(r, 600));
    const after = probeProcess(child.pid!) as { kind: string; identity: string; comm?: string };
    try {
      expect(after.kind).toBe("identified");
      expect(after.identity).toBe(before.identity);                                 // same generation
      expect(after.comm).not.toBe(before.comm);                                     // the rename really happened
      // And the backend therefore still treats it as OUR live process, not as PID reuse.
      const backend = new TmuxTerminalBackend("tmux");
      const socket = `agend-term-rename-${process.pid}`;
      backend.rememberServerForTests(socket, child.pid!, before.identity);
      expect(await backend.serverState(socket)).toBe("alive");
      expect(backend.serverRecordForTests(socket)).toBeDefined();
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("B1 (round 5): identity probe UNKNOWN + tmux probe unknown ⇒ serverState unknown, kill REJECTS — never 'dead' by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-fake-tmux-"));
    const bin = join(dir, "tmux");
    writeFileSync(bin, `#!/bin/sh
exit 75
`);                            // tmux probes cannot execute
    chmodSync(bin, 0o755);
    const socket = `agend-term-unk-${process.pid}`;
    const backend = new TmuxTerminalBackend(bin, { probeProcess: (): ProcessProbe => ({ kind: "unknown" }) });
    backend.rememberServerForTests(socket, 4242, "linux:1:tmux: server");
    try {
      expect(await backend.serverState(socket)).toBe("unknown");
      await expect(backend.kill(socket)).rejects.toThrow(/could not be confirmed dead \(unknown\)/);
      expect(backend.serverRecordForTests(socket)).toBeDefined();          // ownership kept for a later retry
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("B1 (round 5): strong identity MISMATCH + tmux unknown ⇒ dead, no signal ever sent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-fake-tmux-"));
    const bin = join(dir, "tmux");
    writeFileSync(bin, `#!/bin/sh
exit 75
`);
    chmodSync(bin, 0o755);
    const socket = `agend-term-mis-${process.pid}`;
    const signals: string[] = [];
    const realKill = process.kill.bind(process);
    const spy = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
      if (pid === 4242) { signals.push(String(sig)); return true; }
      return realKill(pid, sig as NodeJS.Signals);
    }) as typeof process.kill);
    const backend = new TmuxTerminalBackend(bin, { probeProcess: (): ProcessProbe => ({ kind: "identified", identity: "linux:999:node" }) });
    backend.rememberServerForTests(socket, 4242, "linux:1:tmux: server");
    try {
      expect(await backend.serverState(socket)).toBe("dead");
      expect(backend.serverRecordForTests(socket)).toBeUndefined();        // stale ownership dropped
      backend.rememberServerForTests(socket, 4242, "linux:1:tmux: server");
      await expect(backend.kill(socket)).resolves.toBeUndefined();
      expect(signals).toEqual([]);
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("B1 (round 5): a platform without a strong fingerprint registers NO signal fallback — kill-server or loud cleanupFailed only", async () => {
    // probe says "unknown" at start (what probeProcess returns off-Linux for a live pid)
    const backend = new TmuxTerminalBackend("tmux", { probeProcess: (): ProcessProbe => ({ kind: "unknown" }) });
    const socket = `agend-term-noid-${process.pid}`;
    try {
      await backend.start({ socket, command: "sleep 30", cwd: "/tmp", cols: 80, rows: 24, onOutput: () => {} });
      expect(backend.serverRecordForTests(socket)).toBeUndefined();
      await expect(backend.kill(socket)).resolves.toBeUndefined();         // kill-server + tmux's own no-server answer suffice here
      expect(tmuxServerAlive(socket)).toBe(false);
    } finally {
      try { execFileSync("tmux", ["-L", socket, "kill-server"]); } catch { /* gone */ }
    }
  });

  it("M3: assets are served from memory and the listener refuses more than MAX_CONNECTIONS sockets", async () => {
    const { MAX_CONNECTIONS } = await import("../src/web-terminal-http.js");
    const { base, port } = await launch("sleep 30");
    const held: import("node:net").Socket[] = [];
    try {
      for (let i = 0; i < MAX_CONNECTIONS; i++) {
        const s = netConnect(port, "127.0.0.1");
        await new Promise<void>(r => s.once("connect", () => r()));
        held.push(s);
      }
      const extra = netConnect(port, "127.0.0.1");
      const closedEarly = await new Promise<boolean>(r => { extra.once("close", () => r(true)); setTimeout(() => r(false), 800); });
      expect(closedEarly).toBe(true);
    } finally {
      for (const s of held) s.destroy();
    }
    await new Promise(r => setTimeout(r, 50));
    const asset = await fetch(`${base}/assets/xterm.js`);
    expect(asset.status).toBe(200);
    expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(100_000);
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

/**
 * Regression for the first real-browser acceptance: the link handed out was
 * `/t/<sid>` (no trailing slash) while terminal.html loads `assets/…`
 * relatively, so every asset resolved to `/t/assets/…` → 404 text/plain (no
 * xterm, CSS refused by MIME, and with terminal.js missing the token form fell
 * back to a native submit that CSP form-action 'none' blocks). Absolute-path
 * asset fetches in the cases above never exercised that resolution step, and
 * this needs no tmux: a fake session is enough to serve the page.
 */
describe("web terminal — the page's relative asset references resolve against the handed-out URL", () => {
  function fakeSession(): WebTerminalSession {
    const s = new EventEmitter();
    return Object.assign(s, {
      sid: "ab".repeat(16), state: "running",
      redeemToken: () => ({ result: "bad", remaining: 2 }),
      checkCookie: () => false,
      attachClient: () => () => {},
      cancel: async () => {},
    }) as unknown as WebTerminalSession;
  }

  it("hands out a URL ending in '/', serves every href/src the browser would derive from it, and redirects the bare path", async () => {
    const http = new WebTerminalHttpServer(fakeSession(), logger, { assetsDir: ASSETS, hostname: "127.0.0.1" });
    servers.push(http);
    const { url } = await http.listen();
    expect(url).toMatch(/\/t\/[0-9a-f]{32}\/$/);

    const page = await fetch(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1]);
    expect(refs.length).toBeGreaterThanOrEqual(6);                 // xterm.css, terminal.css, xterm.js, 2 addons, terminal.js
    for (const ref of refs) {
      const res = await fetch(new URL(ref, url));                  // exactly what the browser does with a relative URL
      expect(res.status, ref).toBe(200);
      const type = res.headers.get("content-type") ?? "";
      expect(/^text\/(javascript|css); charset=utf-8$/.test(type), `${ref} → ${type}`).toBe(true);
    }

    // A link pasted without the trailing slash lands on the same page.
    const bare = url.replace(/\/$/, "");
    const redirect = await fetch(bare, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(new URL(url).pathname);
    expect(redirect.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(bare)).status).toBe(200);                  // followed by default, as a browser would
    expect((await fetch(bare, { method: "POST", redirect: "manual" })).status).toBe(405);
  });
});

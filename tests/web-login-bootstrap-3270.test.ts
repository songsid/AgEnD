/**
 * #3270: the first code `agend web --code` asks for — before a host session has EVER been authorized on this fleet — lasts
 * 60 minutes instead of 5, and in exchange it is bounded four ways: redeemable from this computer only and only until the
 * first host session exists; asked for by an interactive terminal only (`X-Agend-Code-Delivery: tty` — a code for a URL, a
 * pipe, a redirect or an install log, or from a caller that does not say, is the ordinary 5 minutes); never on WSL (a Windows
 * process is loopback there and can read the distro's files); and never in a log line. "No session right now" (signed out,
 * expired) is not "first install", and an hour after the first one every code is the ordinary 5 minutes again.
 *
 * Real: WebLoginCodes, WebSessionStore and the real auth routes (handleAuthRequest) over a real HTTP socket. A manual
 * clock moves both the code store and the session store. "Not this computer" is what classifyWebPeer calls it: a Host
 * name that is not a loopback name, or a forwarding header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { handleAuthRequest } from "../src/auth-api.js";
import { tokenEpoch, WebSessionStore } from "../src/web-session.js";
import { BOOTSTRAP_LOGIN_CODE_TTL_MS, LOGIN_CODE_TTL_MS, MAX_LOGIN_CODE_ATTEMPTS, WebLoginCodes } from "../src/web-login.js";

const TOKEN = "bootstrap-test-web-token-0123456789abcdef";
const EPOCH = tokenEpoch(TOKEN);
const MIN = 60_000, HOUR = 60 * MIN;
const logged: string[] = [];
const record = (level: string) => (...args: unknown[]) => { logged.push(`${level} ${args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`); };
const quiet = { info: record("info"), warn: record("warn"), debug: record("debug"), error: record("error"), trace: record("trace"), fatal: record("fatal"), child() { return quiet; } };

const servers: Server[] = [];
// Not WSL unless a test says so: the fleet looks at its own machine, and this suite may run on one.
beforeEach(() => { vi.stubEnv("AGEND_WSL", "0"); });
afterEach(() => { vi.unstubAllEnvs(); });
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }); });

async function fleet(opts: { dataDir?: string } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const now = () => clock.t;
  let n = 0;
  const codes = new WebLoginCodes({ now, generate: () => `CODE${String.fromCharCode(65 + (n++ % 26))}${String.fromCharCode(66 + (n % 24))}${n % 6 + 2}7` });
  const sessions = new WebSessionStore({ now, ...(opts.dataDir ? { dataDir: opts.dataDir } : {}) });
  const ctx = { webToken: TOKEN, webSessions: sessions, webLoginCodes: codes, logger: quiet } as never;
  const server = createServer((req, res) => {
    if (!handleAuthRequest(req, res, new URL(req.url ?? "/", `http://${req.headers.host}`), ctx)) { res.writeHead(404); res.end(); }
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, headers: Record<string, string>, body: unknown = {}) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)), ...headers } }, res => {
      let text = ""; res.on("data", c => { text += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
    });
    req.on("error", reject); req.end(payload);
  });
  const local = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
  // `delivery` is what `agend web` says about where the code will be shown; a terminal (`tty`) unless a test says otherwise, `null` = no header.
  const issue = (delivery: string | null = "tty") => call("/auth/issue-code", { "x-agend-token": TOKEN, host: local.host, ...(delivery ? { "x-agend-code-delivery": delivery } : {}) });
  const login = (code: string, as: "local" | "lan" | "forwarded" = "local") => call("/auth/login", as === "lan" ? { host: "agend.lan.test", origin: "http://agend.lan.test" }
    : as === "forwarded" ? { ...local, "x-forwarded-for": "203.0.113.9" } : local, { code });
  return { clock, codes, sessions, issue, login, advance: (ms: number) => { clock.t += ms; } };
}

describe("#3270 issuing: the first code, and the ones after a host session has existed", () => {
  it("before any host session: a 60 minute bootstrap code; once one was authorized every later code is 5 min — signed out or not", async () => {
    const f = await fleet();
    const first = await f.issue();
    expect([first.status, first.body.bootstrap, (first.body.expiresAt as number) - f.clock.t]).toEqual([200, true, BOOTSTRAP_LOGIN_CODE_TTL_MS]);
    expect(f.sessions.hostEverAuthorized).toBe(false);
    expect((await f.login(first.body.code as string)).status).toBe(200);
    expect(f.sessions.hostEverAuthorized).toBe(true);

    const second = await f.issue();
    expect([second.body.bootstrap, (second.body.expiresAt as number) - f.clock.t]).toEqual([undefined, LOGIN_CODE_TTL_MS]);

    // Signing everyone out — or letting every session expire — does not bring the first-install lifetime back.
    f.sessions.revokeAll();
    const third = await f.issue();
    expect([third.body.bootstrap, (third.body.expiresAt as number) - f.clock.t]).toEqual([undefined, LOGIN_CODE_TTL_MS]);
    f.advance(49 * HOUR);
    const fourth = await f.issue();
    expect([fourth.body.bootstrap, (fourth.body.expiresAt as number) - f.clock.t]).toEqual([undefined, LOGIN_CODE_TTL_MS]);
  });

  it("a code that does not go to an interactive terminal is the ordinary 5 minutes, even on a fresh install: a URL, a pipe or redirect, no header, or a made-up one", async () => {
    for (const delivery of ["url", "non-tty", null, "", "TTYX", "wsl", "pipe"]) {
      const f = await fleet();
      const asked = await f.issue(delivery);
      expect([delivery, asked.status, asked.body.bootstrap, (asked.body.expiresAt as number) - f.clock.t]).toEqual([delivery, 200, undefined, LOGIN_CODE_TTL_MS]);
      f.advance(LOGIN_CODE_TTL_MS);
      expect([delivery, (await f.login(asked.body.code as string)).status]).toEqual([delivery, 401]);
      // …and it did not use up the first-install allowance: a code printed to a terminal after it still is one.
      expect([delivery, (await f.issue("tty")).body.bootstrap]).toEqual([delivery, true]);
    }
  });

  it("the header is read case-insensitively and trimmed, and only `tty` opens the long lifetime", async () => {
    for (const delivery of ["tty", "TTY", " Tty "]) expect([delivery, (await (await fleet()).issue(delivery)).body.bootstrap]).toEqual([delivery, true]);
  });

  it("on WSL a code for a terminal is still the ordinary 5 minutes — and keeps the allowance for a machine that is not", async () => {
    vi.stubEnv("AGEND_WSL", "1");
    const f = await fleet();
    const asked = await f.issue("tty");
    expect([asked.status, asked.body.bootstrap, (asked.body.expiresAt as number) - f.clock.t]).toEqual([200, undefined, LOGIN_CODE_TTL_MS]);
    f.advance(LOGIN_CODE_TTL_MS);
    expect((await f.login(asked.body.code as string)).status).toBe(401);
    vi.stubEnv("AGEND_WSL", "0");
    expect((await f.issue("tty")).body.bootstrap).toBe(true);
  });

  it("WSL is recognised by the fleet from its own environment, not from what the caller says", async () => {
    vi.stubEnv("AGEND_WSL", "");                                             // detection falls back to the environment
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    const f = await fleet();
    expect((await f.issue("tty")).body.bootstrap).toBeUndefined();
  });

  it("a bootstrap code is never written to a log: not by the fleet, not in a line about it", async () => {
    logged.length = 0;
    const f = await fleet();
    const first = await f.issue("tty");
    const second = await f.issue("non-tty");
    await f.login(first.body.code as string);
    await f.login("WRONGCDE");
    expect(logged.some(line => /Web login code issued/.test(line))).toBe(true);             // it does say one was issued…
    for (const code of [first.body.code as string, second.body.code as string]) {
      const bare = code.replace("-", "");
      expect(logged.filter(line => line.includes(code) || line.includes(bare))).toEqual([]);  // …never which
    }
  });

  it("the marker is persisted: a restart (a new store on the same directory) still knows, even if the sessions file is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-host-marker-"));
    try {
      const f = await fleet({ dataDir: dir });
      expect((await f.issue()).body.bootstrap).toBe(true);
      expect((await f.login((await f.issue()).body.code as string)).status).toBe(200);
      expect(existsSync(join(dir, "web-host-authorized"))).toBe(true);
      rmSync(join(dir, "web-sessions.json"), { force: true });             // what a failed session save does
      expect(new WebSessionStore({ dataDir: dir }).hostEverAuthorized).toBe(true);
      const g = await fleet({ dataDir: dir });
      expect((await g.issue()).body.bootstrap).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("an empty directory is a fresh install, and so is a fleet whose sessions file holds no host session — empty, guest, remote, or a plain admin", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-host-marker-"));
    const marker = join(dir, "web-host-authorized");
    try {
      expect(new WebSessionStore({ dataDir: dir }).hostEverAuthorized).toBe(false);
      writeFileSync(join(dir, "web-sessions.json"), JSON.stringify({ version: 1, sessions: [] }));
      expect(new WebSessionStore({ dataDir: dir }).hostEverAuthorized).toBe(false);
      expect(existsSync(marker)).toBe(false);

      const sessions = new WebSessionStore({ dataDir: dir });
      sessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: EPOCH });
      sessions.create({ tier: "guest", surface: "local", label: "x", tokenEpoch: EPOCH, owner: { adapterId: "a", userId: "u" } });
      sessions.create({ tier: "admin", surface: "gateway", label: "x", tokenEpoch: EPOCH, exposureId: "a".repeat(32), remote: "totp" });
      expect(JSON.parse(readFileSync(join(dir, "web-sessions.json"), "utf8")).sessions).toHaveLength(3);
      const restarted = new WebSessionStore({ dataDir: dir });
      expect([restarted.size, restarted.hostEverAuthorized, existsSync(marker)]).toEqual([3, false, false]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a fleet from before the marker (a host session in the sessions file, no marker) is already authorized — and the marker is written", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-host-marker-"));
    const marker = join(dir, "web-host-authorized");
    try {
      const before = new WebSessionStore({ dataDir: dir });
      before.create({ tier: "guest", surface: "local", label: "x", tokenEpoch: EPOCH, owner: { adapterId: "a", userId: "u" } });
      before.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: EPOCH, host: true });
      rmSync(marker, { force: true });                                        // what a fleet from before the marker looked like
      const restarted = new WebSessionStore({ dataDir: dir });
      expect([restarted.hostEverAuthorized, existsSync(marker)]).toEqual([true, true]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("an expired host session on record still counts: the operator did sign in once", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-host-marker-"));
    const marker = join(dir, "web-host-authorized");
    try {
      const clock = { t: 1_700_000_000_000 };
      const before = new WebSessionStore({ dataDir: dir, now: () => clock.t });
      before.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: EPOCH, host: true });
      rmSync(marker, { force: true });
      clock.t += 400 * 24 * HOUR;
      const restarted = new WebSessionStore({ dataDir: dir, now: () => clock.t });
      expect([restarted.size, restarted.hostEverAuthorized, existsSync(marker)]).toEqual([0, true, true]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a restart of a new fleet whose sessions file holds no host session still gets the first-install code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-host-marker-"));
    try {
      const guestOnly = new WebSessionStore({ dataDir: dir });
      guestOnly.create({ tier: "guest", surface: "local", label: "x", tokenEpoch: EPOCH, owner: { adapterId: "a", userId: "u" } });
      const f = await fleet({ dataDir: dir });
      const first = await f.issue();
      expect([first.status, first.body.bootstrap, (first.body.expiresAt as number) - f.clock.t]).toEqual([200, true, BOOTSTRAP_LOGIN_CODE_TTL_MS]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("only a host session sets the marker: a guest's or another admin sign-in does not", () => {
    const sessions = new WebSessionStore();
    sessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: EPOCH });
    sessions.create({ tier: "guest", surface: "local", label: "x", tokenEpoch: EPOCH, owner: { adapterId: "a", userId: "u" } });
    expect(sessions.hostEverAuthorized).toBe(false);
    sessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: EPOCH, host: true });
    expect(sessions.hostEverAuthorized).toBe(true);
  });

  it("a code sent to an account (a chat /web code) is never a bootstrap code", () => {
    const codes = new WebLoginCodes({ now: () => 0 });
    const owner = { adapterId: "a", userId: "u", chatId: "c" };
    expect(codes.issue({ epoch: EPOCH, owner, host: true, bootstrap: true }).expiresAt).toBe(LOGIN_CODE_TTL_MS);
    expect(codes.issue({ epoch: EPOCH, bootstrap: true }).expiresAt).toBe(LOGIN_CODE_TTL_MS);       // not a host code
    expect(codes.issue({ epoch: EPOCH, host: true, audience: "link-1", bootstrap: true }).expiresAt).toBe(LOGIN_CODE_TTL_MS);
  });

  it("issue-code still needs the web token", async () => {
    const f = await fleet();
    expect((await f.issue()).status).toBe(200);
    const refused = await new Promise<number>(resolve => {
      const port = (servers[0]!.address() as AddressInfo).port;
      const req = request({ host: "127.0.0.1", port, path: "/auth/issue-code", method: "POST", headers: { host: `127.0.0.1:${port}` } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.end();
    });
    expect(refused).toBe(401);
  });
});

describe("#3270 redeeming a bootstrap code", () => {
  it("works from this computer after 10 minutes, after 30, and up to the last moment of the hour; the first redemption spends it", async () => {
    for (const wait of [10 * MIN, 30 * MIN, 60 * MIN - 1]) {
      const f = await fleet();
      const code = (await f.issue()).body.code as string;
      f.advance(wait);
      const ok = await f.login(code);
      expect([wait, ok.status]).toEqual([wait, 200]);
      expect((await f.login(code)).status).toBe(401);                       // single use
    }
  });

  it("is gone after 60 minutes, not after 24 hours", async () => {
    expect(BOOTSTRAP_LOGIN_CODE_TTL_MS).toBe(60 * 60 * 1000);
    const f = await fleet();
    const code = (await f.issue()).body.code as string;
    f.advance(BOOTSTRAP_LOGIN_CODE_TTL_MS);
    expect((await f.login(code)).status).toBe(401);
  });

  it("after the hour every code is the ordinary 5 minutes again — the person runs agend web once more and signs in within them", async () => {
    const f = await fleet();
    const first = await f.issue();
    f.advance(BOOTSTRAP_LOGIN_CODE_TTL_MS + MIN);
    expect((await f.login(first.body.code as string)).status).toBe(401);
    const again = await f.issue();                                          // `agend web --code` on a terminal, a minute past the hour
    expect([again.body.bootstrap, (again.body.expiresAt as number) - f.clock.t]).toEqual([undefined, LOGIN_CODE_TTL_MS]);
    f.advance(4 * MIN);
    expect((await f.login(again.body.code as string)).status).toBe(200);
  });

  it("a re-run inside the hour gets a code that ends with the first one's hour, not a fresh one", async () => {
    const f = await fleet();
    const first = await f.issue();
    const start = f.clock.t;
    f.advance(40 * MIN);
    const rerun = await f.issue();
    expect([rerun.body.bootstrap, rerun.body.expiresAt]).toEqual([true, first.body.expiresAt]);
    expect((first.body.expiresAt as number) - start).toBe(BOOTSTRAP_LOGIN_CODE_TTL_MS);
    f.advance(20 * MIN);
    expect((await f.login(rerun.body.code as string)).status).toBe(401);
  });

  it("an ordinary code (a host session was authorized before) still dies at 5 minutes", async () => {
    const f = await fleet();
    expect((await f.login((await f.issue()).body.code as string)).status).toBe(200);
    const code = (await f.issue()).body.code as string;
    f.advance(LOGIN_CODE_TTL_MS);
    expect((await f.login(code)).status).toBe(401);
  });

  it("is refused from a LAN host name and from a forwarded request — and not spent, so this computer can still use it", async () => {
    const f = await fleet();
    const code = (await f.issue()).body.code as string;
    expect((await f.login(code, "lan")).status).toBe(401);
    expect((await f.login(code, "forwarded")).status).toBe(401);
    expect(f.sessions.size).toBe(0);
    expect((await f.login(code, "local")).status).toBe(200);
  });

  it("wrong guesses from off this computer never burn the code, however many", async () => {
    const f = await fleet();
    const code = (await f.issue()).body.code as string;
    for (let i = 0; i < MAX_LOGIN_CODE_ATTEMPTS + 2; i++) await f.login("WRONGCDE", "lan");
    expect((await f.login(code)).status).toBe(200);
  });

  it("is withdrawn the moment the first host session is made — and stays withdrawn after that session signs out", async () => {
    const f = await fleet();
    const unused = (await f.issue()).body.code as string;
    // A host session appears some other way (another browser, another code path) while this code sits unused.
    f.sessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: EPOCH, host: true });
    f.sessions.revokeAll();
    expect((await f.login(unused)).status).toBe(401);
    expect(f.codes.hasOutstandingCode).toBe(false);
  });

  it("never over the public link: a gateway request (own exposure) cannot spend a bootstrap code, nor burn it", async () => {
    const codes = new WebLoginCodes({ now: () => 0, generate: () => "ABCDEFGH" });
    codes.issue({ epoch: EPOCH, host: true, bootstrap: true });
    for (let i = 0; i < MAX_LOGIN_CODE_ATTEMPTS + 1; i++) expect(codes.redeem("ABCD-EFGH", EPOCH, "link-1", { loopbackPeer: false, hostEverAuthorized: false }).kind).toBe("invalid");
    expect(codes.redeem("ABCD-EFGH", EPOCH, "local", { loopbackPeer: true, hostEverAuthorized: false }).kind).toBe("ok");
  });

  it("five wrong tries from this computer still burn it", async () => {
    const f = await fleet();
    const code = (await f.issue()).body.code as string;
    for (let i = 0; i < MAX_LOGIN_CODE_ATTEMPTS; i++) expect((await f.login("WRONGCDE")).status).toBe(401);
    expect((await f.login(code)).status).toBe(401);
  });

  it("a new code replaces the previous unused one", async () => {
    const f = await fleet();
    const first = (await f.issue()).body.code as string;
    const second = (await f.issue()).body.code as string;
    expect((await f.login(first)).status).toBe(401);
    expect((await f.login(second)).status).toBe(200);
  });

  it("the breaker still pauses redemption after twenty wrong tries across codes, the correct code included", async () => {
    const f = await fleet();
    // Five wrong tries burn a code, so a patient guesser needs a new one every few tries — the breaker counts across them.
    for (let i = 0; i < 20; i++) { if (i % 4 === 0) await f.issue(); await f.login("WRONGCDE"); }
    const code = (await f.issue()).body.code as string;
    expect((await f.login(code)).status).toBe(429);
  });

  it("without a context (any other caller) a bootstrap code is never spent", () => {
    const codes = new WebLoginCodes({ now: () => 0, generate: () => "ABCDEFGH" });
    codes.issue({ epoch: EPOCH, host: true, bootstrap: true });
    expect(codes.redeem("ABCD-EFGH", EPOCH).kind).toBe("invalid");
    expect(codes.redeem("ABCD-EFGH", EPOCH, "local", { loopbackPeer: true, hostEverAuthorized: false }).kind).toBe("ok");
  });
});

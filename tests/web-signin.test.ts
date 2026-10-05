import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { rotateWebToken } from "../src/web-auth.js";
import { csrfTokenFor } from "../src/web-session.js";
import { LOGIN_BREAKER_THRESHOLD, MAX_LOGIN_CODE_ATTEMPTS } from "../src/web-login.js";
import { LOGIN_PAUSED_MESSAGE, LOGIN_REFUSED_MESSAGE } from "../src/auth-api.js";

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = "";
      res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

interface Harness { fm: FleetManager; port: number; dir: string; logged: string[]; notices: string[]; origin: string }

async function startFleet(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "agend-signin-"));
  tempDirs.push(dir);
  const fm = new FleetManager(dir);
  const logged: string[] = [];
  const notices: string[] = [];
  const sink = (obj: unknown, msg?: string) => { logged.push(JSON.stringify(obj) + " " + (msg ?? "")); };
  fm.logger = { info: sink, warn: sink, error: sink, debug: sink, trace: () => {}, fatal: () => {}, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation((text: string) => { notices.push(text); return true; });
  (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
  (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const server = (fm as unknown as { healthServer: Server }).healthServer;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  return { fm, port: address.port, dir, logged, notices, origin: `http://127.0.0.1:${address.port}` };
}

async function stop(fm: FleetManager): Promise<void> {
  const server = (fm as unknown as { healthServer: Server | null }).healthServer;
  await new Promise<void>(resolve => server?.close(() => resolve()));
  (fm as unknown as { healthServer: Server | null }).healthServer = null;
}

const JSON_HEADERS = { "content-type": "application/json" };

function login(h: Harness, code: string, extra: Record<string, string> = {}): Promise<Res> {
  return raw(h.port, "POST", "/auth/login", { ...JSON_HEADERS, origin: h.origin, ...extra }, JSON.stringify({ code }));
}

function cookieOf(res: Res): string {
  const set = res.headers["set-cookie"];
  const first = Array.isArray(set) ? set[0] : set;
  expect(first, "a Set-Cookie header").toBeTruthy();
  return first!.split(";")[0]!;
}

/** Ask for a code the way /dashboard does, and sign in with it. */
async function signIn(h: Harness): Promise<{ cookie: string; sessionId: string; csrf: string; res: Res }> {
  const issued = h.fm.issueDashboardLogin()!;
  const res = await login(h, issued.display);
  expect(res.status).toBe(200);
  const cookie = cookieOf(res);
  const sessionId = cookie.split("=")[1]!;
  return { cookie, sessionId, csrf: csrfTokenFor(sessionId), res };
}

const write = (h: Harness, s: { cookie: string; csrf: string }) =>
  ({ cookie: s.cookie, origin: h.origin, "x-agend-csrf": s.csrf });

describe("the sign-in page and its scripts", () => {
  it("serves the page with no side effects and no secret", async () => {
    const h = await startFleet();
    const issued = h.fm.issueDashboardLogin()!;

    // A link with the code riding along in the query string, as a careless paste would have it.
    const page = await raw(h.port, "GET", `/signin?code=${issued.display}&next=/ui`);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["set-cookie"]).toBeUndefined();
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).not.toContain(h.fm.getDashboardAccess().token!);
    await raw(h.port, "GET", `/auth/session?code=${issued.display}`);
    await raw(h.port, "GET", `/assets/signin.js?code=${issued.display}`);
    // Fetching it — as a link-preview bot does — did not spend the code.
    expect((await login(h, issued.display)).status).toBe(200);
    await stop(h.fm);
  }, 20_000);

  it("serves only the two scripts it names, and nothing that merely looks like them", async () => {
    const h = await startFleet();
    for (const name of ["agend-auth.js", "signin.js"]) {
      const res = await raw(h.port, "GET", `/assets/${name}`);
      expect(res.status, name).toBe(200);
      expect(res.headers["content-type"]).toContain("text/javascript");
    }
    for (const bad of ["../signin.html", "..%2fsignin.html", "signin.html", "settings.html", "", "agend-auth.js/../../fleet.yaml", "%2e%2e/web.token"]) {
      const res = await raw(h.port, "GET", `/assets/${bad}`);
      // 404 from the asset route, or 401 from the gate when the URL normalizes out of /assets/ altogether: never a file.
      expect([401, 404], bad).toContain(res.status);
      expect(res.body, bad).not.toContain("<html");
      expect(res.body, bad).not.toContain("<!DOCTYPE");
    }
    expect((await raw(h.port, "POST", "/assets/agend-auth.js")).status).toBe(404);
    await stop(h.fm);
  }, 20_000);

  it("answers a browser navigation to a panel without a cookie with the sign-in page, and an API call with JSON", async () => {
    const h = await startFleet();
    for (const path of ["/ui", "/settings"]) {
      const nav = await raw(h.port, "GET", path, { accept: "text/html,application/xhtml+xml" });
      expect(nav.status, path).toBe(401);
      expect(nav.headers["content-type"]).toContain("text/html");
      expect(nav.body).toContain("/assets/signin.js");

      const api = await raw(h.port, "GET", path, { accept: "application/json" });
      expect(api.status, path).toBe(401);
      expect(JSON.parse(api.body).error).toBeTruthy();
    }
    // A session that has ended — signed out, revoked, expired — is answered the same way as no cookie.
    const s = await signIn(h);
    await raw(h.port, "POST", "/auth/logout", write(h, s));
    const stale = await raw(h.port, "GET", "/ui", { accept: "text/html", cookie: s.cookie });
    expect(stale.status).toBe(401);
    expect(stale.headers["content-type"]).toContain("text/html");
    expect(stale.body).toContain("/assets/signin.js");
    const staleApi = await raw(h.port, "GET", "/ui/backends", { accept: "application/json", cookie: s.cookie });
    expect(JSON.parse(staleApi.body).error).toContain("sign in again");
    // Only "nothing presented" gets the page: a wrong header token is an error, not an invitation.
    const wrong = await raw(h.port, "GET", "/ui", { accept: "text/html", "x-agend-token": "wrong" });
    expect(wrong.headers["content-type"]).toContain("application/json");
    // A `?token=` in the URL is not a credential at all — right or wrong it is "nothing presented": the sign-in page.
    for (const t of ["wrong", h.fm.getDashboardAccess().token!]) {
      const link = await raw(h.port, "GET", `/ui?token=${t}`, { accept: "text/html" });
      expect(link.status).toBe(401);
      expect(link.body).toContain("/assets/signin.js");
      expect(link.headers["set-cookie"]).toBeUndefined();
    }
    await stop(h.fm);
  }, 20_000);
});

describe("POST /auth/login", () => {
  it("exchanges a fresh code for an HttpOnly, SameSite=Strict session cookie", async () => {
    const h = await startFleet();
    const { res, sessionId } = await signIn(h);

    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toMatch(/^agend_session=[0-9a-f]{64};/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Secure");
    expect(setCookie).toMatch(/Max-Age=43200/);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ ok: true, tier: "admin" });
    expect(body.csrf).toBe(csrfTokenFor(sessionId));
    // Nothing in the cookie is the token, the code, or derivable from either.
    expect(setCookie).not.toContain(h.fm.getDashboardAccess().token!);
    await stop(h.fm);
  }, 20_000);

  it("marks the cookie Secure and __Host- when the browser reached us over TLS", async () => {
    const h = await startFleet();
    const issued = h.fm.issueDashboardLogin()!;
    const res = await login(h, issued.display, { "x-forwarded-proto": "https" });
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toMatch(/^__Host-agend_session=[0-9a-f]{64};/);
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toMatch(/Domain=/i);
    await stop(h.fm);
  }, 20_000);

  it("wants a same-origin JSON POST: no Origin, a foreign Origin, or another content type is refused before the code is looked at", async () => {
    const h = await startFleet();
    const issued = h.fm.issueDashboardLogin()!;
    const body = JSON.stringify({ code: issued.display });

    expect((await raw(h.port, "POST", "/auth/login", JSON_HEADERS, body)).status).toBe(403);
    expect((await raw(h.port, "POST", "/auth/login", { ...JSON_HEADERS, origin: "https://evil.example" }, body)).status).toBe(403);
    expect((await raw(h.port, "POST", "/auth/login", { origin: h.origin, "content-type": "text/plain" }, body)).status).toBe(415);
    expect((await raw(h.port, "POST", "/auth/login", { origin: h.origin, "content-type": "application/x-www-form-urlencoded" }, `code=${issued.display}`)).status).toBe(415);
    expect((await raw(h.port, "GET", `/auth/login?code=${issued.display}`, { origin: h.origin })).status).toBe(405);
    // None of those spent the code.
    expect((await login(h, issued.display)).status).toBe(200);
    await stop(h.fm);
  }, 20_000);

  it("answers a wrong code, an expired code and no code identically", async () => {
    const h = await startFleet();
    const noCode = await login(h, "ABCD-EFGH");
    h.fm.issueDashboardLogin();
    const wrong = await login(h, "ZZZZ-ZZZZ");

    for (const res of [noCode, wrong]) {
      expect(res.status).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(JSON.parse(res.body)).toEqual({ error: LOGIN_REFUSED_MESSAGE });
    }
    await stop(h.fm);
  }, 20_000);

  it("burns a code after its fifth wrong try but leaves the panel usable", async () => {
    const h = await startFleet();
    const issued = h.fm.issueDashboardLogin()!;
    for (let i = 0; i < MAX_LOGIN_CODE_ATTEMPTS; i++) expect((await login(h, `ZZZZ-ZZ2${i % 8}`)).status).toBe(401);
    expect((await login(h, issued.display)).status).toBe(401);

    // Asking again is the whole cost.
    expect((await login(h, h.fm.issueDashboardLogin()!.display)).status).toBe(200);
    await stop(h.fm);
  }, 20_000);

  it("pauses with 429 and Retry-After once wrong tries pile up across codes", async () => {
    const h = await startFleet();
    let paused: Res | null = null;
    for (let round = 0; round < LOGIN_BREAKER_THRESHOLD && !paused; round++) {
      h.fm.issueDashboardLogin();
      for (let i = 0; i < MAX_LOGIN_CODE_ATTEMPTS && !paused; i++) {
        const res = await login(h, "ZZZZ-ZZZZ");
        if (res.status === 429) paused = res;
      }
    }
    expect(paused).not.toBeNull();
    expect(JSON.parse(paused!.body)).toEqual({ error: LOGIN_PAUSED_MESSAGE });
    expect(Number(paused!.headers["retry-after"])).toBeGreaterThan(0);
    // A correct code is refused while it lasts.
    expect((await login(h, h.fm.issueDashboardLogin()!.display)).status).toBe(429);
    await stop(h.fm);
  }, 30_000);

  it("closes the panel when there is no web.token", async () => {
    const h = await startFleet();
    const issued = h.fm.issueDashboardLogin()!;
    rmSync(join(h.dir, "web.token"));
    expect((await login(h, issued.display)).status).toBe(401);
    expect(h.fm.issueDashboardLogin()).toBeNull();
    await stop(h.fm);
  }, 20_000);

  it("never logs the code or the session id", async () => {
    const h = await startFleet();
    const issued = h.fm.issueDashboardLogin()!;
    const res = await login(h, issued.display);
    const sessionId = cookieOf(res).split("=")[1]!;
    await login(h, "ZZZZ-ZZZZ");

    const log = h.logged.join("\n");
    expect(log).toContain("Web sign-in");
    expect(log).not.toContain(issued.display);
    expect(log).not.toContain(issued.display.replace("-", ""));
    expect(log).not.toContain(sessionId);
    expect(log).not.toContain(csrfTokenFor(sessionId));
    await stop(h.fm);
  }, 20_000);

  it("tells the admin channel about a new sign-in, and can be told not to", async () => {
    const h = await startFleet();
    await signIn(h);
    await signIn(h);
    expect(h.notices.filter(n => n.includes("/dashboard revoke"))).toHaveLength(2);
    // Two sign-ins from the same kind of browser are still two notices: the throttle keys on the text.
    expect(new Set(h.notices).size).toBe(2);
    await stop(h.fm);

    const quiet = await startFleet();
    (quiet.fm as unknown as { fleetConfig: unknown }).fleetConfig = { instances: {}, defaults: {}, web: { notify_login: false } };
    await signIn(quiet);
    expect(quiet.notices).toEqual([]);
    await stop(quiet.fm);
  }, 30_000);
});

describe("a signed-in browser", () => {
  it("reaches the panels with nothing but the cookie, and its writes need the CSRF value too", async () => {
    const h = await startFleet();
    const s = await signIn(h);

    for (const path of ["/ui", "/settings", "/ui/backends", "/status"]) {
      expect((await raw(h.port, "GET", path, { cookie: s.cookie })).status, path).toBe(200);
    }
    expect((await raw(h.port, "POST", "/status", { cookie: s.cookie, origin: h.origin })).status).toBe(403);
    expect((await raw(h.port, "POST", "/status", write(h, s))).status).toBe(404); // reached routing
    expect((await raw(h.port, "POST", "/status", { ...write(h, s), origin: "https://evil.example" })).status).toBe(403);
    await stop(h.fm);
  }, 30_000);

  it("says who it is, with the value its page must send, and only to its own session", async () => {
    const h = await startFleet();
    const s = await signIn(h);

    const me = await raw(h.port, "GET", "/auth/session", { cookie: s.cookie });
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body)).toMatchObject({ ok: true, csrf: s.csrf, tier: "admin", surface: "local" });
    expect(me.headers["cache-control"]).toBe("no-store");

    for (const headers of [{}, { cookie: "agend_session=" + "0".repeat(64) }, { "x-agend-token": h.fm.getDashboardAccess().token! }] as Array<Record<string, string>>) {
      expect((await raw(h.port, "GET", "/auth/session", headers)).status).toBe(401);
    }
    await stop(h.fm);
  }, 20_000);

  it("signs out: the cookie stops working and is cleared under both names", async () => {
    const h = await startFleet();
    const s = await signIn(h);

    expect((await raw(h.port, "POST", "/auth/logout", { cookie: s.cookie, origin: h.origin })).status).toBe(403); // no CSRF
    const out = await raw(h.port, "POST", "/auth/logout", write(h, s));
    expect(out.status).toBe(200);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    expect(String(out.headers["set-cookie"])).toContain("__Host-agend_session=;");

    expect((await raw(h.port, "GET", "/ui", { cookie: s.cookie })).status).toBe(401);
    expect((await raw(h.port, "GET", "/auth/session", { cookie: s.cookie })).status).toBe(401);
    await stop(h.fm);
  }, 20_000);

  it("keeps several devices apart: listing, revoking one, then all", async () => {
    const h = await startFleet();
    const phone = await signIn(h);
    const laptop = await signIn(h);

    const list = JSON.parse((await raw(h.port, "GET", "/auth/sessions", { cookie: laptop.cookie })).body).sessions;
    expect(list).toHaveLength(2);
    expect(list.filter((x: { current: boolean }) => x.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(phone.sessionId);
    expect(JSON.stringify(list)).not.toContain(laptop.sessionId);

    const phoneHandle = JSON.parse((await raw(h.port, "GET", "/auth/session", { cookie: phone.cookie })).body).handle;
    // A revoke is a write: no CSRF, no revoke.
    expect((await raw(h.port, "DELETE", `/auth/sessions/${phoneHandle}`, { cookie: laptop.cookie, origin: h.origin })).status).toBe(403);
    const del = await raw(h.port, "DELETE", `/auth/sessions/${phoneHandle}`, write(h, laptop));
    expect(JSON.parse(del.body)).toMatchObject({ ok: true, current: false });
    expect((await raw(h.port, "GET", "/ui", { cookie: phone.cookie })).status).toBe(401);
    expect((await raw(h.port, "GET", "/ui", { cookie: laptop.cookie })).status).toBe(200);

    expect((await raw(h.port, "DELETE", "/auth/sessions/0123456789abcdef", write(h, laptop))).status).toBe(404);
    const all = await raw(h.port, "DELETE", "/auth/sessions", write(h, laptop));
    expect(JSON.parse(all.body)).toMatchObject({ ok: true, revoked: 1 });
    expect((await raw(h.port, "GET", "/ui", { cookie: laptop.cookie })).status).toBe(401);
    await stop(h.fm);
  }, 30_000);

  it("is signed out for good by a token rotation, and by /dashboard revoke", async () => {
    const h = await startFleet();
    const a = await signIn(h);
    const b = await signIn(h);
    expect((await raw(h.port, "GET", "/ui", { cookie: a.cookie })).status).toBe(200);

    rotateWebToken(h.dir);
    expect((await raw(h.port, "GET", "/ui", { cookie: a.cookie })).status).toBe(401);
    expect((await raw(h.port, "GET", "/ui", { cookie: b.cookie })).status).toBe(401);
    await stop(h.fm);

    const h2 = await startFleet();
    const c = await signIn(h2);
    const spare = h2.fm.issueDashboardLogin()!;
    expect(h2.fm.revokeWebSessions()).toBe(1);
    expect((await raw(h2.port, "GET", "/ui", { cookie: c.cookie })).status).toBe(401);
    // The unused code went with them.
    expect((await login(h2, spare.display)).status).toBe(401);
    await stop(h2.fm);
  }, 30_000);

  it("finds its sessions again after a restart (Settings can restart the fleet)", async () => {
    const h = await startFleet();
    const s = await signIn(h);
    await stop(h.fm);

    const fm2 = new FleetManager(h.dir);
    fm2.logger = h.fm.logger;
    (fm2 as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
    (fm2 as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
    await vi.waitFor(() => expect(fm2.getDashboardAccess().ready).toBe(true));
    const address = ((fm2 as unknown as { healthServer: Server }).healthServer).address();
    if (!address || typeof address === "string") throw new Error("missing TCP address");

    expect((await raw(address.port, "GET", "/ui", { cookie: s.cookie })).status).toBe(200);
    await stop(fm2);
  }, 30_000);

  it("replaces, not upgrades, the cookie it already had when it signs in again", async () => {
    const h = await startFleet();
    const first = await signIn(h);
    const issued = h.fm.issueDashboardLogin()!;
    const second = await login(h, issued.display, { cookie: first.cookie });
    const secondCookie = cookieOf(second);

    expect(secondCookie).not.toBe(first.cookie);
    expect((await raw(h.port, "GET", "/ui", { cookie: first.cookie })).status).toBe(401);
    expect((await raw(h.port, "GET", "/ui", { cookie: secondCookie })).status).toBe(200);
    await stop(h.fm);
  }, 20_000);

  it("is never handed a session id of its own choosing", async () => {
    const h = await startFleet();
    const chosen = "f".repeat(64);
    const issued = h.fm.issueDashboardLogin()!;
    const res = await login(h, issued.display, { cookie: `agend_session=${chosen}` });

    expect(cookieOf(res)).not.toBe(`agend_session=${chosen}`);
    expect((await raw(h.port, "GET", "/ui", { cookie: `agend_session=${chosen}` })).status).toBe(401);
    await stop(h.fm);
  }, 20_000);
});

describe("the old ways in", () => {
  it("a ?token= link is no longer redeemed for a session (S2: no credential in a URL)", async () => {
    const h = await startFleet();
    const token = h.fm.getDashboardAccess().token!;
    const link = await raw(h.port, "GET", `/ui?token=${token}`);
    expect(link.status).toBe(401);
    expect(link.headers["set-cookie"]).toBeUndefined();
    expect(link.headers.location).toBeUndefined();
    // Nothing was minted: a session made by signing in is the only one listed.
    const s = await signIn(h);
    const list = JSON.parse((await raw(h.port, "GET", "/auth/sessions", { cookie: s.cookie })).body).sessions;
    expect(list).toHaveLength(1);
    await stop(h.fm);
  }, 20_000);

  it("keeps the header token working for scripts, and lets it ask for a login code", async () => {
    const h = await startFleet();
    const token = h.fm.getDashboardAccess().token!;

    expect((await raw(h.port, "GET", "/status", { "x-agend-token": token })).status).toBe(200);

    expect((await raw(h.port, "POST", "/auth/issue-code")).status).toBe(401);
    expect((await raw(h.port, "POST", "/auth/issue-code", { "x-agend-token": "0".repeat(48) })).status).toBe(401);
    expect((await raw(h.port, "GET", "/auth/issue-code", { "x-agend-token": token })).status).toBe(405);
    const issued = await raw(h.port, "POST", "/auth/issue-code", { "x-agend-token": token });
    expect(issued.status).toBe(200);
    const { code } = JSON.parse(issued.body);
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect((await login(h, code)).status).toBe(200);
    await stop(h.fm);
  }, 20_000);

  it("does not accept a session cookie as a code-issuing credential", async () => {
    const h = await startFleet();
    const s = await signIn(h);
    expect((await raw(h.port, "POST", "/auth/issue-code", write(h, s))).status).toBe(401);
    await stop(h.fm);
  }, 20_000);
});

describe("agend web --code", () => {
  it("asks the running fleet for a code over loopback, and the code signs in", async () => {
    const h = await startFleet();
    writeFileSync(join(h.dir, "fleet.yaml"), `health_port: ${h.port}\ndefaults:\n  backend: claude-code\ninstances: {}\n`);

    const out = await new Promise<string>((resolve, reject) => {
      execFile(join(process.cwd(), "node_modules", ".bin", "tsx"), [join(process.cwd(), "src", "cli.ts"), "web", "--code"],
        { encoding: "utf8", env: { ...process.env, AGEND_HOME: h.dir }, timeout: 40_000 },
        (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
    });

    expect(out).toContain(`http://localhost:${h.port}/signin`);
    const code = /Code:\s+([A-Z2-7]{4}-[A-Z2-7]{4})/.exec(out)?.[1];
    expect(code).toBeTruthy();
    // The web token is not printed: the code is the only secret on the screen.
    expect(out).not.toContain(h.fm.getDashboardAccess().token!);
    expect((await login(h, code!)).status).toBe(200);
    await stop(h.fm);
  }, 60_000);
});

describe("the pages themselves", () => {
  it("load the CSRF helper, and nothing in them carries a credential", () => {
    for (const page of ["dashboard.html", "settings.html"]) {
      const html = readFileSync(join(process.cwd(), "src", "ui", page), "utf8");
      expect(html, page).toContain('<script src="/assets/agend-auth.js"></script>');
    }
    const signin = readFileSync(join(process.cwd(), "src", "ui", "signin.html"), "utf8");
    expect(signin).toContain('<script src="/assets/signin.js"></script>');
  });

  it("only ever navigates to one of the three panels after signing in", () => {
    const js = readFileSync(join(process.cwd(), "src", "ui", "shared", "signin.js"), "utf8");
    expect(js).toContain("(ui|view|settings)");
    expect(js).toContain('searchParams.delete("token")');
  });
});

describe("signin.js, run against a fake page", () => {
  /** Run the served script with a page at `href`; returns what it did to the address bar. */
  async function load(href: string) {
    const { readFileSync } = await import("node:fs");
    const vm = await import("node:vm");
    const url = new URL(href);
    const replaced: string[] = [];
    const el = () => ({ hidden: false, textContent: "", value: "", disabled: false, addEventListener() {}, focus() {}, select() {} });
    const elements: Record<string, ReturnType<typeof el>> = {};
    const context = vm.createContext({
      document: { documentElement: {}, getElementById: (id: string) => (elements[id] ??= el()), querySelectorAll: () => [] },
      location: { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash, origin: url.origin, replace() {} },
      history: { replaceState: (_s: unknown, _t: unknown, u: string) => { replaced.push(u); } },
      navigator: { language: "en" },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      fetch: () => new Promise(() => {}),       // the session probe never answers: only the load-time work runs
      URL, URLSearchParams, JSON, Date, Number, String,
    });
    vm.runInContext(readFileSync(join(process.cwd(), "src", "ui", "shared", "signin.js"), "utf8"), context);
    return replaced;
  }

  it("takes an old link's ?token= out of the address bar and the history entry, keeping everything else", async () => {
    const token = "f".repeat(48);
    expect(await load(`http://127.0.0.1:1/ui?token=${token}`)).toEqual(["/ui"]);
    expect(await load(`http://127.0.0.1:1/settings?tab=2&token=${token}#x`)).toEqual(["/settings?tab=2#x"]);
  });

  it("leaves an address without one alone", async () => {
    expect(await load("http://127.0.0.1:1/signin?next=%2Fui")).toEqual([]);
    expect(await load("http://127.0.0.1:1/ui")).toEqual([]);
  });
});

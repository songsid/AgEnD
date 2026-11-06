/**
 * Refs #3061 (P2a), review of #3165 (P2 1): a stale sign-in call must not change the cookie of the attempt after it.
 *
 * Asking for a code, cancelling it and polling it each answer with a Set-Cookie for the request's HttpOnly cookie, and a browser
 * applies a cookie when the answer ARRIVES, not when the page asked. So when Back and a new attempt overtake a call that is still
 * on the wire, the late answer used to replace the new attempt's cookie (a delayed create), or expire it (a delayed cancel, or a
 * poll that found its request spent): the new attempt then polled with the wrong request, or none, and read "expired" after its
 * owner had approved it. `mine.stopped` drops a stale call's JavaScript result but cannot stop the browser applying its cookie.
 *
 * What is real here: the sign-in page's own script (src/ui/shared/signin.js, in a vm), the real routes (handleAuthRequest) over a
 * real HTTP socket, the real request table (DeviceLoginRequests) and the real cookie builders. What stands in for the browser is a
 * cookie jar that applies Set-Cookie in the order the ANSWERS ARRIVE, with a hold on any call's request (before the server sees it)
 * or answer (before the browser does) — the existing VM fixture only returns JSON, which cannot show this. A manual clock drives
 * the page's timers.
 *
 * SIGNIN_SRC=<file> runs the same tests against another copy of the script (how the pre-fix script was shown to fail them).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInContext, createContext } from "node:vm";
import { handleAuthRequest } from "../src/auth-api.js";
import { tokenEpoch, WebSessionStore } from "../src/web-session.js";
import { DeviceLoginRequests, DEVICE_LOGIN_TTL_MS } from "../src/web-device-login.js";

const SRC = readFileSync(process.env.SIGNIN_SRC ?? join(process.cwd(), "src", "ui", "shared", "signin.js"), "utf8");
const HTML = readFileSync(join(process.cwd(), "src", "ui", "signin.html"), "utf8");
const TOKEN = "race-test-web-token-0123456789abcdef";
const EPOCH = tokenEpoch(TOKEN);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const micro = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// ── The server: the real auth routes and the real request table ──
const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }); });
async function startServer() {
  const skew = { ms: 0 };                                                              // the server's clock, movable: a request can really run out
  const logins = new DeviceLoginRequests({ now: () => Date.now() + skew.ms });
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, trace() {}, fatal() {}, child() { return quiet; } };
  const ctx = { webToken: TOKEN, webSessions: new WebSessionStore(), webLoginCodes: null, webDeviceLogins: logins, deviceLoginAvailable: () => true,
    isWebOnlyFleet: () => true, logger: quiet } as never;
  const server = createServer((req: IncomingMessage, res) => {
    if (!handleAuthRequest(req, res, new URL(req.url ?? "/", `http://${req.headers.host}`), ctx)) { res.writeHead(404); res.end(); }
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { logins, port, origin: `http://127.0.0.1:${port}`, serverClockForward: (ms: number) => { skew.ms += ms; } };
}

// ── The browser's network: a cookie jar that applies Set-Cookie when an answer arrives, and calls that can be held ──
type Hold = { request?: boolean; response?: boolean };
interface Call { n: number; path: string; cookie: string; phase: "held-request" | "in-flight" | "held-response" | "done"; aborted: boolean; releaseRequest(): void; releaseResponse(): void; status?: number }
class Net {
  readonly jar = new Map<string, string>();
  readonly calls: Call[] = [];
  private readonly holds: Array<{ path: string; hold: Hold }> = [];
  constructor(private readonly port: number, private readonly origin: string) {}
  /** The next call to `path` is held: its request (the server has not seen it) and/or its answer (the browser has not). */
  holdNext(path: string, hold: Hold): void { this.holds.push({ path, hold }); }
  /** The device-login calls, in the order the page made them. */
  device(): Call[] { return this.calls.filter(c => c.path.startsWith("/auth/device-login")); }
  cookieValue(prefix: string): string | undefined { for (const [k, v] of this.jar) if (k.includes(prefix)) return v; return undefined; }
  private apply(setCookie: string[]): void {
    for (const line of setCookie) {
      const parts = line.split(";").map(p => p.trim()), eq = parts[0]!.indexOf("=");
      const name = parts[0]!.slice(0, eq), value = parts[0]!.slice(eq + 1);
      const maxAge = parts.find(p => /^max-age=/i.test(p));
      if (value === "" || (maxAge && Number(maxAge.split("=")[1]) <= 0)) this.jar.delete(name); else this.jar.set(name, value);
    }
  }
  fetch = (url: string, init: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) => new Promise<unknown>((resolve, reject) => {
    const at = this.holds.findIndex(h => h.path === url);
    const hold: Hold = at >= 0 ? this.holds.splice(at, 1)[0]!.hold : {};
    const call: Call = { n: this.calls.length + 1, path: url, cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "), phase: hold.request ? "held-request" : "in-flight", aborted: false,
      releaseRequest: () => {}, releaseResponse: () => {} };
    this.calls.push(call);
    const finish = (settle: () => void) => { call.phase = "done"; settle(); };
    init.signal?.addEventListener("abort", () => {
      if (call.phase === "done") return;
      call.aborted = true;                                                       // an aborted call's answer is never applied
      finish(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const send = () => {
      if (call.aborted) return;
      call.phase = "in-flight";
      const req = request({ host: "127.0.0.1", port: this.port, method: init.method ?? "GET", path: url,
        headers: { origin: this.origin, "content-type": "application/json", "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0 Mobile Safari/537.36", ...(call.cookie ? { cookie: call.cookie } : {}), ...init.headers } }, res => {
        let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
        res.on("end", () => {
          const deliver = () => {
            if (call.aborted) return;
            const set = res.headers["set-cookie"] ?? [];
            this.apply(Array.isArray(set) ? set : [set]);
            call.status = res.statusCode ?? 0;
            finish(() => resolve({ ok: (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, headers: { get: (h: string) => (res.headers[h.toLowerCase()] as string | undefined) ?? null },
              json: async () => JSON.parse(text) }));
          };
          if (hold.response) { call.phase = "held-response"; call.releaseResponse = deliver; } else deliver();
        });
      });
      req.on("error", err => { if (call.phase !== "done") finish(() => reject(err)); });
      req.end(init.body);
    };
    if (hold.request) call.releaseRequest = send; else send();
  });
  /** Until no call is travelling: each is finished or parked at a hold (and the page has reacted to what finished). */
  async idle(): Promise<void> {
    for (let round = 0; round < 400; round++) {
      await micro();
      if (!this.calls.some(c => c.phase === "in-flight")) { await sleep(1); await micro(); if (!this.calls.some(c => c.phase === "in-flight")) return; }
      await sleep(1);
    }
    throw new Error("the network never went idle");
  }
}

// ── The page: the real script in a vm, with a manual clock ──
async function startPage(lang = "en") {
  const server = await startServer();
  const net = new Net(server.port, server.origin);
  const handlers: Record<string, () => unknown> = {};
  const hiddenAtStart = new Set(["resend", "form", "another", "device", "devNew", "devQr"]);
  const elements: Record<string, any> = {};
  const el = (id: string) => (elements[id] ??= { id, hidden: hiddenAtStart.has(id), textContent: "", value: "123456", disabled: false, classes: new Set<string>(),
    classList: { add(c: string) { elements[id].classes.add(c); }, remove(c: string) { elements[id].classes.delete(c); } },
    addEventListener(type: string, fn: () => unknown) { handlers[`${id}:${type}`] = fn; }, focus() {}, select() {}, attrs: {} as Record<string, string>, children: [] as unknown[],
    setAttribute(k: string, v: string) { this.attrs[k] = v; }, replaceChildren(...c: unknown[]) { this.children = c; } });
  const i18n = [...HTML.matchAll(/data-i18n="([a-z_]+)"/g)].map(m => ({ attr: m[1]!, textContent: "", getAttribute() { return this.attr; }, replaceChildren(...c: unknown[]) { this.textContent = c.join(""); } }));
  const replaced: string[] = [];
  let now = 1_800_000_000_000, nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void; every: number }>();
  const addTimer = (every: boolean) => (fn: () => void, ms = 0) => { const id = nextId++; timers.set(id, { at: now + Math.max(0, ms), fn, every: every ? Math.max(1, ms) : 0 }); return id; };
  const context = createContext({
    document: { documentElement: {}, getElementById: (id: string) => el(id), querySelectorAll: (sel: string) => (sel === "details.help" ? [] : i18n),
      body: { getAttribute: (name: string) => (name === "data-web-only" || name === "data-device-login" ? "1" : null) },
      createElement: (tag: string) => ({ tag, textContent: "" }), createElementNS: (_ns: string, tag: string) => ({ tag, attrs: {}, setAttribute() {} }) },
    location: { href: `${server.origin}/signin`, pathname: "/signin", search: "", hash: "", origin: server.origin, hostname: "127.0.0.1", replace(to: string) { replaced.push(to); } },
    history: { replaceState() {} }, navigator: { language: lang }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: net.fetch, AbortController, URL, URLSearchParams, JSON, Date: { now: () => now }, Number, String, Math, Promise,
    setTimeout: addTimer(false), setInterval: addTimer(true), clearTimeout: (id: number) => { timers.delete(id); }, clearInterval: (id: number) => { timers.delete(id); },
  });
  runInContext(SRC, context);
  /** Moves the page's clock forward, running its timers (and letting the network settle after each) in order. */
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      let nextTimer: [number, { at: number; fn: () => void; every: number }] | null = null;
      for (const entry of timers) if (entry[1].at <= until && (!nextTimer || entry[1].at < nextTimer[1].at)) nextTimer = entry;
      if (!nextTimer) break;
      const [id, timer] = nextTimer;
      now = Math.max(now, timer.at);
      if (timer.every) timer.at += timer.every; else timers.delete(id);
      timer.fn();
      await net.idle();
    }
    now = until;
    await net.idle();
  };
  await net.idle();
  const click = async (id: string) => { await handlers[`${id}:click`]!(); await net.idle(); };
  const text = (id: string) => elements[id]?.textContent as string;
  return { ...server, net, el, text, click, advance, replaced, handlers };
}
type Page = Awaited<ReturnType<typeof startPage>>;

/** The owner approves the code the page is showing (what the verified owner's "Add device" does, minus the HTTP in front of it). */
function approve(p: Page, code = p.text("devCode")): void {
  const decided = p.logins.decide(code, "approved", "owner-session-handle", EPOCH);
  expect(decided.kind, `approving ${code}`).toBe("ok");
}
/** The page polls every two seconds: let it, and say whether it carried on to the app. */
async function signsIn(p: Page): Promise<boolean> {
  await p.advance(2000);
  await p.advance(2000);
  return p.replaced.length === 1 && p.replaced[0] === "/ui";
}
const cookieOfAttempt = (p: Page) => p.net.cookieValue("agend_device_login");
const creates = (p: Page) => p.net.device().filter(c => c.path === "/auth/device-login");

describe("#3061 P2a review: a stale sign-in call cannot change the cookie of the attempt after it", () => {
  it("control: Back, then a new attempt, with nothing delayed — the first request is withdrawn on the server, the second one signs in", async () => {
    const p = await startPage();
    await p.click("another");
    const first = p.text("devCode");
    expect(first).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const idA = cookieOfAttempt(p);
    expect(idA).toMatch(/^[0-9a-f]{64}$/);
    await p.click("devBack");
    expect(cookieOfAttempt(p)).toBeUndefined();                                      // cancelled: the cookie is gone
    expect(p.logins.lookup(first, EPOCH).kind).toBe("invalid");                       // …and so is the request
    await p.click("another");
    const second = p.text("devCode");
    expect(second).not.toBe(first);
    expect(cookieOfAttempt(p)).toMatch(/^[0-9a-f]{64}$/);
    approve(p);
    expect(await signsIn(p)).toBe(true);
    expect(p.net.cookieValue("agend_session") ?? [...p.net.jar.keys()].join()).toBeTruthy();
    expect(cookieOfAttempt(p)).toBeUndefined();                                      // the poll that claimed it spent the cookie too
  });

  it("A's CANCEL answer arrives after B was asked for: the new attempt keeps its cookie and signs in once approved", async () => {
    const p = await startPage();
    await p.click("another");
    const a = p.text("devCode");
    p.net.holdNext("/auth/device-login/cancel", { response: true });                // the server withdraws A; the answer (Set-Cookie: gone) is slow
    await p.click("devBack");
    expect(p.net.device().at(-1)).toMatchObject({ path: "/auth/device-login/cancel", phase: "held-response" });
    await p.click("another");                                                         // a new attempt while A's cancel is still out
    // The page does not ask for B until A's cancel has finished: nothing on the wire could still change B's cookie.
    expect(creates(p).length).toBe(1);
    p.net.device().find(c => c.phase === "held-response")!.releaseResponse();
    await p.net.idle();
    const b = p.text("devCode");
    expect(b).not.toBe(a);
    expect(creates(p).length).toBe(2);
    expect(cookieOfAttempt(p)).toMatch(/^[0-9a-f]{64}$/);
    approve(p);
    expect(await signsIn(p)).toBe(true);
  });

  it("A's CREATE answer arrives after B's would have: B still polls with its own request, and A's is withdrawn", async () => {
    const p = await startPage();
    p.net.holdNext("/auth/device-login", { response: true });                       // A's create reaches the server; its answer (the cookie) is slow
    await p.click("another");
    expect(p.net.device()[0]).toMatchObject({ path: "/auth/device-login", phase: "held-response" });
    const a = [...p.logins["entries"].values()][0]!.code as string;                    // the request the server made for A
    await p.click("devBack");                                                         // Back while A's create is still out
    await p.click("another");                                                         // …and a new attempt B
    expect(creates(p).length).toBe(1);                                                // B waits for A's create to finish (it needs the cookie that call sets)
    p.net.device()[0]!.releaseResponse();
    await p.net.idle();
    // A was withdrawn by its own cancel (which carried A's cookie) before B asked, so A's code no longer approves anything.
    expect(p.logins.lookup(`${a.slice(0, 4)}-${a.slice(4)}`, EPOCH).kind).toBe("invalid");
    const b = p.text("devCode");
    expect(b).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(creates(p).length).toBe(2);
    approve(p);
    expect(await signsIn(p)).toBe(true);
  });

  // The poll is the third call that carries a Set-Cookie: when it finds its request over — denied, or out of time / gone, which the
  // server answers "expired" — it clears the cookie. Held on the wire while Back and a new attempt happen, its late answer must not
  // reach the cookie of the new code.
  for (const over of ["denied", "expired"] as const) {
    it(`a POLL answer that finds the old request ${over} arrives after the new attempt: it cannot clear the new cookie`, async () => {
      const p = await startPage();
      await p.click("another");
      const a = p.text("devCode");
      if (over === "denied") expect(p.logins.decide(a, "denied", "owner-session-handle", EPOCH).kind).toBe("ok");
      else p.serverClockForward(DEVICE_LOGIN_TTL_MS + 1000);                          // the request ran out on the server
      p.net.holdNext("/auth/device-login/poll", { response: true });                  // the poll finds it over (Set-Cookie: gone); the answer is slow
      await p.advance(2000);
      const poll = p.net.device().find(c => c.phase === "held-response")!;
      expect(poll.path).toBe("/auth/device-login/poll");
      await p.click("devBack");
      await p.click("another");
      expect(creates(p).length).toBe(1);                                              // B is not asked for while the stale poll is still on the wire
      poll.releaseResponse();
      await p.net.idle();
      expect(creates(p).length).toBe(2);
      expect(cookieOfAttempt(p)).toMatch(/^[0-9a-f]{64}$/);
      approve(p);
      expect(await signsIn(p)).toBe(true);
    });
  }

  it("a stale POLL given up on after 15 s: its answer, arriving after the new attempt was asked for, is dropped and the new cookie stands", async () => {
    const p = await startPage();
    await p.click("another");
    const a = p.text("devCode");
    const cookieA = cookieOfAttempt(p);
    expect(p.logins.decide(a, "denied", "owner-session-handle", EPOCH).kind).toBe("ok");
    p.net.holdNext("/auth/device-login/poll", { response: true });                    // the stale poll's answer (Set-Cookie: gone) never comes in time
    await p.advance(2000);
    const poll = p.net.device().find(c => c.phase === "held-response")!;
    await p.click("devBack");
    await p.click("another");
    expect(creates(p).length).toBe(1);
    await p.advance(15_000);                                                          // the page gives the poll up (abort); the queue moves on
    expect(poll.aborted).toBe(true);
    expect(creates(p).length).toBe(2);                                                // B was asked for BEFORE the stale answer arrives…
    const cookieB = cookieOfAttempt(p);
    expect(cookieB).toMatch(/^[0-9a-f]{64}$/);
    expect(cookieB).not.toBe(cookieA);
    poll.releaseResponse();                                                           // …and now it does: an aborted call's answer is never applied
    await p.net.idle();
    expect(cookieOfAttempt(p)).toBe(cookieB);
    approve(p);
    expect(await signsIn(p)).toBe(true);
  });

  it("the same, with \"Get a new code\" instead of Back (a new attempt straight over a held one)", async () => {
    const p = await startPage();
    p.net.holdNext("/auth/device-login", { response: true });
    await p.click("another");
    await p.click("another");                                                         // the button on the same screen: asks again
    expect(creates(p).length).toBe(1);
    p.net.device()[0]!.releaseResponse();
    await p.net.idle();
    expect(creates(p).length).toBe(2);
    approve(p);
    expect(await signsIn(p)).toBe(true);
  });

  it("an attempt stopped before its turn is never sent: Back while a new create waits behind a slow cancel", async () => {
    // (The same guard covers a poll queued behind another call, but the page cannot make one: Back clears the attempt's poll timer and a poll
    // is only scheduled after an answer. A create queued behind a held call is how an attempt gets stopped before its turn.)
    const p = await startPage();
    await p.click("another");                                                         // attempt Z
    p.net.holdNext("/auth/device-login/cancel", { response: true });
    await p.click("devBack");                                                         // Z's cancel is out, its answer slow
    await p.click("another");                                                         // attempt A: its create waits behind Z's cancel
    expect(creates(p).length).toBe(1);
    await p.click("devBack");                                                         // …and A is stopped before its turn
    p.net.device().find(c => c.phase === "held-response")!.releaseResponse();
    await p.net.idle();
    expect(creates(p).length).toBe(1);                                                // A's create was never sent: nothing was made for an attempt the person left
    expect(p.logins.size).toBe(0);
    // The page is not left stuck: the next attempt asks for its code and signs in once approved.
    await p.click("another");
    expect(creates(p).length).toBe(2);
    approve(p);
    expect(await signsIn(p)).toBe(true);
  });

  it("a call that never answers does not wedge the page: it is given up on after 15 s, and the next attempt goes ahead", async () => {
    const p = await startPage();
    p.net.holdNext("/auth/device-login", { request: true });                        // A's create never reaches the server
    await p.click("another");
    await p.click("devBack");
    await p.click("another");
    await p.advance(14_000);
    expect(creates(p).length).toBe(1);                                                // still waiting its turn
    await p.advance(2_000);
    expect(creates(p).length).toBe(2);
    expect(p.net.device()[0]!.aborted).toBe(true);
    expect(p.text("devCode")).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    approve(p);
    expect(await signsIn(p)).toBe(true);
  });
});

/**
 * Refs #3061 (P2a): the sign-in page's "Sign in with another device" (signin.html + shared/signin.js), the real script in a vm
 * as signin-outside-3008.test.ts loads it:
 *  - the button shows only on a web-only fleet's own listener (<body data-web-only data-device-login>), never from outside
 *    (the app's code only) and never on a chat fleet's page;
 *  - it asks POST /auth/device-login (never a GET), shows the code, counts down, and polls POST /auth/device-login/poll;
 *  - approved → it carries on to the page that was asked for; denied and expired say so and offer a new code; the pause (429),
 *    a full room (503) and an absent route (404) are said in words;
 *  - Back withdraws the request (POST …/cancel) and returns to the one-time code form;
 *  - English and 繁體中文.
 * Refs #3061 (P2b), the last describe: with <body data-login-qr="1"> (web.login_qr) it also draws the QR code of the approve link
 * beside the code — the page's own address and the code on screen, NOTHING else (no request id, cookie or token) — and only
 * where another device could open it (not as localhost); it goes with the code (new code, expired, denied, Back), is never drawn
 * without the mark, and its words are English and 繁體中文. The real encoder (qrcode.module.js) is handed in through the one
 * `import()` the script makes, and records what it was asked to encode.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "src", "ui", "shared", "signin.js"), "utf8");
const HTML = readFileSync(join(process.cwd(), "src", "ui", "signin.html"), "utf8");
afterEach(() => { vi.useRealTimers(); });

type Reply = { status: number; body?: unknown; retryAfter?: string };
async function page(language: string, opts: { deviceLogin?: boolean; webOnly?: boolean; outside?: boolean; replies?: Record<string, Reply[]>;
  loginQr?: boolean; hostname?: string; origin?: string; encoder?: () => Promise<unknown> } = {}) {
  const vm = await import("node:vm");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const handlers: Record<string, (e?: unknown) => unknown> = {};
  const hiddenAtStart = new Set(["resend", "form", "another", "device", "devNew", "devQr"]);
  const elements: Record<string, any> = {};
  const el = (id: string) => (elements[id] ??= { id, hidden: hiddenAtStart.has(id), textContent: "", value: "123456", disabled: false,
    classes: new Set<string>(), classList: { add(c: string) { elements[id].classes.add(c); }, remove(c: string) { elements[id].classes.delete(c); } },
    addEventListener(type: string, fn: (e?: unknown) => unknown) { handlers[`${id}:${type}`] = fn; }, focus() {}, select() {},
    attrs: {} as Record<string, string>, children: [] as any[], setAttribute(k: string, v: string) { this.attrs[k] = v; }, replaceChildren(...c: any[]) { this.children = c; } });
  const i18n = [...HTML.matchAll(/data-i18n="([a-z_]+)"/g)].map(m => ({ attr: m[1]!, textContent: "", getAttribute() { return this.attr; }, replaceChildren(...c: unknown[]) { this.textContent = c.join(""); } }));
  const calls: Array<{ url: string; method: string }> = [];
  const replaced: string[] = [];
  const replies = opts.replies ?? {};
  const webOnly = opts.webOnly ?? true;
  const context = vm.createContext({
    document: { documentElement: {}, getElementById: (id: string) => el(id),
      querySelectorAll: (sel: string) => (sel === "details.help" ? [] : i18n),
      body: { getAttribute: (name: string) => (name === "data-web-only" && webOnly ? "1" : name === "data-outside" && opts.outside ? "1" : name === "data-device-login" && opts.deviceLogin ? "1" : name === "data-login-qr" && opts.loginQr ? "1" : null) },
      createElement: (tag: string) => ({ tag, textContent: "" }),
      createElementNS: (_ns: string, tag: string) => ({ tag, attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; } }) },
    location: { href: `${opts.origin ?? "http://127.0.0.1:19280"}/signin`, pathname: "/signin", search: "", hash: "", origin: opts.origin ?? "http://127.0.0.1:19280", hostname: opts.hostname ?? "127.0.0.1", replace(to: string) { replaced.push(to); } },
    history: { replaceState() {} }, navigator: { language }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/auth/session") return { ok: false, status: 401 };
      if (url === "/auth/device") return { ok: true, status: 200, json: async () => ({ returning: false }) };
      const queue = replies[url];
      const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
      if (!next) throw new Error(`no reply for ${url}`);
      return { ok: next.status < 300, status: next.status, headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? next.retryAfter ?? null : null) },
        json: async () => { if (next.body === undefined) throw new Error("no body"); return next.body; } };
    },
    URL, URLSearchParams, JSON, Date, Number, String, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    __encoder: opts.encoder ?? (() => Promise.reject(new Error("no encoder"))),
  });
  // The script's one dynamic import is the encoder: a vm script has no module loader, so it is handed in (and the
  // replacement is checked to be of that one import and no other).
  expect(SRC.split('import("/assets/qrcode.module.js")').length - 1).toBe(1);
  vm.runInContext(SRC.replace('import("/assets/qrcode.module.js")', "__encoder()"), context);
  const flush = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); for (let n = 0; n < 20; n++) await Promise.resolve(); };
  await flush();
  const text = (id: string) => elements[id]?.textContent as string;
  return { el, handlers, calls, replaced, flush, text, i18n: (attr: string) => i18n.find(x => x.attr === attr)?.textContent, click: async (id: string) => { await handlers[`${id}:click`]!(); await flush(); },
    posts: () => calls.filter(c => c.url.startsWith("/auth/device-login")).map(c => `${c.method} ${c.url}`) };
}

const ASKED: Reply = { status: 200, body: { code: "ABCD-EFGH", expiresAt: Date.now() + 300_000, ttlMs: 300_000 } };
const PENDING: Reply = { status: 200, body: { state: "pending", expiresAt: Date.now() + 300_000 } };

describe("#3061 P2a the sign-in page: Sign in with another device", () => {
  it("the button shows only on a web-only fleet's own listener — not from outside, not on a chat fleet's page, not unmarked", async () => {
    expect((await page("en", { deviceLogin: true })).el("another").hidden).toBe(false);
    expect((await page("en", { deviceLogin: true, outside: true })).el("another").hidden).toBe(true);
    expect((await page("en", { deviceLogin: true, webOnly: false })).el("another").hidden).toBe(true);
    expect((await page("en", {})).el("another").hidden).toBe(true);
  });

  it("the markup: the button, the code, the countdown line and the way back — all in the page's own words (no inline script)", () => {
    expect(HTML).toContain('id="another"');
    for (const id of ["device", "devCode", "devStatus", "devNew", "devBack"]) expect(HTML).toContain(`id="${id}"`);
    expect(HTML).not.toMatch(/\son[a-z]+=|style="/);
  });

  it("asks with a POST, shows the code and a countdown, polls with POSTs until approved — then carries on to the app", async () => {
    const p = await page("en", { deviceLogin: true, replies: {
      "/auth/device-login": [ASKED],
      "/auth/device-login/poll": [PENDING, PENDING, { status: 200, body: { state: "approved", ok: true, tier: "admin" } }],
    } });
    await p.click("another");
    expect([p.el("form").hidden, p.el("device").hidden]).toEqual([true, false]);
    expect(p.text("devCode")).toBe("ABCD-EFGH");
    expect(p.text("devStatus")).toBe("Waiting for approval… Expires in 5:00.");
    await p.flush(2000);
    expect(p.text("devStatus")).toMatch(/^Waiting for approval… Expires in 4:5\d\.$/);
    await p.flush(2000);
    await p.flush(2000);
    expect(p.replaced).toEqual(["/ui"]);
    expect(p.text("devStatus")).toBe("Approved — signing in…");
    expect(p.posts()).toEqual(["POST /auth/device-login", "POST /auth/device-login/poll", "POST /auth/device-login/poll", "POST /auth/device-login/poll"]);
    expect(p.calls.every(c => c.method === "POST" || !c.url.startsWith("/auth/device-login"))).toBe(true);      // never a GET
  });

  it("denied and expired say so, strike the code, and offer a new one — which asks again; polling stops", async () => {
    const p = await page("en", { deviceLogin: true, replies: {
      "/auth/device-login": [ASKED, { status: 200, body: { code: "WXYZ-2345", ttlMs: 300_000 } }],
      "/auth/device-login/poll": [{ status: 200, body: { state: "denied" } }, PENDING, { status: 200, body: { state: "expired" } }],
    } });
    await p.click("another");
    await p.flush(2000);
    expect([p.text("devStatus"), p.el("devNew").hidden, p.el("devCode").classes.has("spent")]).toEqual(["This request was denied.", false, true]);
    const seen = p.posts().length;
    await p.flush(10_000);
    expect(p.posts().length).toBe(seen);                                                                          // stopped
    await p.click("devNew");
    expect([p.text("devCode"), p.el("devNew").hidden, p.el("devCode").classes.has("spent")]).toEqual(["WXYZ-2345", true, false]);
    await p.flush(2000);                                                                                          // pending
    await p.flush(2000);                                                                                          // expired
    expect([p.text("devStatus"), p.el("devNew").hidden]).toEqual(["This code has expired.", false]);
  });

  it("Back withdraws the request and returns to the one-time code form; leaving stops the polling", async () => {
    const p = await page("en", { deviceLogin: true, replies: {
      "/auth/device-login": [ASKED], "/auth/device-login/poll": [PENDING], "/auth/device-login/cancel": [{ status: 200, body: { ok: true } }],
    } });
    await p.click("another");
    await p.flush(2000);
    await p.click("devBack");
    expect([p.el("form").hidden, p.el("device").hidden]).toEqual([false, true]);
    expect(p.posts().at(-1)).toBe("POST /auth/device-login/cancel");
    const seen = p.posts().length;
    await p.flush(10_000);
    expect(p.posts().length).toBe(seen);
  });

  it.each([
    [429, { error: "limited", retryAfterMs: 120_000 }, "Too many codes asked for. Try again in 2 minutes."],
    [503, { error: "busy" }, "Too many devices are waiting right now. Try again in a moment."],
    [404, { error: "not_found" }, "Signing in with another device isn't available here."],
    [500, undefined, "Could not get a code. Check the connection and try again."],
  ] as const)("asking answered %i: said in words, with a way to ask again", async (status, body, words) => {
    const p = await page("en", { deviceLogin: true, replies: { "/auth/device-login": [{ status, ...(body ? { body } : {}) }] } });
    await p.click("another");
    expect([p.text("devStatus"), p.el("devNew").hidden]).toEqual([words, false]);
    expect(p.posts()).toEqual(["POST /auth/device-login"]);                                                       // and no polling for a code that never came
  });

  it("a poll the network drops is tried again; the code's own time well past ends it", async () => {
    const p = await page("en", { deviceLogin: true, replies: { "/auth/device-login": [{ status: 200, body: { code: "ABCD-EFGH", ttlMs: 10_000 } }], "/auth/device-login/poll": [{ status: 500 }] } });
    await p.click("another");
    await p.flush(2000); await p.flush(2000); await p.flush(2000);
    expect(p.text("devStatus")).toBe("Could not reach AgEnD. Still trying…");
    await p.flush(30_000);
    expect(p.text("devStatus")).toBe("This code has expired.");
  });

  it("the page's words name the path that exists today: Settings → Access & security, Devices & sign-in, Add device (and say nothing of a sub-page it does not have)", async () => {
    const p = await page("en", { deviceLogin: true, replies: {} });
    expect(p.i18n("dev_lead")).toBe("On a device that is already signed in to AgEnD as the owner, open Settings → Access & security, choose Add device under Devices & sign-in, and enter this code.");
    expect(HTML).toContain("open Settings → Access &amp; security, choose Add device under Devices &amp; sign-in, and enter this code.");
    expect(SRC).not.toContain("Access & security → Add device");
  });

  it("the route closing while the device waits (web authorization turned off): the poll's 404 ends it with the unavailable line — it does not keep asking", async () => {
    const p = await page("en", { deviceLogin: true, replies: { "/auth/device-login": [ASKED], "/auth/device-login/poll": [PENDING, { status: 404, body: { error: "not_found" } }] } });
    await p.click("another");
    await p.flush(2000);
    await p.flush(2000);
    expect([p.text("devStatus"), p.el("devNew").hidden, p.el("devCode").classes.has("spent")]).toEqual(["Signing in with another device isn't available here.", false, true]);
    const seen = p.posts().length;
    await p.flush(20_000);
    expect(p.posts().length).toBe(seen);
  });

  it("zh-TW: the button, the page and the answers", async () => {
    const p = await page("zh-TW", { deviceLogin: true, replies: {
      "/auth/device-login": [ASKED], "/auth/device-login/poll": [{ status: 200, body: { state: "expired" } }] } });
    expect([p.i18n("another"), p.i18n("dev_title"), p.i18n("dev_new"), p.i18n("dev_back")]).toEqual(["使用其他裝置登入", "使用其他裝置登入", "取得新代碼", "返回"]);
    expect(p.i18n("dev_lead")).toBe("在已登入且已驗證擁有者的裝置上，開啟「設定 → 存取與安全」，在「裝置與登入」選「新增裝置」，輸入這組代碼。");
    await p.click("another");
    expect(p.text("devStatus")).toBe("等待核准中… 5:00 後失效。");
    await p.flush(2000);
    expect(p.text("devStatus")).toBe("這組代碼已失效。");
  });
});


describe("#3061 P2b the sign-in page: the QR code of the approve link", () => {
  const ORIGIN = "https://agend.example.ts.net:8445";
  /** The vendored encoder, recording what it is asked to encode and what it draws. */
  async function encoder() {
    const src = readFileSync(join(process.cwd(), "src", "ui", "shared", "qrcode.module.js"), "utf8");
    const real = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
    const seen = { data: [] as string[], made: 0 };
    const qrcode = (type: number, level: string) => {
      const qr = real.default(type, level);
      const add = qr.addData.bind(qr);
      qr.addData = (d: string, mode?: string) => { seen.data.push(d); return add(d, mode); };
      seen.made++;
      return qr;
    };
    return { seen, load: async () => ({ default: qrcode }) };
  }
  const WAITING = { "/auth/device-login": [ASKED], "/auth/device-login/poll": [PENDING] };

  it("shown beside the code with the marks on: it encodes THIS page's address and the code on screen — nothing else — and says so", async () => {
    const e = await encoder();
    const p = await page("en", { deviceLogin: true, loginQr: true, origin: ORIGIN, hostname: "agend.example.ts.net", encoder: e.load, replies: WAITING });
    expect(p.el("devQr").hidden).toBe(true);                                                                       // not before there is a code
    await p.click("another");
    expect(p.el("devQr").hidden).toBe(false);
    expect(e.seen.data).toEqual([`${ORIGIN}/settings/access?approve=ABCD-EFGH`]);
    // The link holds no request id, no cookie, no token, no second parameter: an origin, a path, one code.
    expect(e.seen.data[0]).toMatch(/^https:\/\/[^/?#]+\/settings\/access\?approve=[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(JSON.stringify(p.calls)).not.toMatch(/[0-9a-f]{32}/);
    // Drawn as an SVG of dark modules on white, from createElementNS (no markup is built from text).
    const svg = p.el("devQrSvg");
    expect(svg.attrs.viewBox).toMatch(/^0 0 (\d+) \1$/);
    expect(svg.children.map((c: any) => c.tag)).toEqual(["rect", "path"]);
    expect(svg.children[0].attrs.fill).toBe("#fff");
    expect(svg.children[1].attrs.d).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(p.i18n("dev_qr")).toBe("Or scan this QR code with a device that is already signed in as the owner. It holds this page's address and the code above, nothing else.");
    expect(HTML).toContain('id="devQr"');
    expect(HTML).toMatch(/id="devQr"[^>]*hidden/);
  });

  it("never without the mark (web.login_qr off), and never where the address cannot be opened from another device (localhost, 127.x, [::1])", async () => {
    const e = await encoder();
    const off = await page("en", { deviceLogin: true, origin: ORIGIN, hostname: "agend.example.ts.net", encoder: e.load, replies: WAITING });
    await off.click("another");
    expect([off.el("devQr").hidden, e.seen.made]).toEqual([true, 0]);
    for (const hostname of ["localhost", "127.0.0.1", "127.8.9.10", "[::1]", "agend.localhost"]) {
      const here = await page("en", { deviceLogin: true, loginQr: true, origin: `http://${hostname}:19280`, hostname, encoder: e.load, replies: WAITING });
      await here.click("another");
      expect([hostname, here.el("devQr").hidden, e.seen.made]).toEqual([hostname, true, 0]);
      expect(here.text("devCode")).toBe("ABCD-EFGH");                                                              // the code itself is unaffected
    }
    // A LAN or tailnet name or address is another device's way in.
    for (const hostname of ["192.168.1.5", "agend-pc", "agend.tail9cd40a.ts.net"]) {
      const lan = await page("en", { deviceLogin: true, loginQr: true, origin: `http://${hostname}:19280`, hostname, encoder: e.load, replies: WAITING });
      await lan.click("another");
      expect([hostname, lan.el("devQr").hidden]).toEqual([hostname, false]);
    }
  });

  it("not on the page of a fleet's public link or a chat fleet's (no device sign-in there, so no mark and no button)", async () => {
    const e = await encoder();
    const outside = await page("en", { deviceLogin: true, loginQr: true, outside: true, origin: ORIGIN, hostname: "agend.example.ts.net", encoder: e.load, replies: WAITING });
    const chat = await page("en", { deviceLogin: true, loginQr: true, webOnly: false, origin: ORIGIN, hostname: "agend.example.ts.net", encoder: e.load, replies: WAITING });
    expect([outside.el("another").hidden, chat.el("another").hidden, e.seen.made]).toEqual([true, true, 0]);
  });

  it("goes with its code: a new code draws a new one, expired / denied / Back take it away, a failed encoder leaves the code usable", async () => {
    const e = await encoder();
    const opts = { deviceLogin: true, loginQr: true, origin: ORIGIN, hostname: "agend.example.ts.net", encoder: e.load } as const;
    const p = await page("en", { ...opts, replies: {
      "/auth/device-login": [ASKED, { status: 200, body: { code: "WXYZ-2345", ttlMs: 300_000 } }],
      "/auth/device-login/poll": [{ status: 200, body: { state: "denied" } }, PENDING, { status: 200, body: { state: "expired" } }],
      "/auth/device-login/cancel": [{ status: 200, body: { ok: true } }],
    } });
    await p.click("another");
    await p.flush(2000);                                                                                           // denied
    expect([p.text("devStatus"), p.el("devQr").hidden, p.el("devQrSvg").children.length]).toEqual(["This request was denied.", true, 0]);
    await p.click("devNew");
    expect([p.el("devQr").hidden, e.seen.data.at(-1)]).toEqual([false, `${ORIGIN}/settings/access?approve=WXYZ-2345`]);
    await p.flush(2000); await p.flush(2000);                                                                      // pending, then expired
    expect([p.text("devStatus"), p.el("devQr").hidden]).toEqual(["This code has expired.", true]);
    // Back
    const q = await page("en", { ...opts, replies: { ...WAITING, "/auth/device-login/cancel": [{ status: 200, body: { ok: true } }] } });
    await q.click("another");
    expect(q.el("devQr").hidden).toBe(false);
    await q.click("devBack");
    expect([q.el("devQr").hidden, q.el("devQrSvg").children.length]).toEqual([true, 0]);
    // An encoder that cannot load: no QR, and the code is still there to type.
    const broken = await page("en", { ...opts, encoder: () => Promise.reject(new Error("blocked")), replies: WAITING });
    await broken.click("another");
    expect([broken.el("devQr").hidden, broken.text("devCode"), broken.text("devStatus")]).toEqual([true, "ABCD-EFGH", "Waiting for approval… Expires in 5:00."]);
  });

  it("an encoder that answers after the code was replaced does not draw the old code's QR", async () => {
    const e = await encoder();
    let release: () => void = () => {};
    const slow = () => new Promise(resolve => { release = () => resolve(e.load()); });
    const p = await page("en", { deviceLogin: true, loginQr: true, origin: ORIGIN, hostname: "agend.example.ts.net", encoder: slow, replies: {
      "/auth/device-login": [ASKED, { status: 200, body: { code: "WXYZ-2345", ttlMs: 300_000 } }], "/auth/device-login/poll": [PENDING] } });
    await p.click("another");                                                                                      // asks; the encoder is still loading
    await p.click("devBack");                                                                                      // the request is withdrawn meanwhile
    release();
    await p.flush(0);
    expect([p.el("devQr").hidden, e.seen.data]).toEqual([true, []]);
  });

  it("zh-TW: its words", async () => {
    const p = await page("zh-TW", { deviceLogin: true, loginQr: true, replies: {} });
    expect(p.i18n("dev_qr")).toBe("也可以用已登入且已驗證擁有者的裝置掃描這個 QR Code。裡面只有這個頁面的網址和上面的代碼，沒有其他東西。");
  });
});

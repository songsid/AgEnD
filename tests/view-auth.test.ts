import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { csrfTokenFor } from "../src/web-session.js";
import { WEB_TOKEN_INVALID_MESSAGE } from "../src/web-auth.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { bypassesWebGate } from "../src/auth-api.js";
import { isViewPath } from "../src/view-api.js";
import { isUsagePath, setUsageFetcherForTests } from "../src/usage/usage-api.js";
import { getTmuxSocketName } from "../src/paths.js";
import { installDom } from "./helpers/mini-dom.js";

// This suite starts a real listener and calls /api/ai-usage, whose default fetcher reads the host's CLI logins
// (Codex/Claude/… auth files under the real home) and calls the vendors (#1248 review). Nothing here may touch
// either: usage comes from a fixed payload, any outbound fetch fails the test, and no child process ever starts.
// The one child process a /view read asks for is the roster's background context scrape — `tmux -L <this run's
// private socket> capture-pane`, a read. It is refused too (nothing runs) but expected; any other is a failure.
const outbound = vi.hoisted(() => ({ calls: [] as string[], expectedRefusals: [] as string[], tmuxSocket: null as string | null }));
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => (...args: unknown[]) => {
    const argv = Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : [];
    const socket = outbound.tmuxSocket;
    const privateTmuxRead = name === "execFile" && args[0] === "tmux" && socket !== null && argv[0] === "-L" && argv[1] === socket
      && argv[2] === "capture-pane";
    (privateTmuxRead ? outbound.expectedRefusals : outbound.calls).push(`child_process.${name} ${String(args[0])} ${argv.join(" ")}`);
    throw new Error(`view-auth: no child process may start (${name} ${String(args[0])})`);
  };
  return { ...real, spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), exec: refuse("exec"), execSync: refuse("execSync"),
    execFile: refuse("execFile"), execFileSync: refuse("execFileSync"), fork: refuse("fork") };
});
const USAGE_FIXTURE = { fetchedAt: "2026-10-06T00:00:00.000Z", providers: [{ id: "claude", name: "Claude (fixture)", status: "ok" as const, metrics: [] }] };
beforeEach(() => {
  outbound.calls.length = 0; outbound.expectedRefusals.length = 0;
  outbound.tmuxSocket = getTmuxSocketName();
  // A private socket for this run, never the live server's default one.
  expect(outbound.tmuxSocket, "tests run on their own tmux socket").toMatch(/^agend-[0-9a-f]+$/);
  setUsageFetcherForTests(async () => USAGE_FIXTURE);
  vi.stubGlobal("fetch", (url: unknown) => {
    outbound.calls.push(`fetch ${String(url)}`);
    return Promise.reject(new Error(`view-auth: no outbound fetch (${String(url)})`));
  });
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  setUsageFetcherForTests(null);
  vi.unstubAllGlobals();
  expect(outbound.calls, "nothing left this process: no vendor fetch, no child process").toEqual([]);
});

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string | Buffer): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

interface Harness { fm: FleetManager; port: number; dir: string; origin: string; token: string }

async function startFleet(web?: Record<string, unknown>): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "agend-view-auth-"));
  tempDirs.push(dir);
  const fm = new FleetManager(dir);
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  (fm as unknown as { fleetConfig: unknown }).fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {}, ...(web ? { web } : {}) };
  (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
  (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const address = ((fm as unknown as { healthServer: Server }).healthServer).address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  return { fm, port: address.port, dir, origin: `http://127.0.0.1:${address.port}`, token: fm.getDashboardAccess().token! };
}

async function stop(fm: FleetManager): Promise<void> {
  const server = (fm as unknown as { healthServer: Server | null }).healthServer;
  await new Promise<void>(resolve => server?.close(() => resolve()));
  (fm as unknown as { healthServer: Server | null }).healthServer = null;
}

async function signIn(h: Harness): Promise<{ cookie: string; csrf: string }> {
  const res = await raw(h.port, "POST", "/auth/login", { "content-type": "application/json", origin: h.origin },
    JSON.stringify({ code: h.fm.issueDashboardLogin()!.display }));
  expect(res.status).toBe(200);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  return { cookie, csrf: csrfTokenFor(cookie.split("=")[1]!) };
}

const PROFILE = JSON.stringify({ display_name: "Alpha", role: "tester", description: "d" });
const JSON_H = { "content-type": "application/json" };
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

describe("/view reads are open by default", () => {
  it("serves the page, the roster, the pane and usage to anyone who can reach the listener", async () => {
    const h = await startFleet();
    // A running Claude instance's usage row: what /api/ai-usage serves must then be the fixture's, by name.
    vi.spyOn(h.fm, "getActiveUsageProviderIds").mockReturnValue(new Set(["claude"]));
    for (const path of ["/view", "/api/profiles", "/api/pane/alpha", "/api/profile/alpha", "/api/sort-order", "/api/ai-usage"]) {
      const res = await raw(h.port, "GET", path);
      expect(res.status, path).not.toBe(401);
      expect(res.status, path).not.toBe(403);
      if (path === "/api/ai-usage") expect(JSON.parse(res.body).providers.map((p: { name: string }) => p.name), "usage is served — from the fixture").toEqual(["Claude (fixture)"]);
    }
    // HEAD is a read too: it must not be treated as a write needing a credential.
    for (const path of ["/view", "/api/profiles"]) {
      const head = await raw(h.port, "HEAD", path);
      expect(head.status, `HEAD ${path}`).not.toBe(401);
      expect(head.status, `HEAD ${path}`).not.toBe(403);
    }
    await stop(h.fm);
  }, 30_000);
});

describe("web.view_access: session closes every /view read", () => {
  it("answers each route 401 without a credential, and the page with the sign-in shell to a browser", async () => {
    const h = await startFleet({ view_access: "session" });
    for (const path of ["/api/profiles", "/api/pane/alpha", "/api/profile/alpha", "/api/avatar/alpha", "/api/sort-order", "/api/ai-usage"]) {
      const res = await raw(h.port, "GET", path);
      expect(res.status, path).toBe(401);
      expect(res.body, path).not.toContain("\"instance_name\"");
    }
    const page = await raw(h.port, "GET", "/view", { accept: "text/html" });
    expect(page.status).toBe(401);
    expect(page.body).toContain("/assets/signin.js");
    expect(page.body).not.toContain("AgEnD View");
    await stop(h.fm);
  }, 30_000);

  it("serves them to a signed-in session and to the CLI's header token", async () => {
    const h = await startFleet({ view_access: "session" });
    const s = await signIn(h);
    for (const path of ["/view", "/api/profiles", "/api/pane/alpha", "/api/sort-order", "/api/ai-usage"]) {
      expect((await raw(h.port, "GET", path, { cookie: s.cookie })).status, path).toBe(200);
      expect((await raw(h.port, "GET", path, { "x-agend-token": h.token })).status, path).toBe(200);
    }
    await stop(h.fm);
  }, 30_000);

  it("is checked again inside the handler, not only by the gate in front of it", async () => {
    const { handleViewRequest } = await import("../src/view-api.js");
    const dir = mkdtempSync(join(tmpdir(), "agend-view-direct-"));
    tempDirs.push(dir);
    let status = 0;
    const res = { writeHead(c: number) { status = c; return res; }, end() {} } as never;
    const ctx = {
      webToken: "w".repeat(48), dataDir: dir,
      fleetConfig: { instances: { alpha: {} }, web: { view_access: "session" } },
      logger: { debug() {}, info() {}, warn() {}, error() {} }, classicChannels: null,
      getInstanceStatus: () => "running", getUiStatus: () => ({ instances: [] }),
    } as never;
    handleViewRequest({ method: "GET", headers: {} } as never, res, new URL("http://x/api/profiles"), ctx);
    expect(status).toBe(401);
  });

  it("is a valid setting, and only open or session", () => {
    const check = (view_access: unknown) => validateFleetConfig({ defaults: { backend: "claude-code" }, instances: {}, web: { view_access } })
      .errors.some(e => e.path === "web.view_access");
    expect(check("open")).toBe(false);
    expect(check("session")).toBe(false);
    for (const bad of ["public", "", true, 1]) expect(check(bad), String(bad)).toBe(true);
  });
});

describe("/view writes need a credential — in either mode", () => {
  for (const mode of [undefined, "session"] as const) {
    const label = mode ?? "open";

    it(`refuses an anonymous profile, avatar or sort-order write (${label})`, async () => {
      const h = await startFleet(mode ? { view_access: mode } : undefined);
      for (const [path, body, headers] of [
        ["/api/profile/alpha", PROFILE, JSON_H], ["/api/avatar/alpha", PNG, { "content-type": "image/png" }], ["/api/sort-order", "[]", JSON_H],
      ] as const) {
        const res = await raw(h.port, "POST", path, { ...headers, origin: h.origin }, body);
        expect(res.status, path).toBe(401);
      }
      expect(existsSync(join(h.dir, "avatars"))).toBe(false);
      await stop(h.fm);
    }, 30_000);
  }

  it("refuses the URL token as a write credential — the leak this closes", async () => {
    const h = await startFleet();
    for (const [path, body, headers] of [
      ["/api/profile/alpha", PROFILE, JSON_H], ["/api/avatar/alpha", PNG, { "content-type": "image/png" }], ["/api/sort-order", "[]", JSON_H],
    ] as const) {
      const res = await raw(h.port, "POST", `${path}?token=${h.token}`, headers, body);
      expect(res.status, path).toBe(401);
    }
    // ...and a wrong header token is still refused.
    const wrong = await raw(h.port, "POST", "/api/profile/alpha", { ...JSON_H, "x-agend-token": "0".repeat(48) }, PROFILE);
    expect(wrong.status).toBe(401);
    expect(JSON.parse(wrong.body).error).toBe(WEB_TOKEN_INVALID_MESSAGE);
    await stop(h.fm);
  }, 30_000);

  it("accepts the header token for scripts, and stores what it was sent", async () => {
    const h = await startFleet();
    const res = await raw(h.port, "POST", "/api/profile/alpha", { ...JSON_H, "x-agend-token": h.token }, PROFILE);
    expect(res.status).toBe(200);
    const read = JSON.parse((await raw(h.port, "GET", "/api/profile/alpha")).body);
    expect(read).toMatchObject({ display_name: "Alpha", role: "tester" });
    await stop(h.fm);
  }, 30_000);

  it("accepts a signed-in session's write only with Origin and the CSRF value", async () => {
    const h = await startFleet();
    const s = await signIn(h);

    const bare = await raw(h.port, "POST", "/api/profile/alpha", { ...JSON_H, cookie: s.cookie }, PROFILE);
    expect(bare.status).toBe(403);
    const noCsrf = await raw(h.port, "POST", "/api/profile/alpha", { ...JSON_H, cookie: s.cookie, origin: h.origin }, PROFILE);
    expect(noCsrf.status).toBe(403);
    const cross = await raw(h.port, "POST", "/api/profile/alpha", { ...JSON_H, cookie: s.cookie, origin: "https://evil.example", "x-agend-csrf": s.csrf }, PROFILE);
    expect(cross.status).toBe(403);
    const forgedSite = await raw(h.port, "POST", "/api/profile/alpha", { ...JSON_H, cookie: s.cookie, origin: h.origin, "x-agend-csrf": s.csrf, "sec-fetch-site": "cross-site" }, PROFILE);
    expect(forgedSite.status).toBe(403);
    expect(JSON.parse((await raw(h.port, "GET", "/api/profile/alpha")).body).display_name).toBeNull();

    const ok = await raw(h.port, "POST", "/api/profile/alpha", { ...JSON_H, cookie: s.cookie, origin: h.origin, "x-agend-csrf": s.csrf }, PROFILE);
    expect(ok.status).toBe(200);
    expect(JSON.parse((await raw(h.port, "GET", "/api/profile/alpha")).body).display_name).toBe("Alpha");

    const avatar = await raw(h.port, "POST", "/api/avatar/alpha", { "content-type": "image/png", cookie: s.cookie, origin: h.origin, "x-agend-csrf": s.csrf }, PNG);
    expect(avatar.status).toBe(200);
    const sort = await raw(h.port, "POST", "/api/sort-order", { ...JSON_H, cookie: s.cookie, origin: h.origin, "x-agend-csrf": s.csrf }, "[]");
    expect(sort.status).toBe(200);
    await stop(h.fm);
  }, 30_000);

  it("stops accepting a session's writes the moment it is revoked", async () => {
    const h = await startFleet();
    const s = await signIn(h);
    h.fm.revokeWebSessions();
    const res = await raw(h.port, "POST", "/api/profile/alpha", { ...JSON_H, cookie: s.cookie, origin: h.origin, "x-agend-csrf": s.csrf }, PROFILE);
    expect(res.status).toBe(401);
    await stop(h.fm);
  }, 30_000);
});

describe("which requests skip the gate", () => {
  const open = { web: undefined };
  const closed = { web: { view_access: "session" } };
  const skips = (method: string, url: string, config: Parameters<typeof bypassesWebGate>[2] = open) =>
    bypassesWebGate({ method, url }, new URL(url, "http://x").pathname, config, p => isViewPath(p) || isUsagePath(p));

  it("skips the probe, /agent and the sign-in surface", () => {
    expect(skips("GET", "/health")).toBe(true);
    expect(skips("POST", "/agent")).toBe(true);
    for (const url of ["/signin", "/auth/login", "/auth/session", "/assets/signin.js"]) expect(skips("GET", url), url).toBe(true);
    // ...and only the method each is for.
    expect(skips("POST", "/health")).toBe(false);
    expect(skips("GET", "/agent")).toBe(false);
  });

  it("skips /view's reads when reads are open, and only its reads", () => {
    for (const url of ["/view", "/api/pane/a", "/api/profiles", "/api/profile/a", "/api/avatar/a", "/api/sort-order", "/api/ai-usage"]) {
      expect(skips("GET", url), `GET ${url}`).toBe(true);
      expect(skips("HEAD", url), `HEAD ${url}`).toBe(true);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(skips(method, url), `${method} ${url}`).toBe(false);
    }
  });

  it("skips none of /view when reads are closed", () => {
    for (const url of ["/view", "/api/pane/a", "/api/profiles", "/api/ai-usage"]) expect(skips("GET", url, closed), url).toBe(false);
    // ...but the probe and the sign-in page still work: they are how you get in.
    expect(skips("GET", "/health", closed)).toBe(true);
    expect(skips("GET", "/signin", closed)).toBe(true);
  });

  it("never skips a panel, the settings API or the fleet-control routes", () => {
    for (const url of ["/ui", "/ui/events", "/settings", "/api/settings/apply", "/status", "/api/fleet", "/restart/a", "/stop/a", "/api/instance/a/start"]) {
      expect(skips("GET", url), url).toBe(false);
      expect(skips("POST", url), url).toBe(false);
    }
  });
});

describe("the /view handler does not lean on the gate for writes", () => {
  it("refuses an anonymous write, and a URL token, when reached directly", async () => {
    const { handleViewRequest } = await import("../src/view-api.js");
    const dir = mkdtempSync(join(tmpdir(), "agend-view-direct-"));
    tempDirs.push(dir);
    const token = "w".repeat(48);
    const ctx = {
      webToken: token, dataDir: dir,
      fleetConfig: { instances: { alpha: {} } },
      logger: { debug() {}, info() {}, warn() {}, error() {} }, classicChannels: null,
      getInstanceStatus: () => "running", getUiStatus: () => ({ instances: [] }),
    } as never;
    const call = (method: string, path: string, headers: Record<string, string> = {}) => {
      let status = 0;
      const res = { writeHead(c: number) { status = c; return res; }, end() {} } as never;
      const stream = Object.assign(new Readable({ read() { this.push(null); } }), { method, headers });
      handleViewRequest(stream as never, res, new URL(`http://x${path}`), ctx);
      return status;
    };

    expect(call("POST", "/api/profile/alpha")).toBe(401);
    expect(call("POST", "/api/avatar/alpha", { "content-type": "image/png" })).toBe(401);
    expect(call("POST", "/api/sort-order")).toBe(401);
    expect(call("POST", `/api/profile/alpha?token=${token}`)).toBe(401);
    expect(call("POST", "/api/profile/alpha", { "x-agend-token": "0".repeat(48) })).toBe(401);
    expect(existsSync(join(dir, "avatars"))).toBe(false);
  });
});

describe("nothing credential-shaped is left behind", () => {
  it("removes a stale view.token from an older install and never writes a new one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-view-token-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "view.token"), "a".repeat(48));
    const fm = new FleetManager(dir);
    (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
    expect(existsSync(join(dir, "view.token"))).toBe(false);
    expect(existsSync(join(dir, "web.token"))).toBe(true);
  });

  it("the View page carries no token field, no URL token and no stored token; Edit sends a signed-out visitor to sign in", async () => {
    // /view is the app shell (app.html) with the View panel (panel-view.js) and its strings (view-strings.js).
    const shellHtml = readFileSync(join(process.cwd(), "src", "ui", "app.html"), "utf8");
    const panel = readFileSync(join(process.cwd(), "src", "ui", "shared", "panel-view.js"), "utf8");
    const strings = readFileSync(join(process.cwd(), "src", "ui", "shared", "view-strings.js"), "utf8");
    expect(shellHtml).toContain('<script src="/assets/agend-auth.js"></script>');
    for (const forbidden of ["fToken", "agend_web_token", "urlToken", "X-Agend-Token", "?token=", "&token="]) {
      for (const [name, src] of [["app.html", shellHtml], ["panel-view.js", panel], ["view-strings.js", strings]] as const) {
        expect(src, `${name}: ${forbidden}`).not.toContain(forbidden);
      }
    }
    expect(strings).not.toContain("tokenRequired");
    // The old free-text token box is gone; Edit goes through the shell's sign-in link, which returns to this page.
    expect(panel).toContain("signInHref()");
    const dom = installDom({ url: "http://127.0.0.1:19280/view/alpha" });
    try {
      const shell = await import("/assets/app-shell.js");
      expect(shell.signInHref()).toBe("/signin?next=%2Fview%2Falpha");
    } finally {
      dom.restore();
    }
  });

  it("the dashboard message never offers a View (edit) link", () => {
    const src = readFileSync(join(process.cwd(), "src", "topic-commands.ts"), "utf8");
    expect(src).not.toContain("View (edit)");
    expect(src).not.toContain("?token=");
  });
});


describe("agend-auth.js (loaded by /ui, /view and /settings), run against a fake page", () => {
  /** A browser's localStorage, as far as the script can tell: a Map behind the Storage methods. */
  function storage(entries: Record<string, string> = {}) {
    const data = new Map(Object.entries(entries));
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, String(v)); },
      removeItem: (k: string) => { data.delete(k); },
    };
  }
  /** `localStorage` itself can throw (blocked storage, a sandboxed frame), or only its removeItem can. */
  type StorageMode = ReturnType<typeof storage> | "access-throws" | "remove-throws";
  async function loadPage(href: string, store: StorageMode = storage()) {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const vm = await import("node:vm");
    const url = new URL(href);
    const replaced: string[] = [];
    const win: Record<string, unknown> = { fetch: () => new Promise(() => {}) };
    if (store === "access-throws") Object.defineProperty(win, "localStorage", { get() { throw new Error("SecurityError: storage is blocked"); } });
    else if (store === "remove-throws") win.localStorage = { ...storage(), removeItem() { throw new Error("SecurityError"); } };
    else win.localStorage = store;
    const context = vm.createContext({
      window: win, location: { href: url.href }, history: { replaceState: (_s: unknown, _t: unknown, u: string) => { replaced.push(u); } },
      URL, document: { addEventListener() {}, body: null, createElement: () => ({ style: {}, append() {} }) },
    });
    vm.runInContext(readFileSync(join(process.cwd(), "src", "ui", "shared", "agend-auth.js"), "utf8"), context);
    return { replaced, win };
  }
  const load = async (href: string) => (await loadPage(href)).replaced;

  it("takes a leftover ?token= out of the address bar of any panel, keeping everything else", async () => {
    const token = "f".repeat(48);
    expect(await load(`http://127.0.0.1:1/view?token=${token}`)).toEqual(["/view"]);
    expect(await load(`http://127.0.0.1:1/view?i=w&token=${token}#p`)).toEqual(["/view?i=w#p"]);
  });

  it("an upgraded browser loses the web token old /view kept in localStorage — that key only, the preferences stay", async () => {
    const prefs = { agend_lang: "zh-TW", agend_view_density: "compact", agend_view_card_expanded: "1", agend_view_sidebar_order: "[\"alpha\"]" };
    for (const panel of ["/view", "/ui", "/settings"]) {
      const store = storage({ agend_web_token: "f".repeat(48), ...prefs });
      await loadPage(`http://127.0.0.1:1${panel}`, store);
      expect(Object.fromEntries(store.data), panel).toEqual(prefs);
    }
  });

  it("storage that is blocked, or refuses the removal, does not stop the rest: ?token= is still scrubbed and writes still get CSRF", async () => {
    for (const mode of ["access-throws", "remove-throws"] as const) {
      const { replaced, win } = await loadPage(`http://127.0.0.1:1/view?token=${"f".repeat(48)}&i=w`, mode);
      expect(replaced, mode).toEqual(["/view?i=w"]);
      expect(win.AgendAuth, mode).toBeDefined();
      expect(typeof win.fetch, mode).toBe("function");
      expect(String(win.fetch), mode).toContain("csrf");             // the wrapper, not the page's own fetch
    }
  });

  it("leaves an address without one alone", async () => {
    expect(await load("http://127.0.0.1:1/view")).toEqual([]);
    expect(await load("http://127.0.0.1:1/ui?x=1")).toEqual([]);
  });
});

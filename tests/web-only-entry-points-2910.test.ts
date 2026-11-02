/**
 * #2910 D5: the entry points lead with the way in a web-only fleet has. The sign-in page (/signin, and the page a
 * signed-out navigation gets) is marked on a web-only fleet (<body data-web-only="1">), so its words lead with
 * `agend web --code` (signin-copy-1854.test.ts: the page's side); a fleet with a chat connection's page is unchanged.
 * The README and getting-started guides say a bot is optional.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    r.on("error", reject); r.end();
  });
}
async function served(config: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2910-entry-")); dirs.push(dir);
  const fm = new FleetManager(dir), any = fm as any;
  fm.logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child: () => fm.logger } as never;
  fm.fleetConfig = { defaults: {}, instances: {}, ...config } as never;
  any.initializeWebAuthTokens(); any.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = ((any.healthServer as Server).address() as { port: number }).port;
  const stop = () => new Promise<void>(r => { const s = any.healthServer as Server; any.healthServer = null; s.close(() => r()); });
  return { port, stop };
}
const CHAT = { channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: "-100", access: { mode: "locked", allowed_users: ["1"] } } };

describe("#2910 D5 the sign-in page knows a web-only fleet", () => {
  it.each([["web-only", {}, true], ["with a chat connection", CHAT, false]] as const)("%s: /signin and a signed-out navigation's page are marked: %s", async (_why, config, marked) => {
    const h = await served(config);
    try {
      const page = await get(h.port, "/signin"), nav = await get(h.port, "/ui", { accept: "text/html" });
      expect([page.status, nav.status, page.body.includes('<body data-web-only="1">'), nav.body.includes('<body data-web-only="1">'), page.body.includes("/assets/signin.js")])
        .toEqual([200, 401, marked, marked, true]);
    } finally { await h.stop(); }
  }, 20_000);
});

describe("#2910 D5 the docs say a bot is optional", () => {
  const doc = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("README (en, zh-TW): quickstart is web-first and the bot token is not a requirement", () => {
    for (const p of ["README.md", "README.zh-TW.md"]) {
      const text = doc(p);
      expect([/agend quickstart\s+# 2\. .*(?:web|網頁)/i.test(text), /^[^\n]*(?:optional|可選|選用)[^\n]*bot token[^\n]*$|^[^\n]*bot token[^\n]*(?:optional|可選|選用)[^\n]*$/im.test(text)], p).toEqual([true, true]);
    }
  });
  it("install.sh (and its website copy) says quickstart is web only by default — no bot token needed", () => {
    for (const p of ["install.sh", "website/public/install.sh"]) expect(doc(p), p).toContain("Web only by default: no bot token is needed");
  });
  it("getting-started (en, zh-tw): quickstart's first question is web only, the default", () => {
    for (const p of ["website/src/content/docs/docs/getting-started.md", "website/src/content/docs/zh-tw/docs/getting-started.md"]) {
      expect(/Web only/.test(doc(p)) && /agend web --code/.test(doc(p)), p).toBe(true);
    }
  });
});

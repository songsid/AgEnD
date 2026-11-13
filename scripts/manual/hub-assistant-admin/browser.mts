/** Actual Hub shell/components against owned local fake admin APIs. No Fleet or vendor process. */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadavg } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const root = process.cwd(), out = process.env.OUT ?? join(root, ".artifacts/assistant-admin-browser"); mkdirSync(out, { recursive: true });
const record: any = { scope: "Actual Hub shell and components; fake same-origin admin/session APIs, no real authentication/Fleet/account/model", cases: [], checks: [], errors: [], source: {} };
for (const path of ["src/ui/hub-assistant-admin.js", "src/ui/hub-assistant-admin-strings.js", "src/ui/hub-client.js", "src/ui/panel-hub.js"]) record.source[path] = createHash("sha256").update(readFileSync(join(root, path))).digest("hex").slice(0, 16);
const check = (name: string, value: unknown) => { record.checks.push({ name, pass: !!value }); if (!value) throw Error(name); };
const initial = () => ({ enabled: true, backend: "claude-code", account: null as string | null, cap: 3, idleMinutes: 15,
  backends: [{ id: "claude-code", name: "Claude", accounts: [{ id: null, name: "Default", state: "signed-in" }, { id: "team", name: "Team", state: "signed-in" }] }],
  running: [{ roomId: "planning", roomName: "產品研發主管週會 · Product planning", state: "working", lastUsed: Date.now() }, { roomId: "design", roomName: "Design review", state: "idle", lastUsed: Date.now() - 300000 }] });
let settings = initial(), failSave = false, writes: any[] = [];
const send = (res: any, body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url!, "http://fixture.invalid").pathname;
    if (path === "/hub/v1/session") return send(res, { signedIn: true, admin: true, login: "pilot-admin", displayName: "Hub administrator", csrf: "fixture-csrf", features: ["room-assistant-v1"] });
    if (path === "/hub/v1/admin/assistant") {
      if (req.method === "PUT") {
        let body = ""; for await (const chunk of req) body += chunk;
        writes.push({ input: JSON.parse(body), csrf: req.headers["x-agend-hub-csrf"] });
        if (failSave) return send(res, { code: "unavailable" }, 503);
        settings = { ...settings, ...JSON.parse(body) };
      }
      return send(res, settings);
    }
    if (path === "/hub/v1/admin/assistant/usage") return send(res, { days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-${i + 10}`, count: i * 3 })), quota: { band: "near_limit" } });
    if (path.endsWith("/stop")) { settings.running = settings.running.filter(row => !path.includes(`/rooms/${row.roomId}/`)); return send(res, { ok: true }); }
    if (path.startsWith("/hub/v1/")) return send(res, { rooms: [], fleets: [], pairings: [], notices: [], exposures: [], mine: [], name: "Example Hub" });
    if (path.startsWith("/assets/") || path.startsWith("/ui/js/")) {
      const name = path.split("/").at(-1)!;
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw Error("Invalid asset path");
      const file = path.startsWith("/ui/js/") ? join(root, "src/ui", name) : join(root, "src/ui/shared", name === "inter.woff2" ? "fonts/inter.woff2" : name);
      res.writeHead(200, { "Content-Type": name.endsWith(".css") ? "text/css" : name.endsWith(".woff2") ? "font/woff2" : "application/javascript" }); res.end(readFileSync(file)); return;
    }
    if (path === "/ui/hub/admin") {
      const html = readFileSync(join(root, "src/ui/app.html"), "utf8").replace('<script src="/assets/agend-auth.js"></script>', "")
        .replace("<body>", '<body data-mode="full" data-web-transport="none" data-usage-panel="0" data-log-tab="0" data-hub="hub" data-hub-name="Example Hub">');
      res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); return;
    }
    res.writeHead(204); res.end();
  } catch (error) { record.errors.push(String(error)); res.writeHead(500); res.end(); }
});
let browser: any;
try {
  check("load gate before browser", loadavg()[0] <= 10);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const pw = createRequire(import.meta.url)("playwright-core"); browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
  record.browser = browser.version();
  for (const phone of [false, true]) for (const theme of ["light", "dark"]) for (const language of ["en", "zh-TW"]) {
    check("load gate before case", loadavg()[0] <= 10); settings = initial(); writes = []; failSave = false;
    const context = await browser.newContext({ viewport: { width: phone ? 390 : 1366, height: phone ? 844 : 1000 }, colorScheme: theme });
    try {
      await context.addInitScript(({ language, theme }: any) => { localStorage.setItem("agend_lang", language); localStorage.setItem("agend_theme", theme); localStorage.setItem("agend_tour_done", "1"); }, { language, theme });
      const page = await context.newPage(); page.on("pageerror", (e: any) => record.errors.push(String(e)));
      await page.goto(origin + "/ui/hub/admin");
      const label = (en: string, zh: string) => language === "en" ? en : zh;
      const card = page.getByRole("region", { name: label("Room assistant", "房間助理"), exact: true }); await card.waitFor();
      await card.getByRole("button", { name: label("Save", "儲存"), exact: true }).waitFor();
      const tag = `${phone ? "phone" : "desktop"}-${theme}-${language}`;
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      check(tag + " no horizontal overflow", overflow <= 1);
      await page.evaluate(() => document.fonts.ready);
      const nowCard = page.getByRole("region", { name: label("Now", "現在"), exact: true });
      const usageCard = page.getByRole("region", { name: label("Usage", "用量"), exact: true });
      for (const [name, region] of [["settings", card], ["now", nowCard], ["usage", usageCard]] as const) {
        await region.scrollIntoViewIfNeeded(); await region.screenshot({ path: join(out, `${tag}-${name}.png`) });
      }
      await card.getByLabel(label("Account", "帳號"), { exact: true }).selectOption("team");
      await card.getByLabel(label("At most this many at once", "同時最多幾個"), { exact: true }).fill("2");
      await card.getByRole("button", { name: label("Save", "儲存"), exact: true }).click();
      await card.getByRole("status").filter({ hasText: label("Saved", "已儲存") }).waitFor();
      check(tag + " selected account and cap", writes.at(-1)?.input.account === "team" && writes.at(-1)?.input.cap === 2 && writes.at(-1)?.csrf === "fixture-csrf");
      await card.getByLabel(label("At most this many at once", "同時最多幾個"), { exact: true }).fill("4");
      const now = page.getByRole("region", { name: label("Now", "現在"), exact: true });
      await now.getByRole("button", { name: label("Stop", "停止"), exact: true }).first().click();
      await now.getByText("產品研發主管週會 · Product planning", { exact: true }).waitFor({ state: "detached" });
      check(tag + " stop keeps unsaved edit", await card.getByLabel(label("At most this many at once", "同時最多幾個"), { exact: true }).inputValue() === "4");
      failSave = true; await card.getByRole("button", { name: label("Save", "儲存"), exact: true }).click();
      await card.getByRole("alert").waitFor();
      check(tag + " failed save keeps edit", await card.getByLabel(label("At most this many at once", "同時最多幾個"), { exact: true }).inputValue() === "4");
      record.cases.push(tag);
    } finally { await context.close(); }
  }
  check("all eight cases ran", record.cases.length === 8); check("no browser/server errors", record.errors.length === 0); record.status = "PASS";
} catch (error: any) { record.status = "FAIL"; record.error = error.stack; throw error; }
finally {
  await browser?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); record.cleaned = true;
  writeFileSync(join(out, "receipt.json"), JSON.stringify(record, null, 2));
}
console.log(JSON.stringify({ status: record.status, cases: record.cases.length, checks: record.checks.length, out }));

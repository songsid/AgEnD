// AgEnD Hub P1 slice 3 (S-44): the Hub UI in a real browser on the smoke fixture (never `fleet start`), with stub data.
// - off (the default): Settings → Access & security has no Hub card and no Hub module or stylesheet is ever requested;
// - a member fleet (hub_member.enabled): the card unpaired / pending / paired, the "My fleet ↔ Hub" switcher once paired;
// - a Hub workspace: slice 1's own listener is not built yet, so a navigation to /ui/hub* is answered with the shell this
//   server renders for a Hub workspace (serveAppShell's hubWorkspace) — Ask / My exposures / Administration;
// - the stale-tab skew (rule 3): the old shell (every long-lived /assets file from OLD_REF) with this branch's lazy Hub
//   modules; this shell with the old lazy Settings module. No page errors, no CSP reports.
// Desk/en and phone/zh-TW, dark; screenshots under OUT/hub-ui-s3.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [OLD_REF=origin/release/2.3.5-alpha] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-hub-ui-s3.mts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const REPO = process.env.REPO!;
const OLD_REF = process.env.OLD_REF ?? "origin/release/2.3.5-alpha";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48580), instances: 6, classic: false });
const fm = fx.fm as any;
const { serveAppShell } = await import(REPO + "/src/web-api.ts");
const r: Record<string, unknown> = { oldRef: OLD_REF };
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };
const CASES = [{ device: "desk", theme: "dark", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const;
const STUB = (steps: string) => `import("/ui/js/hub-client.js").then(async (m) => { const c = m.hubClient(); ${steps} })`;

async function open(c: (typeof CASES)[number], path: string, route?: (page: any) => Promise<void>) {
  const { ctx, page, csp } = await fx.page(c as any);
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  const hubReqs: string[] = []; page.on("request", (q: any) => { const u = q.url(); if (/\/ui\/js\/(hub-|panel-hub|settings-hub)|\/assets\/hub\.css/.test(u)) hubReqs.push(new URL(u).pathname); });
  if (route) await route(page);
  await page.goto(fx.base + path); await page.waitForTimeout(1800);
  return { ctx, page, csp, errs, hubReqs };
}

try {
  // ── off ──
  delete fm.fleetConfig.hub_member;
  for (const c of CASES) {
    const o = await open(c, "/settings/access");
    const got = { card: !!(await o.page.$(".s-hub-connect")), switcher: !!(await o.page.$(".hub-switch")), hubReqs: o.hubReqs, errs: o.errs, csp: await o.csp() };
    check(`off-${c.device}`, !got.card && !got.switcher && got.hubReqs.length === 0 && got.errs.length === 0, got);
    await o.ctx.close();
  }

  // ── a member fleet ──
  fm.fleetConfig.hub_member = { enabled: true };
  for (const c of CASES) {
    const tag = `member-${c.device}-${c.lang}`;
    const o = await open(c, "/settings/access");
    await o.page.waitForSelector(".s-hub-connect", { timeout: 10000 });
    await o.page.locator(".s-hub-connect").scrollIntoViewIfNeeded();
    await o.page.screenshot({ path: shotPath("hub-ui-s3", tag, "1-unpaired") });
    await o.page.fill("#hubAddress", "https://hub.example.test"); await o.page.fill("#hubCode", "K7Q2-9XMB-4TRV");
    await o.page.click(".hub-connect button[type=submit]"); await o.page.waitForSelector(".hub-pending");
    await o.page.evaluate(STUB("c.control.ownerConfirmed();")); await o.page.waitForTimeout(300);
    await o.page.locator(".s-hub-connect").scrollIntoViewIfNeeded();
    await o.page.screenshot({ path: shotPath("hub-ui-s3", tag, "2-pending") });
    const groups = await o.page.evaluate(`document.querySelector(".hub-fp-groups").textContent`);
    await o.page.evaluate(STUB('c.control.approve({ name: "Team Hub", webOrigin: "https://hub.example.test" }); c.control.enforceable(["general"]);'));
    await o.page.waitForSelector(".hub-paired"); await o.page.waitForTimeout(600);
    await o.page.locator(".s-hub-connect").scrollIntoViewIfNeeded();
    await o.page.screenshot({ path: shotPath("hub-ui-s3", tag, "3-paired") });
    if (c.device === "phone") { await o.page.evaluate(`import("/assets/app-shell.js").then((m) => m.openDrawer())`); await o.page.waitForTimeout(600); }
    const sw = await o.page.evaluate(`(() => { const a = document.querySelector(".hub-switch a"); return a ? [a.textContent, a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")] : null; })()`);
    await o.page.screenshot({ path: shotPath("hub-ui-s3", tag, "4-switcher") });
    const got = { groups, switcher: sw, errs: o.errs, csp: await o.csp() };
    check(tag, String(groups).split(" ").length === 8 && JSON.stringify(sw) === JSON.stringify(["Team Hub", "https://hub.example.test", "_blank", "noopener noreferrer"]) && got.errs.length === 0 && (got.csp as string[]).length === 0, got);
    await o.ctx.close();
  }

  // ── a Hub workspace (as slice 1's own listener will serve it) ──
  const hubShell = async (page: any) => {
    await page.route(/\/ui\/hub(\/exposures|\/admin)?$/, async (route: any) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const out: { status: number; headers: Record<string, string>; body: string } = { status: 200, headers: {}, body: "" };
      const req = { url: new URL(route.request().url()).pathname, method: "GET", headers: { ...route.request().headers(), host: new URL(fx.base).host }, socket: { remoteAddress: "127.0.0.1" } };
      const res = { setHeader(k: string, v: string) { out.headers[k.toLowerCase()] = String(v); }, getHeader(k: string) { return out.headers[k.toLowerCase()]; },
        writeHead(s: number, h: Record<string, string> = {}) { out.status = s; for (const [k, v] of Object.entries(h)) out.headers[k.toLowerCase()] = String(v); return res; },
        end(b?: string | Buffer) { out.body = b === undefined ? "" : String(b); }, headersSent: false };
      serveAppShell(req as never, res as never, fm, "full", { hubWorkspace: { name: "Team Hub" } });
      await route.fulfill({ status: out.status, headers: out.headers, body: out.body });
    });
  };
  for (const c of CASES) {
    for (const [tab, path] of [["ask", "/ui/hub"], ["exposures", "/ui/hub/exposures"]] as const) {
      const tag = `hub-${c.device}-${c.lang}`;
      const o = await open(c, path, hubShell);
      if (c.device === "phone") { await o.page.evaluate(`import("/assets/app-shell.js").then((m) => m.openDrawer())`); await o.page.waitForTimeout(600); }
      const got = await o.page.evaluate(`({ brand: document.querySelector(".hub-brand")?.textContent || null, rows: [...document.querySelectorAll(".side-nav a.side-row")].map((a) => a.textContent), list: !!document.querySelector("#instanceList"), empty: !!document.querySelector(".hub-empty") })`);
      await o.page.screenshot({ path: shotPath("hub-ui-s3", tag, tab) });
      check(`${tag}-${tab}`, got.brand === "AgEnD Hub · Team Hub" && got.rows.length === 3 && !got.list && got.empty && o.errs.length === 0, { ...got, errs: o.errs });
      await o.ctx.close();
    }
  }

  // ── the stale-tab skew ──
  const LAZY_HUB = new Set(["hub.css"]);
  // The old shell: every long-lived /assets file from OLD_REF (the Hub's lazy modules under /ui/js/ stay new).
  const oldShell = async (page: any) => {
    await page.route("**/assets/**", (route: any) => {
      const file = new URL(route.request().url()).pathname.replace(/^\/assets\//, "");
      if (LAZY_HUB.has(file)) return route.continue();
      const body = old(`shared/${file}`);
      return body === null ? route.continue() : route.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body });
    });
  };
  {
    const o = await open(CASES[0], "/settings/access", oldShell);
    const got = { card: !!(await o.page.$(".s-hub-connect")), switcher: !!(await o.page.$(".hub-switch")), errs: o.errs };
    await o.page.screenshot({ path: shotPath("hub-ui-s3", "skew-old-shell", "settings") });
    // The old shell knows no switcher (nothing drawn); this Settings module still draws the card through its own words.
    const title = await o.page.evaluate(`document.querySelector(".s-hub-connect h3")?.textContent || null`);
    check("skew-old-shell-new-lazy", got.card && title === "Connect to a Hub" && !got.switcher && got.errs.length === 0, { ...got, title });
    await o.ctx.close();
  }
  {
    // This shell with the old lazy Settings module: no card (it knows none), the rest unchanged, nothing broken.
    const body = old("panel-settings.js");
    const o = await open(CASES[0], "/settings/access", async (page) => {
      await page.route(/\/ui\/js\/panel-settings\.js(\?.*)?$/, (route: any) => route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body }));
    });
    const got = { card: !!(await o.page.$(".s-hub-connect")), access: !!(await o.page.$(".s-access-related, .p-settings")), errs: o.errs };
    check("skew-new-shell-old-settings", !got.card && got.access && got.errs.length === 0, got);
    await o.ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  writeFileSync(shotPath("hub-ui-s3", "result", "json").replace(/\.png$/, ".json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}

// Real web HTTP/session/preferences, inert agents, headless Linux only. STAGE=before pins the current dev behavior.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";
const before = process.env.STAGE === "before", smoke = `smoke-guest-sidebar-m3280-${before ? "before" : "after"}`;
const fx = await bootFixture({ port: Number(process.env.HP ?? 49170), classic: false, webYaml: "  guests:\n    enabled: true", roster: [
  { name: "agent-alpha", displayName: "Atlas", backend: "codex" }, { name: "agent-beta", displayName: "Beacon", backend: "claude-code" },
  { name: "shared-room", displayName: "Shared room", backend: "codex" }, { name: "hidden-agent", displayName: "Hidden helper", backend: "claude-code" },
] });
const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");
const scope = ["agent-alpha", "agent-beta", "shared-room"], owner = { adapterId: "discord", userId: "900000000000000099" }, person = `person:${owner.adapterId}:${owner.userId}`;
fx.fm.guestScope = () => new Set(scope);
for (const [i, instance] of scope.entries()) fx.fm.emitSseEvent("message", { instance, sender: "Example helper", role: "agent", text: "Ready.", channel: true, ts: new Date(Date.now() - (i + 1) * 60000).toISOString() });
const results: any[] = [];
try {
  for (const device of ["desk", "phone"] as const) for (const tier of ["admin", "guest"] as const) {
    if (process.env.CASES && !process.env.CASES.split(",").includes(`${device}/${tier}`)) continue;
    const phone = device === "phone", lang = phone ? "zh-TW" : "en", theme = phone ? "light" : "dark";
    fx.fm.webPrefs.write("operator", new Map<string, unknown>([["theme", theme], ["lang", lang], ["nav.density", "detailed"], ["nav.densityPhone", "detailed"], ["nav.compactName", "nickname"], ["nav.sort", { mode: "custom", favs: "fixed" }], ["nav.filter", null]]));
    fx.fm.webPrefs.forgetGuest(person); fx.fm.webPrefs.writeForGuest(person, new Map<string, unknown>([["theme", theme], ["lang", lang]]));
    const hostBefore = JSON.stringify(fx.fm.webPrefs.read("operator").values);
    const sid = fx.fm.webSessions.create({ tier, surface: "local", label: "fixture", tokenEpoch: tokenEpoch(fx.fm.webToken), ...(tier === "guest" ? { owner } : {}) }).sessionId;
    const ctx = await fx.browser.newContext({ viewport: VIEWPORTS[device], colorScheme: theme, hasTouch: phone, isMobile: phone });
    await ctx.addCookies([{ name: "agend_session", value: sid, url: fx.base }]);
    await ctx.addInitScript({ content: 'window.__name = f => f; localStorage.setItem("agend_tour_done","1"); localStorage.setItem("agend_firstrun_dismissed","1");' });
    const page = await ctx.newPage(), errors: string[] = [], prefWrites: number[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e)));
    page.on("response", (r: any) => { if (new URL(r.url()).pathname === "/ui/prefs" && r.request().method() === "POST") prefWrites.push(r.status()); });
    let checks = 0; const need = (ok: unknown, why: string) => { checks++; if (!ok) throw Error(`${device}/${tier}: ${why}`); };
    const drawer = async () => { if (phone && !(await page.locator(".shell").evaluate((e: Element) => e.classList.contains("sb-open")))) await page.locator("#sbOpen").tap(); };
    const button = () => page.locator(phone && (!before || tier === "admin") ? "#sidebar .nav-sort-phone > .nav-sort-btn" : "#sidebar .inst-head .nav-sort-btn");
    const openMenu = async () => { if (!(await page.locator("#sidebar .nav-sort-menu").count())) await button().click(); };
    const visibleRows = async () => page.locator("#sidebar [data-agent-row]").evaluateAll((es: Element[]) => es.map(e => e.getAttribute("data-agent-row")));
    try {
      await page.goto(fx.base + "/ui/chat/agent-beta"); await page.locator("#filterInput").waitFor({ state: "attached" }); await drawer();
      await page.locator('#sidebar [data-agent-row="agent-beta"]').waitFor({ state: "visible" });
      const initial = await visibleRows();
      need(tier === "admin" ? initial.includes("hidden-agent") : initial.length === scope.length && initial.every((n: string) => scope.includes(n)), "projected roster");
      const phoneCustom = await page.locator("#sidebar .nav-sort-phone > .nav-sort-btn").isVisible();
      need(await page.locator("#filterInput").isVisible(), "filter visible");
      if (phone) need(phoneCustom === (!before || tier === "admin"), "phone Custom layout");
      await openMenu();
      if (!before && tier === "guest") {
        if (!phone) await page.locator('input[name="nav-sort-density"][value="detailed"]').check();
        await page.locator('input[name="nav-sort-density"][value="compact"]').check();
        await page.locator('input[name="nav-sort-compact-name"][value="instance"]').check();
        await page.locator('input[name="nav-sort-mode"][value="recent"]').check();
        await button().click(); await page.locator("#filterInput").fill("Beacon");
        await page.waitForFunction(() => document.querySelectorAll("#sidebar [data-agent-row]").length === 1);
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const v = fx.fm.webPrefs.readGuestOwn(person);
          if (v?.[phone ? "nav.densityPhone" : "nav.density"] === "compact" && v["nav.compactName"] === "instance" && v["nav.sort"]?.mode === "recent" && v["nav.filter"]?.q === "Beacon") break;
          await page.waitForTimeout(50);
        }
        const own = fx.fm.webPrefs.readGuestOwn(person);
        need(own[phone ? "nav.densityPhone" : "nav.density"] === "compact" && own["nav.compactName"] === "instance" && own["nav.sort"].mode === "recent" && own["nav.filter"].q === "Beacon", "choices saved to guest bucket");
        await page.reload(); await page.locator("#filterInput").waitFor({ state: "attached" }); await drawer();
        await page.locator('#sidebar [data-agent-row="agent-beta"]').waitFor({ state: "visible" });
        need(await page.locator("#filterInput").inputValue() === "Beacon", "filter reload");
        need(JSON.stringify(await visibleRows()) === JSON.stringify(["agent-beta"]), "only matching granted row");
        need(await page.locator('#sidebar [data-agent-row="agent-beta"] .inst-name').textContent() === "agent-beta", "compact instance name reload");
        await openMenu();
        need(await page.locator('input[name="nav-sort-density"][value="compact"]').isChecked(), "density reload");
        need(await page.locator('input[name="nav-sort-compact-name"][value="instance"]').isChecked(), "name reload");
        need(await page.locator('input[name="nav-sort-mode"][value="recent"]').isChecked(), "sort reload");
      }
      need(JSON.stringify(fx.fm.webPrefs.read("operator").values) === hostBefore, "host preferences unchanged");
      need(errors.length === 0 && prefWrites.every(n => n === 200), "no page or preference errors");
      if (!before && !phone) need(await page.locator("#sidebar .inst-head").evaluate((head: Element) => {
        const rs = [...head.querySelectorAll("h2, .nav-sort-btn, .fav-edit")].map(e => e.getBoundingClientRect());
        return rs.every((a, i) => rs.every((b, j) => i === j || a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1));
      }), "desktop header controls do not overlap");
      await page.screenshot({ path: shotPath(smoke, `${device}-${theme}-${lang}`, tier) });
      if (!before && tier === "guest") { await button().click(); await page.screenshot({ path: shotPath(smoke, `${device}-${theme}-${lang}`, "guest-list") }); }
      results.push({ device, tier, initial, phoneCustom, stored: fx.fm.webPrefs.readGuestOwn(person), prefWrites, checks, errors });
    } finally { await ctx.close(); }
  }
  if (!results.length) throw Error("no browser cases selected");
} finally { await fx.close(); writeFileSync(join(process.env.OUT!, `${smoke}.json`), JSON.stringify({ before, results }, null, 2) + "\n"); console.log(JSON.stringify({ before, results })); }

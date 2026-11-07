// Hub half of the loading audit: real HTTPS listener, scratch DB/directory, held reads + Chrome network throttling.
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
const REPO = process.env.REPO!, OUT = process.env.OUT!, PW = process.env.PW_DIR!;
mkdirSync(OUT, { recursive: true });
const { s3bRig } = await import(REPO + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(REPO + "/src/hub/tls.ts");
const port = Number(process.env.HP ?? 48962), origin = `https://127.0.0.1:${port}`;
const rig = await s3bRig({ webOrigin: origin });
const keys = mkdtempSync(join(OUT, ".keys-"));
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
const olivia = rig.addPerson("olivia", "Olivia Chen"); rig.addPerson("alex", "Alex Lin");
const fleetId = randomUUID(), link = rig.link(fleetId, olivia), id = randomUUID();
await rig.http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: [{ id, fleetId, owner: olivia, displayName: "Design guide", revision: 1,
  state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
const owner = await rig.signIn("olivia"), asker = await rig.signIn("alex"), admin = await rig.signIn("admin");
const grant = (await rig.call(owner, "POST", "/hub/v1/grants", { exposureId: id, exposureRevision: 1, login: "alex", days: 7 })).json.grant;
const room = (await rig.call(asker, "POST", "/hub/v1/rooms", { exposureId: id, grantId: grant.id })).json.room.id;
const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const results: any = { browser: browser.version(), network: { latency: 150, download: 250_000, upload: 100_000 }, cases: [] };
const pending: Record<string, string> = { "hub-session": ".p-hub .skeleton:visible", "hub-chats": ".hub-home .skeleton:visible",
  "hub-room-lookup": ".hub-room-loading .skeleton:visible", "hub-room-history": ".hub-scroller .skeleton:visible",
  "hub-owner": ".hub-owner .skeleton:visible", "hub-owner-activity": ".hub-owner .skeleton:visible", "hub-admin": ".hub-admin .skeleton:visible", "hub-new-chat": "dialog .skeleton:visible" };
const cases = [
  { device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" },
  { device: "phone", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" },
] as const;
try {
  for (const c of cases) {
    const tag = `${c.device}-${c.lang}`;
    const surfaces = [
      { name: "hub-session", who: asker, path: "/ui/hub", match: (u: URL) => u.pathname === "/hub/v1/session" },
      { name: "hub-chats", who: asker, path: "/ui/hub", match: (u: URL) => u.pathname === "/hub/v1/rooms" },
      { name: "hub-room-lookup", who: asker, path: `/ui/hub?room=${room}`, match: (u: URL) => u.pathname === "/hub/v1/rooms" },
      { name: "hub-room-history", who: asker, path: `/ui/hub?room=${room}`, match: (u: URL) => u.pathname.endsWith("/messages") },
      { name: "hub-owner", who: owner, path: "/ui/hub/exposures", match: (u: URL) => u.pathname === "/hub/v1/exposures" || u.pathname === "/hub/v1/pairings" },
      { name: "hub-owner-activity", who: owner, path: `/ui/hub/exposures?agent=${id}`, match: (u: URL) => u.pathname.endsWith("/activity") },
      { name: "hub-admin", who: admin, path: "/ui/hub/admin", match: (u: URL) => u.pathname === "/hub/v1/admin/overview" },
      { name: "hub-new-chat", who: asker, path: "/ui/hub", match: (u: URL) => u.pathname === "/hub/v1/exposures" },
    ];
    for (const s of surfaces) {
      if (process.env.ONLY && !process.env.ONLY.split(",").includes(s.name)) continue;
      const ctx = await browser.newContext({ viewport: c.device === "desk" ? { width: 1366, height: 900 } : { width: 390, height: 844 },
        isMobile: c.device === "phone", hasTouch: c.device === "phone", locale: c.lang, colorScheme: c.theme, ignoreHTTPSErrors: true, reducedMotion: c.lang === "zh-TW" ? "reduce" : "no-preference" });
      const [name, value] = s.who.cookie.split("=");
      await ctx.addCookies([{ name, value, url: origin, httpOnly: true, secure: true }]);
      await ctx.addInitScript((v: any) => { localStorage.setItem("agend_lang", v.lang); localStorage.setItem("agend_theme", v.theme); localStorage.setItem("agend_tour_done", "1"); }, c);
      const page = await ctx.newPage(), cdp = await ctx.newCDPSession(page);
      await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 250_000, uploadThroughput: 100_000 });
      for (const [env, path, url, mime] of [["OLD_CSS", "src/ui/shared/app.css", "**/assets/app.css*", "text/css"], ["OLD_STATES", "src/ui/shared/ui-states.js", "**/assets/ui-states.js*", "text/javascript"]]) {
        if (process.env[env!]) { const body = execFileSync("git", ["-C", REPO, "show", `${process.env[env!]}:${path}`], { encoding: "utf8" });
          await page.route(url!, (route: any) => route.fulfill({ contentType: mime, body })); }
      }
      let release!: () => void, seen!: () => void;
      const waiting = new Promise<void>(r => { release = r; }), requested = new Promise<void>(r => { seen = r; });
      await page.route("**/hub/v1/**", async (route: any) => { if (s.match(new URL(route.request().url()))) { seen(); await waiting; }
        try { await route.continue(); } catch (e) { if (!/closed|handled/i.test(String(e))) throw e; } });
      const errors: string[] = []; page.on("pageerror", (e: any) => errors.push(String(e)));
      try {
        await page.goto(origin + s.path, { waitUntil: "commit" });
        if (s.name === "hub-new-chat") await page.locator(".hub-new:visible").first().click({ timeout: 30_000 });
        await Promise.race([requested, page.waitForTimeout(30_000).then(() => { throw new Error(`${s.name}: no held request; ${errors.join(" ")}`); })]);
        await page.waitForTimeout(800);
        const data = await page.evaluate(() => ({ skeletons: document.querySelectorAll(".skeleton").length, busy: document.querySelectorAll('[aria-busy="true"]').length,
          text: document.body.innerText.slice(-2500), overflow: document.documentElement.scrollWidth > innerWidth }));
        if (process.env.EXPECT_SKELETON === "1") {
          const skeleton = page.locator(pending[s.name]).first();
          if (!await skeleton.isVisible()) throw new Error(`${tag}/${s.name}: missing skeleton`);
          const paint = await skeleton.evaluate((el: Element) => ({ opacity: getComputedStyle(el).opacity, animation: getComputedStyle(el).animationName,
            reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, color: getComputedStyle(el.querySelector(".sk-line") || el).backgroundColor }));
          if (paint.opacity === "0" || paint.color === "rgba(0, 0, 0, 0)" || paint.reduced && paint.animation !== "none") throw new Error(`${s.name}: bad paint ${JSON.stringify(paint)}`);
          if (errors.length || data.overflow) throw new Error(`${tag}/${s.name}: errors/overflow ${errors}`);
        }
        await page.screenshot({ path: join(OUT, `${tag}-${s.name}.png`) });
        results.cases.push({ tag, name: s.name, ...data, errors });
        console.log(`${tag} ${s.name}: skeletons=${data.skeletons} busy=${data.busy}`);
        release();
        if (process.env.EXPECT_SKELETON === "1") {
          await page.locator(pending[s.name]).first().waitFor({ state: "hidden", timeout: 25_000 });
          if (errors.length) throw new Error(`${tag}/${s.name}: settled page errors ${errors}`);
        }
      } finally { release(); await ctx.close(); }
    }
  }
} finally {
  mkdirSync(join(REPO, ".artifacts/loading-audit"), { recursive: true });
  writeFileSync(join(REPO, ".artifacts/loading-audit/hub-results.json"), JSON.stringify(results, null, 2));
  await browser.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  await rig.close(); rmSync(keys, { recursive: true, force: true });
}

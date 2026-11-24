// M-3665 Hub room office captures (scratch): the REAL Hub (HTTPS + SQLite via the s3b test rig) and its real UI from REPO.
// A room of 30 agents of 6 owners: 2 working, 1 paused, one owner's fleet offline (5 agents). Desk + phone, en/zh,
// light/dark. Measures: tags off at the phone's zoom, the name row, every zone chip whole. LABEL=before|after.
import { createServer as createHttps } from "node:https";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
process.on("unhandledRejection", (e) => { console.error("unhandled", String(e).slice(0, 200)); });
const REPO = process.env.REPO!, PW = process.env.PW_DIR!, FONT = process.env.CJK_FONT!, OUT = process.env.OUT!, LABEL = process.env.LABEL ?? "after";
const { s3bRig } = await import(join(REPO, "tests/helpers/hub-s3b-rig.ts"));
const { createHubRoomInvitations, HUB_ROOM_INVITATIONS_MIGRATION } = await import(join(REPO, "src/hub/invitations.ts"));
const { personKeyString } = await import(join(REPO, "src/hub/identity.ts"));
const { createOwnedPki } = await import(join(REPO, "scripts/manual/hub-connector-4c/rig.mts"));
const NAMES = ["Atlas","Quill","Sage","Nova","Tide","Atlas","Pixel","Ember","Flint","Harbor","Iris","Juniper","Kite","Lumen","Maple","Nimbus","Onyx","Pebble","Quartz","Reed","Slate","Thistle","Umber","Vale","Willow","Yarrow","Zephyr","Birch","Cedar","Dune"];
const OWNERS = [["example-owner","Example owner"],["alex-sample","Alex Sample"],["casey-sample","Casey Sample"],["morgan-sample","Morgan Sample"],["taylor-sample","Taylor Sample"],["jordan-sample","Jordan Sample"]];
const MEMBERS = ["Riley Sample","Avery Sample","Quinn Sample","Rowan Sample","Skyler Sample"];
mkdirSync(OUT, { recursive: true });
const scratch = mkdtempSync(join(OUT, "owned-")), home = join(scratch, "home");
mkdirSync(join(home, ".local/share/fonts"), { recursive: true, mode: 0o700 }); copyFileSync(FONT, join(home, ".local/share/fonts/NotoSansCJKtc-Regular.otf"));
const pki = createOwnedPki(join(scratch, "pki")), pw = createRequire(join(resolve(PW), "package.json"))("playwright-core");
const env: Record<string, string | undefined> = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share") };
let r: any, browser: any; const errors: string[] = []; const out: any = {};
const server = createHttps({ key: readFileSync(pki.key), cert: readFileSync(pki.cert) }, (req, res) => { if (!r?.http.handle(req, res)) { res.writeHead(404); res.end(); } });
try {
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  r = await s3bRig({ webOrigin: origin, realAudit: true, roomOffice: true });
  HUB_ROOM_INVITATIONS_MIGRATION.up(r.db); r.httpDeps.roomInvitations = createHubRoomInvitations;
  r.httpDeps.roomAssistant = { available: () => ({ enabled: true, backend: "inert", running: 0, cap: 3, state: "idle" }), ask: async () => ({ text: "ok" }), forget() {} };
  await r.restartHttp();
  const manager = await r.signIn("admin");
  const owners: any[] = [];
  for (const [k, [login, name]] of OWNERS.entries()) {
    const key = r.addPerson(login, name), session = await r.signIn(login), fleetId = randomUUID();
    r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed" }, (state: any) => {
      state.fleets.push({ id: fleetId, owner: key, generation: 1, credentialHash: null, status: "active", label: name.split(" ")[0] + " fleet" }); });
    const link = r.link(fleetId, key, 1, ["welcome-caps-v1", "room-ask-v1"]);
    const mine = NAMES.slice(k * 5, k * 5 + 5).map(displayName => ({ id: randomUUID(), fleetId, owner: key, displayName, revision: 1, state: "published" as const, dataViewId: "agent", allowedTools: [], policyDigest: "c".repeat(64) }));
    await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: mine }, link) as never, link);
    for (const x of mine) await r.call(session, "POST", "/hub/v1/grants", { exposureId: x.id, exposureRevision: 1, login: "admin", days: 7 });
    for (const x of mine.slice(0, 2)) { const ir = await r.call(session, "PUT", `/hub/v1/exposures/${x.id}/intro`, { revision: 1, text: "Answers release questions; keeps the checklist." }); if (ir.status !== 200) console.error("intro", ir.status, JSON.stringify(ir.json)); }
    owners.push({ key, session, mine, login, link });
  }
  const extra = MEMBERS.map((name) => r.addPerson(name.toLowerCase().replace(" ", "."), name));
  browser = await pw.chromium.launch({ headless: true, env, args: ["--no-sandbox"] });
  const runs = (process.env.SHORT ? [["desk", "zh-TW", "light"]] : [["desk", "zh-TW", "light"], ["phone", "zh-TW", "dark"], ["desk", "en", "dark"], ["phone", "en", "light"]]) as const;
  for (const [device, lang, theme] of runs) {
    const tag = `${device}-${lang}-${theme}`, phone = device === "phone";
    const made = await r.call(manager, "POST", "/hub/v1/rooms", { name: lang === "en" ? "Example project" : "範例專案", assistant: true });
    const roomId = made.json.room.id;
    for (const key of [...owners.map(o => o.key), ...extra]) await r.call(manager, "POST", `/hub/v1/rooms/${roomId}/members`, { kind: "person", id: personKeyString(key) });
    for (const o of owners) await r.call(manager, "POST", `/hub/v1/rooms/${roomId}/invitations`, { agents: o.mine.map((x: any) => x.id) });
    for (let round = 0; round < 6; round++) {
      for (const o of owners) { const inv = await r.call(o.session, "GET", "/hub/v1/invitations"); for (const i of inv.json?.invitations ?? []) await r.call(o.session, "POST", `/hub/v1/invitations/${i.id}/accept`, {}); }
      const n = (await r.call(manager, "GET", `/hub/v1/rooms/${roomId}`)).json?.members?.filter((m: any) => m.kind === "agent").length ?? 0;
      if (n >= 30) break;
      if (round === 5) errors.push(`${tag}: only ${n} agents joined`);
      for (const o of owners) await r.call(manager, "POST", `/hub/v1/rooms/${roomId}/invitations`, { agents: o.mine.map((x: any) => x.id) });
      await new Promise(res => setTimeout(res, 300));
    }
    await r.call(manager, "POST", `/hub/v1/rooms/${roomId}/messages`, { text: lang === "en" ? "Release notes are ready for review." : "發行說明已經可以審閱了。", idempotencyKey: randomUUID() });
    const _p = process.env.LONG ? (lang === "en" ? "Release planning for the web team: questions about the next release, decisions on what ships and when, the weekly checklist, and notes for the people who answer on call this week." : "網頁組的發版規劃：下一版的問題、要上哪些功能與什麼時候上的決定、每週的檢查清單，以及本週值班同仁需要知道的事項。若有緊急狀況，請先在這裡留言，再通知值班的人，並附上相關的連結與截圖，方便大家一起查看與追蹤後續處理。")
      : lang === "en" ? "Release planning for the web team: questions, decisions and the weekly checklist." : "網頁組的發版規劃：問題、決定，以及每週的檢查清單。";
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: process.env.SHORT ? Number(process.env.SHORT) : 900 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: 2,
      locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: theme, ignoreHTTPSErrors: true, ...(process.env.REDUCE ? { reducedMotion: "reduce" } : {}) });
    await context.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(lang)});localStorage.setItem('agend_theme',${JSON.stringify(theme)});localStorage.setItem('agend_tour_done','1');` });
    const page = await context.newPage(); page.setDefaultTimeout(20_000); page.on("pageerror", (e: Error) => errors.push(tag + ": " + e.message));
    const signIn = async (who: string) => { await context.clearCookies(); await page.goto(`${origin}/ui/hub?room=${roomId}`); await page.fill("#hubLogin", who); await page.fill("#hubPassword", "pw-" + who); await page.locator(".hub-signin button[type=submit]").click();
      await page.locator(".hub-chat-head").waitFor(); await page.waitForTimeout(1500); if (!phone && await page.locator(".hub-room-members").isVisible()) { await page.locator(".hub-room-rail-toggle").click(); await page.waitForTimeout(300); } };
    const shot = async (name: string) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400); await page.screenshot({ path: join(OUT, `${tag}-${LABEL}-${name}.png`) }); };
    const office = async () => { await page.goto(`${origin}/ui/hub?room=${roomId}&view=office`); await page.locator(".oo-stage canvas").first().waitFor(); await page.waitForTimeout(3000); };
    try {
      const st = (o: any, x: any, s: any) => r.http.receive(r.frame("agent.state", { exposureId: x.id, ...s }, o.link) as never, o.link);
      await st(owners[0], owners[0].mine[1], { state: "working" }); await st(owners[2], owners[2].mine[0], { state: "working" });
      await st(owners[3], owners[3].mine[2], { state: "paused", reason: "quota" });
      owners[4].link.alive = false;                                     // one owner's computer offline: its 5 agents
      await signIn("admin");
      await office(); await shot("office");
      out[tag] = await page.evaluate(() => {
        const oo = document.querySelector(".hub-room-office .oo");
        const people = [...document.querySelectorAll(".hub-room-office .oo-desks .oo-desk")].map((b) => { const r = (b as HTMLElement).getBoundingClientRect(); return { h: Math.round(r.height), inView: r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5 && r.width > 2 }; });
        const chips = [...document.querySelectorAll(".hub-room-office .oo-zone-pills .btn")].map((b) => { const r = (b as HTMLElement).getBoundingClientRect(), box = (b.closest(".oo-zone-pills") as HTMLElement).getBoundingClientRect();
          return { t: (b.textContent || "").trim(), ok: (b as HTMLElement).scrollWidth <= (b as HTMLElement).clientWidth + 1 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.right <= innerWidth + 0.5 }; });
        return { zoom: document.querySelector(".hub-room-office .oo-zoom-pct")?.textContent ?? null, tagsOff: !!oo && oo.hasAttribute("data-tags-off"),
          people: people.length, peopleInView: people.filter((p) => p.inView).length, minChipH: people.length ? Math.min(...people.map((p) => p.h)) : null,
          chipsBad: chips.filter((c) => !c.ok).map((c) => c.t), chips: chips.map((c) => c.t) };
      });
    } catch (e) { errors.push(tag + ": " + String(e).slice(0, 300)); }
    await context.close();
  }
} finally { await browser?.close().catch(() => {}); server.close(); }
console.log(JSON.stringify({ errors, out }));
process.on("unhandledRejection", () => {});
process.exit(errors.length ? 1 : 0);

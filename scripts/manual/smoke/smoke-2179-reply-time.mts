// #2179 from defaults (fleet decision a78ebdc5): the sidebar says who has replied — the time of each agent's last reply to
// a person at the end of its row's second line (B5), a fresh one highlighted and fading by itself, and an opt-in sort by
// last reply. Demo names only. Replies are put in the real chat history (FleetManager.emitSseEvent "message", role
// agent — the reply tool's own path), then a status frame, as the fleet sends them. A fresh profile with nothing seeded
// signs in through the visible /signin (a phone opens the drawer with ☰). Per case:
//   - each row with a reply shows its time on screen, at the end of its second line, the name and % on the first;
//   - a reply under 10 minutes old is highlighted (--reply-a), a newer one under a minute pulses once — not under
//     reduced motion (its animation is none);
//   - Custom (the default, said on the sort button): a new reply in the middle of the list moves no row, and its time
//     reads "just now" / 剛剛 with the next status frame (sent here at once; the fleet sends one at least every 10 s, the
//     public link's poll carries one each time — so this shows the rendering, not the natural delay);
//   - the menu → Recent replies: one list by last reply, the button says so, the choice is saved (POST /ui/prefs 200)
//     and a reload keeps it (then put back to Custom for the next case);
//   - the temporary public link (it never writes preferences): the times show, no sort button (blocked: no way to
//     change it there);
//   - no page error (WebKit's own lines only; the opening navigation's stream/poll/session cancels by position).
// Cases: desk light (English), phone dark (zh-TW, reduced motion, a LAN origin in Chromium), the public link (desk light,
// reduced motion). PW_DIR=… REPO=… OUT=… [PW_ENGINE=webkit] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2179-reply-time.mts
import { bootFixture, freshPage, mounted, openPublicLink, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2179-reply-time";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
const CANCEL = /^(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/(events|poll)|auth\/session)(\?\S*)? due to access control checks\.$/;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48600), classic: false });
const fm = fx.fm;
// Demo agents, all in one tag group so Custom's order is theirs: [name, minutes since its last reply (null: none)].
const AGENTS: Array<[string, number | null]> = [["observability-dashboards", 0.3], ["billing-reconciliation", 4], ["search-indexer", 35],
  ["customer-support-macros", null], ["nightly-benchmarks", 300], ["docs-site-builder", 2]];
const names = AGENTS.map(([n]) => n);
for (const name of Object.keys(fm.fleetConfig.instances)) if (!names.includes(name)) delete fm.fleetConfig.instances[name];
for (const n of names) { const i = fm.fleetConfig.instances[n]; delete i.display_name; i.tags = ["demo"]; }
fm.fleetConfig.teams = {};
fm.saveFleetConfig();
const { OPERATOR } = await import(process.env.REPO + "/src/web-prefs.ts");
/** A reply by `name`, `min` minutes ago — the reply tool's path into the chat history — then a status frame. */
function reply(name: string, min: number) {
  fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: "Done.", ts: new Date(Date.now() - min * 60000).toISOString() });
}
const status = () => fm.emitSseEvent("status", fm.getUiStatus());
function seed() { for (const [n, m] of AGENTS) if (m != null) reply(n, m); status(); }
seed();

async function openDrawer(p: FreshPage) {
  if (p.page.viewportSize().width < 760 && !(await p.page.locator(".shell.sb-open").count())) {
    const all = p.page.locator('button[aria-controls="sidebar"]'), end = Date.now() + 10000;
    let clicked = false;
    while (!clicked && Date.now() < end) {
      for (let i = 0; i < await all.count() && !clicked; i++) if (await all.nth(i).isVisible()) { await all.nth(i).click(); clicked = true; }
      if (!clicked) await p.page.waitForTimeout(150);
    }
    await p.page.waitForSelector(".shell.sb-open", { timeout: 5000 });
  }
}
/** The list as a person reads it: groups, and each row's name, time, highlight and where its time sits. */
const READ = `(() => {
  const rows = [...document.querySelectorAll("#instanceList a.inst")].map((a) => {
    const when = a.querySelector(".inst-when"), name = a.querySelector(".inst-name"), meta = a.querySelector(".inst-line .v-meta");
    const r = a.getBoundingClientRect(), w = when ? when.getBoundingClientRect() : null, nm = name.getBoundingClientRect();
    const cs = getComputedStyle(a);
    return { name: name.textContent, when: when ? when.textContent : null, fresh: !!(when && when.classList.contains("fresh")),
      replied: a.classList.contains("replied"), fade: a.style.getPropertyValue("--reply-a"), just: a.classList.contains("just"), anim: cs.animationName, bg: cs.backgroundColor,
      pctOnNameLine: !!meta && meta.parentElement === name.parentElement,   // the % ends the name's line (empty without a context figure)
      whenOnScreen: !!w && w.width > 0 && w.top >= 0 && w.bottom <= innerHeight && w.left >= 0 && w.right <= innerWidth,
      whenBelowName: !!w && w.top >= nm.bottom - 2, whenAtEnd: !!w && r.right - w.right < 60 };
  });
  const groups = [...document.querySelectorAll("#instanceList .v-group")].map((g) => [g.querySelector(".v-group-head .grow").textContent,
    [...g.querySelectorAll(".inst-name")].map((n) => n.textContent)]);
  const btn = document.querySelector("#instanceList .nav-sort-btn");
  return { rows, groups, sort: btn ? btn.textContent.trim() : null, sortIsButton: !!(btn && btn.tagName === "BUTTON") };
})()`;
const results: any[] = [];
async function runCase(name: string, open: () => Promise<FreshPage>, lang: "en" | "zh-TW", writes: boolean) {
  const p = await open();
  await mounted(p.page, 30000);
  await p.page.waitForTimeout(800);
  const navEnd = p.errors.length;
  await openDrawer(p);
  await p.page.waitForSelector("#instanceList .inst-when", { timeout: 15000 });
  await p.page.waitForTimeout(500);
  const L = lang === "en" ? { custom: "Custom", recent: "Recent replies", just: "just now", group: "Recent replies first", min4: "4 min ago" }
    : { custom: "自訂", recent: "最近回覆", just: "剛剛", group: "最近回覆在上", min4: "4 分鐘前" };
  const a = await p.page.evaluate(READ) as any;
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "1-custom") });
  const row = (r: any, n: string) => r.rows.find((x: any) => x.name === n);
  const reduced = name.includes("reduced");
  const chk: Record<string, boolean> = {
    timesShown: row(a, "billing-reconciliation")?.when === L.min4 && row(a, "customer-support-macros")?.when === null,
    b5Layout: ["billing-reconciliation", "search-indexer"].every((n) => row(a, n).pctOnNameLine && row(a, n).whenBelowName && row(a, n).whenAtEnd && row(a, n).whenOnScreen),
    freshHighlighted: row(a, "billing-reconciliation").replied && Number(row(a, "billing-reconciliation").fade) > 0.5 && row(a, "billing-reconciliation").fresh
      && !row(a, "search-indexer").replied && !row(a, "nightly-benchmarks").fresh,
    pulseUnderAMinute: row(a, "observability-dashboards").just && (reduced ? row(a, "observability-dashboards").anim === "none" : row(a, "observability-dashboards").anim === "inst-just"),
    customByDefault: writes ? a.sort === L.custom && a.sortIsButton : a.sort === null,
  };
  // #2181 review: the tint as painted — a fresh row's background is tinted, an expired one's is not; hovering or opening
  // a fresh row shows the plain hover / open colour, never the tint over it (a desk: a phone has no hover).
  const clear = (c: string) => c === "transparent" || /rgba\(0, 0, 0, 0\)/.test(c);
  chk.tintPainted = !clear(row(a, "billing-reconciliation").bg) && clear(row(a, "search-indexer").bg);
  if (p.page.viewportSize().width >= 760) {
    const link = (n: string) => p.page.locator("#instanceList a.inst").filter({ has: p.page.locator(".inst-name", { hasText: new RegExp(`^${n}$`) }) }).first();
    const bgOf = (n: string) => link(n).evaluate((el: Element) => getComputedStyle(el).backgroundColor);
    await link("search-indexer").hover(); await p.page.waitForTimeout(150);
    const plainHover = await bgOf("search-indexer");
    await link("billing-reconciliation").hover(); await p.page.waitForTimeout(150);
    const freshHover = await bgOf("billing-reconciliation");
    await link("billing-reconciliation").click(); await p.page.mouse.move(2, 2); await p.page.waitForTimeout(400);
    const freshOpen = await bgOf("billing-reconciliation");
    chk.tintNotOverHoverOrOpen = freshHover === plainHover && freshOpen === plainHover && freshOpen !== row(a, "billing-reconciliation").bg;
  }
  // Custom: a new reply in the middle of the list moves no row; its time reads "just now" with the next status frame.
  const before = JSON.stringify(a.groups);
  reply("nightly-benchmarks", 0); status();
  await p.page.waitForFunction(([n, j]: string[]) => [...document.querySelectorAll("#instanceList a.inst")].some((x) => x.querySelector(".inst-name").textContent === n && x.querySelector(".inst-when")?.textContent === j),
    ["nightly-benchmarks", L.just], { timeout: 15000 }).catch(() => null);
  const b = await p.page.evaluate(READ) as any;
  chk.customNeverJumps = JSON.stringify(b.groups) === before;
  chk.liveReplyShown = row(b, "nightly-benchmarks")?.when === L.just && row(b, "nightly-benchmarks")?.replied;
  if (writes) {
    // The menu → Recent replies: one list by last reply; saved; kept across a reload.
    await p.page.locator("#instanceList .nav-sort-btn").click();
    await p.page.waitForSelector(".nav-sort-menu", { timeout: 5000 });
    await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "2-menu") });
    const saved = p.page.waitForResponse((r: any) => new URL(r.url()).pathname === "/ui/prefs" && r.request().method() === "POST", { timeout: 10000 }).then((r: any) => r.status()).catch(() => 0);
    await p.page.locator('.nav-sort-menu input[value="recent"][name="nav-sort-mode"]').check();
    chk.sortSaved = (await saved) === 200;
    await p.page.keyboard.press("Escape");
    await p.page.waitForTimeout(400);
    const c = await p.page.evaluate(READ) as any;
    const recentOrder = ["nightly-benchmarks", "observability-dashboards", "docs-site-builder", "billing-reconciliation", "search-indexer", "customer-support-macros"];
    chk.recentList = JSON.stringify(c.groups) === JSON.stringify([[L.group, recentOrder]]) && c.sort === L.recent;
    await p.page.reload();
    await mounted(p.page, 30000);
    await openDrawer(p);
    await p.page.waitForSelector("#instanceList .inst-when", { timeout: 15000 });
    await p.page.waitForTimeout(500);
    const d = await p.page.evaluate(READ) as any;
    chk.keptAfterReload = d.sort === L.recent && d.groups[0]?.[0] === L.group;
    await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "3-recent-after-reload") });
    for (const who of [p.personKey, OPERATOR]) fm.webPrefs.write(who, new Map([["nav.sort", null]]));   // the next case from defaults
  }
  // Put the live reply back as it was, for the next case.
  seed();
  const errors = p.errors.filter((e, i) => { const t = e.replace(/ @ \S+$/, ""); return !(ENGINE === "webkit" && (WEBKIT_OWN.has(t) || (i < navEnd && CANCEL.test(t)))); });
  chk.noErrors = errors.length === 0;
  const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length, failed, a, errors });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${ENGINE}-${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify({ rows: a.rows.slice(0, 3), sort: a.sort, groups: a.groups, errors }).slice(0, 900)}` : ""}`);
  await p.ctx.close();
}
await runCase("desk-light-en", () => freshPage(fx, { device: "desk", theme: "light", lang: "en" }), "en", true);
await runCase(ENGINE === "webkit" ? "phone-dark-zh-TW-reduced" : "phone-dark-zh-TW-lan-reduced",
  () => freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, ENGINE === "webkit" ? { reducedMotion: true } : { origin: "lan", reducedMotion: true }), "zh-TW", true);
const link = await openPublicLink(fx);
await runCase("public-link-desk-light-en-reduced", () => link.publicPage({ device: "desk", theme: "light", lang: "en" }, { reducedMotion: true }), "en", false);
await link.close();
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((x) => x.name).join(", ")}` : `PASS (${ENGINE})`);
await fx.close();
process.exit(bad.length ? 1 : 0);

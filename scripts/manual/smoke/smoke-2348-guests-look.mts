// #2348 follow-up: how Settings → Access & security → Guests looks, from defaults (fleet decision a78ebdc5): a fresh
// profile reaching /settings/access as the fixture's admin, demo people only. Three people with access, each in one
// state: Alice signed in (two remembered browsers), Bob whose code's DM failed (Discord privacy), Carol whose code was
// sent; Alice's agents opened for editing with one more ticked (an edited row); two people seen in chat (Dan, Eve) in
// Add a person. The picker's list is stubbed at guestPeople (the fixture has no chat history to note people from).
// Per case (desk light en, desk dark zh-TW, phone light zh-TW, phone dark en; reduced motion on the phone):
// - the section draws its people, chips and states; an edited row carries the straight bar (`.s-dirty`, #2330);
// - no element of the section has a rounded filled background or a ring (the fixed template), no horizontal overflow
//   on the page, no console error, no CSP violation;
// - Recent changes (#2499 review): two audit rows from the event log, flat like the rest.
// Pictures: <case>-1-access (people with access, one being edited), -2-add (Add a person), -3-recent (Recent changes).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2348-guests-look.mts
import { writeFileSync } from "node:fs";
import { bootFixture, shotPath, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2348-guests-look";
const REPO = process.env.REPO!;
const AGENTS = ["observability-dashboards", "billing-reconciliation", "search-indexer", "docs-site-builder"];
const PEOPLE = {
  alice: { id: "101101101101101101", name: "Alice", user: "alice.k", agents: [AGENTS[0]] },
  bob: { id: "202202202202202202", name: "Bob", user: "bobby", agents: [AGENTS[1], AGENTS[2]] },
  carol: { id: "303303303303303303", name: "Carol", user: "carol_w", agents: [AGENTS[3]] },
};
const grants = Object.values(PEOPLE).map((p) => `      "demo:${p.id}": { name: ${p.name}, instances: ${JSON.stringify(p.agents)} }`).join("\n");
const fx = await bootFixture({ port: Number(process.env.HP ?? 48660), webYaml: `  guests:\n    enabled: true\n    grants:\n${grants}` });
const fm = fx.fm as any;
const DEMO = new Set(AGENTS);
for (const name of Object.keys(fm.fleetConfig.instances)) if (!DEMO.has(name)) delete fm.fleetConfig.instances[name];
const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
fm.worlds.set("demo", { adapter: { id: "demo", type: "discord", stop: async () => {} }, groupId: "G", accessManager: { getMode: () => "open", isAllowed: () => true }, stop: async () => {} });
fm.initializeWebSessions();
for (const p of Object.values(PEOPLE)) fm.webPrefs.setProfileName(`person:demo:${p.id}`, p.name);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
fm.guestPeople = () => ({ people: [
  { adapterId: "demo", userId: "404404404404404404", platform: "discord", username: "dan.r", name: "Dan", lastSeen: ago(35), instances: [AGENTS[2]] },
  { adapterId: "demo", userId: "505505505505505505", platform: "discord", username: "eve", name: "Eve", lastSeen: ago(60 * 26), instances: [AGENTS[0], AGENTS[3]] },
] });
if (!fm.eventLog) { const { EventLog } = await import(REPO + "/src/event-log.ts"); fm.eventLog = new EventLog(`${fx.dir}/smoke-events.db`); }
// Two audit rows (Recent changes): Bob given an agent (confirmed in General), Carol's earlier agent taken away.
fm.noteGuestGrantChange({ by: null, via: "confirmed", account: `demo:${PEOPLE.bob.id}`, added: [AGENTS[2]], removed: [], endedSessions: 0 });
fm.noteGuestGrantChange({ by: "session:smoke", via: "direct", account: `demo:${PEOPLE.carol.id}`, added: [], removed: [AGENTS[1]], endedSessions: 1 });
const REAL = /agend-|t15\d{6}|web-claude|\bsol\b|\bfable\b|qa-1|rd1-|awp-|doupo-|研一|鬥破|己把鳩/;

const results: Array<Record<string, unknown>> = [];
let failed = 0;
function record(name: string, c: Record<string, boolean>, extra: Record<string, unknown> = {}) {
  const bad = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) failed++;
  results.push({ name, ok: !bad.length, checks: c, ...extra });
  console.log(`${bad.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""} ${JSON.stringify(extra).slice(0, 800)}`);
}
// Every element in the section: a filled background with a radius (a rounded fill), or a box-shadow ring.
const LOOK = `(() => {
  const root = document.querySelector(".s-guests");
  const fills = [], rings = [];
  for (const el of root.querySelectorAll("*")) {
    if (el.matches("input, button, .btn, select, textarea, .g-av")) continue;
    const s = getComputedStyle(el), r = parseFloat(s.borderTopLeftRadius) || 0;
    const filled = s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent";
    if (filled && r > 0) fills.push((el.className || el.tagName) + " r=" + r);
    if (s.boxShadow && s.boxShadow !== "none") rings.push(el.className || el.tagName);
  }
  const dirty = root.querySelector(".guest-row.s-dirty");
  return {
    rows: [...root.querySelectorAll(".guest-row .g-id strong")].map((x) => x.textContent),
    states: [...root.querySelectorAll(".guest-row .g-state")].map((x) => x.className),
    chips: root.querySelectorAll(".g-chip").length,
    dirtyBar: dirty ? getComputedStyle(dirty, "::before").content !== "none" || getComputedStyle(dirty).boxShadow !== "none" : false,
    fills: fills.slice(0, 8), rings: rings.slice(0, 8),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    text: document.querySelector(".s-guests").innerText,
    chipStyle: (() => { const c = root.querySelector(".g-chip"); if (!c) return null; const s = getComputedStyle(c); return [s.backgroundColor, s.borderTopLeftRadius, s.borderTopColor].join(" | "); })(),
    namesStyle: (() => { const c = root.querySelector(".guest-names"); if (!c) return null; const s = getComputedStyle(c); return [s.backgroundColor, s.borderTopLeftRadius].join(" | "); })(),
  };
})()`;

const CASES: MatrixCase[] = [
  { device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" },
  { device: "phone", theme: "light", lang: "zh-TW" }, { device: "phone", theme: "dark", lang: "en" },
];
for (const c of CASES) {
  const name = `${c.device}-${c.theme}-${c.lang}`;
  const alice = { adapterId: "demo", userId: PEOPLE.alice.id };
  for (let i = 0; i < 2; i++) fm.webSessions.create({ tier: "guest", surface: "local", label: "smoke", tokenEpoch: tokenEpoch(fm.webToken), owner: alice });
  fm.rememberGuestDevice(alice, { surface: "local", label: "Firefox" });
  fm.rememberGuestDevice(alice, { surface: "local", label: "Safari" });
  fm.guestCodeSent.set(`demo:${PEOPLE.bob.id}`, { at: Date.now() - 4 * 60_000, outcome: { kind: "dm_failed", platform: "discord", reason: "Cannot send messages to this user" } });
  fm.guestCodeSent.set(`demo:${PEOPLE.carol.id}`, { at: Date.now() - 60_000, outcome: { kind: "sent", expiresInMs: 9 * 60_000 } });
  const { ctx, page, csp } = await fx.page(c, { path: "/settings/access" });
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  const ck: Record<string, boolean> = {};
  await page.waitForSelector(".s-guests .guest-row", { timeout: 15000 });
  // Alice's agents, one more ticked: an edited row.
  await page.click(`.s-guests .guest-row[data-account="demo:${PEOPLE.alice.id}"] .guest-actions button[aria-expanded]`);
  await page.locator(`.s-guests .guest-row[data-account="demo:${PEOPLE.alice.id}"] .g-edit input[type=checkbox]`).nth(1).check();
  await page.waitForTimeout(300);
  await page.evaluate("document.activeElement && document.activeElement.blur()");
  const card = page.locator(".s-guests");
  await card.scrollIntoViewIfNeeded();
  const a = await page.evaluate(LOOK) as any;
  ck.threePeople = a.rows.join() === "Alice,Bob,Carol";
  ck.statesShown = a.states.some((s: string) => /\bon\b/.test(s)) && a.states.some((s: string) => /\bwarn\b/.test(s)) && a.states.some((s: string) => /\bsent\b/.test(s));
  ck.chips = a.chips >= 4;
  ck.editedRowBar = a.dirtyBar;
  ck.noRoundedFill = a.fills.length === 0;
  ck.noRing = a.rings.length === 0;
  ck.noOverflow = !a.overflow;
  ck.noRealNames = !REAL.test(a.text);
  await card.screenshot({ path: shotPath(SMOKE, c, "1-access") });
  // Add a person: the people seen in chat.
  await page.locator(".s-guests #grantsSearch").scrollIntoViewIfNeeded();
  await page.waitForSelector(".s-guests .g-cand", { timeout: 10000 });
  const b = await page.evaluate(LOOK) as any;
  ck.pickerNoRoundedFill = b.fills.length === 0;
  ck.picker = (await page.locator(".s-guests .g-cand").count()) === 2;
  const pick = page.locator(".s-guests .g-pick");
  await pick.screenshot({ path: shotPath(SMOKE, c, "2-add") });
  const recent = page.locator(".s-guests #grantsRecentList");
  await recent.scrollIntoViewIfNeeded();
  ck.recentRows = (await page.locator(".s-guests #grantsRecentList .g-audit-row").count()) === 2;
  await recent.screenshot({ path: shotPath(SMOKE, c, "3-recent") });
  const cspHits = await csp();
  ck.noErrors = errors.length === 0 && cspHits.length === 0;
  record(name, ck, { chip: a.chipStyle, names: a.namesStyle, fills: a.fills, rings: a.rings, pickerFills: b.fills, errors, csp: cspHits });
  await ctx.close();
  fm.webSessions.list(undefined, (r: any) => r.tier === "guest").forEach((r: any) => fm.webSessions.revoke?.(r.id));
}
writeFileSync(shotPath(SMOKE, "results", "x").replace(/[^/]+$/, "results.json"), JSON.stringify(results, null, 1));
console.log(`${failed ? "FAIL" : "PASS"} ${results.length} cases`);
await fx.close();
process.exit(failed ? 1 : 0);

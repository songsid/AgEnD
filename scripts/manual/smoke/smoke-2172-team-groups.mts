// #2172 from defaults (fleet decision a78ebdc5): with no filter, the sidebar lists an agent under its fleet.yaml team,
// whatever its tags — the user's case was a team member tagged wiki, docs, knowledge listed under "wiki". Demo names
// only: a demo team holds an agent with those unrelated tags, another agent in no team carries the tag "wiki".
// A fresh profile with nothing seeded signs in through the visible /signin and reads the sidebar (a phone opens the
// drawer with ☰), per case:
//   - the team member is under its team's heading (marked as a team), not under "#wiki";
//   - the agent in no team is under "#wiki" (marked as a tag);
//   - a second team's member is under that team; teams come before tags, "Other" last;
//   - folding the team is saved (POST /ui/prefs 200) and kept: after a reload it is still folded (#2173 review: a team's
//     key once failed the store's name check, so a fold or a drag snapped back) — not on the public link, which never
//     writes preferences;
//   - no page error (WebKit's own two lines only, as #2138's smoke).
// Cases: desk light (English), phone dark (zh-TW, reduced motion, a LAN origin in Chromium), the temporary public link
// (desk light, reduced motion; stubbed as the harness says).
//   PW_DIR=… REPO=… OUT=… [PW_ENGINE=webkit] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2172-team-groups.mts
import { bootFixture, freshPage, mounted, openPublicLink, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2172-team-groups";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
const fx = await bootFixture({ port: Number(process.env.HP ?? 48590), classic: false });
const fm = fx.fm;
const AGENTS: Record<string, string[]> = {
  "search-indexer": ["wiki", "docs", "knowledge"],     // in platform-team: the user's case
  "billing-reconciliation": ["finance"],               // in platform-team
  "nightly-benchmarks": ["ci"],                        // in release-crew
  "docs-site-builder": ["wiki"],                       // in no team
  "customer-support-macros": [],                       // in no team, no tag: Other
};
for (const name of Object.keys(fm.fleetConfig.instances)) if (!(name in AGENTS)) delete fm.fleetConfig.instances[name];
for (const [name, tags] of Object.entries(AGENTS)) { const i = fm.fleetConfig.instances[name]; delete i.display_name; if (tags.length) i.tags = tags; else delete i.tags; }
fm.fleetConfig.teams = { "platform-team": { members: ["search-indexer", "billing-reconciliation"] }, "release-crew": { members: ["nightly-benchmarks"] } };
fm.saveFleetConfig();

/** The sidebar as a person reads it: each group's mark, heading and the agents linked under it. */
const READ = `(() => [...document.querySelectorAll(".v-group:not(.v-fav):not(.v-pinned)")].map((g) => ({
  mark: g.querySelector(".v-group-kind.team") ? "team" : g.querySelector(".v-group-kind.tag") ? "#" : "",
  head: (g.querySelector(".v-group-head .grow") || {}).textContent || "",
  agents: [...g.querySelectorAll("a[href^='/ui/chat/']")].map((a) => decodeURIComponent(a.getAttribute("href").slice(9))),
})))()`;
const { OPERATOR } = await import(process.env.REPO + "/src/web-prefs.ts");
const results: any[] = [];
async function openDrawer(p: FreshPage) {
  // A phone reads the sidebar in its drawer: ☰ opens it (as #2053's smoke does — the first visible one, retried).
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
const teamHead = (p: FreshPage) => p.page.locator(".v-group:not(.v-fav) .v-group-head").filter({ has: p.page.locator(".v-group-kind.team") }).filter({ hasText: "platform-team" }).first();
async function runCase(name: string, open: () => Promise<FreshPage>, other: string, saves: boolean) {
  const p = await open();
  await mounted(p.page, 30000);
  await openDrawer(p);
  await p.page.waitForSelector(".v-group .v-group-head", { timeout: 15000 });
  await p.page.waitForTimeout(600);
  const groups = await p.page.evaluate(READ) as Array<{ mark: string; head: string; agents: string[] }>;
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "sidebar") });
  const at = (agent: string) => groups.find((g) => g.agents.includes(agent));
  // Fold the team: saved, and still folded after a reload.
  let foldSaved: boolean | null = null, foldKept: boolean | null = null;
  if (saves) {
    const saved = p.page.waitForResponse((r: any) => new URL(r.url()).pathname === "/ui/prefs" && r.request().method() === "POST", { timeout: 10000 }).then((r: any) => r.status()).catch(() => 0);
    await teamHead(p).click();
    foldSaved = (await saved) === 200;
    await p.page.waitForTimeout(500);
    await p.page.reload();
    await mounted(p.page, 30000);
    await openDrawer(p);
    await p.page.waitForSelector(".v-group .v-group-head", { timeout: 15000 });
    await p.page.waitForTimeout(600);
    foldKept = (await teamHead(p).getAttribute("aria-expanded")) === "false";
    await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "folded-after-reload") });
    for (const who of [p.personKey, OPERATOR]) fm.webPrefs.write(who, new Map([["nav.collapsed", null], ["nav.order", null]]));   // the next case from defaults
  }
  const errors = p.errors.filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.has(e.replace(/ @ \S+$/, ""))));
  const chk = {
    teamMemberUnderTeam: at("search-indexer")?.head === "platform-team" && at("search-indexer")?.mark === "team",
    notUnderItsTag: !groups.some((g) => g.mark === "#" && g.head === "wiki" && g.agents.includes("search-indexer")),
    secondMemberToo: at("billing-reconciliation")?.head === "platform-team",
    otherTeam: at("nightly-benchmarks")?.head === "release-crew" && at("nightly-benchmarks")?.mark === "team",
    noTeamUnderTag: at("docs-site-builder")?.head === "wiki" && at("docs-site-builder")?.mark === "#",
    restUnderOther: at("customer-support-macros")?.head === other && at("customer-support-macros")?.mark === "",
    // platform-team, release-crew (teams), #wiki (the tag), Other — in that order.
    teamsFirstOtherLast: JSON.stringify(groups.map((g) => [g.mark, g.head])) === JSON.stringify([["team", "platform-team"], ["team", "release-crew"], ["#", "wiki"], ["", other]]),
    ...(saves ? { foldSaved: !!foldSaved, foldKeptAfterReload: !!foldKept } : {}),
    noErrors: errors.length === 0,
  };
  const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length, failed, groups, errors });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${ENGINE}-${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify({ groups, errors }).slice(0, 800)}` : ""}`);
  await p.ctx.close();
}
await runCase("desk-light-en", () => freshPage(fx, { device: "desk", theme: "light", lang: "en" }), "Other", true);
await runCase(ENGINE === "webkit" ? "phone-dark-zh-TW-reduced" : "phone-dark-zh-TW-lan-reduced",
  () => freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, ENGINE === "webkit" ? { reducedMotion: true } : { origin: "lan", reducedMotion: true }), "其他", true);
const link = await openPublicLink(fx);
await runCase("public-link-desk-light-en-reduced", () => link.publicPage({ device: "desk", theme: "light", lang: "en" }, { reducedMotion: true }), "Other", false);
await link.close();
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : `PASS (${ENGINE})`);
await fx.close();
process.exit(bad.length ? 1 : 0);

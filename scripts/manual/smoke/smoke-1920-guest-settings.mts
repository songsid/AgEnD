// #1920 phase 3 (P3b-2) Settings → Access & security → Guests on the realistic fixture, as an admin: guest sign-in on,
// two demo guests with access (#2348 grants: Alice to one demo agent, Bob to another; Alice signed in with a remembered
// browser), on a stubbed open connection (the fixture has no chat connections). Checks the card lists them with their
// agents, Sign out asks and signs out at once, and the page logs no error; saves a screenshot (desktop light and dark,
// phone).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-1920-guest-settings.mts
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-1920-guest-settings";
const named = ["observability-dashboards", "billing-reconciliation"];
const fx = await bootFixture({ port: Number(process.env.HP ?? 48380),
  webYaml: `  guests:\n    enabled: true\n    grants:\n      "demo:101101101101101101": { name: Alice, instances: [${JSON.stringify(named[0])}] }\n      "demo:202202202202202202": { name: Bob, instances: [${JSON.stringify(named[1])}] }` });
const fm = fx.fm;
// Demo names only in what is shot (the fixture's first names are a real fleet's): the picker lists every instance.
const DEMO = new Set([...named, "search-indexer", "customer-support-macros", "nightly-benchmarks", "docs-site-builder", "release-notes-drafter", "資料清洗與報表自動化助理"]);
for (const name of Object.keys(fm.fleetConfig.instances)) if (!DEMO.has(name)) delete fm.fleetConfig.instances[name];
const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");
// A demo open connection (no real adapter): what the card lists its agents for.
fm.worlds.set("demo", { adapter: { id: "demo", type: "discord", stop: async () => {} }, groupId: "G", accessManager: { getMode: () => "open", isAllowed: () => true }, stop: async () => {} });
fm.initializeWebSessions();
const alice = { adapterId: "demo", userId: "101101101101101101" }, bob = { adapterId: "demo", userId: "202202202202202202" };
fm.webPrefs.setProfileName(`person:${alice.adapterId}:${alice.userId}`, "Alice");
fm.webPrefs.setProfileName(`person:${bob.adapterId}:${bob.userId}`, "Bob");
const results: any[] = [];
for (const c of [{ device: "desk", theme: "light" }, { device: "desk", theme: "dark" }, { device: "phone", theme: "light" }] as const) {
  for (let i = 0; i < 2; i++) fm.webSessions.create({ tier: "guest", surface: "local", label: "smoke", tokenEpoch: tokenEpoch(fm.webToken), owner: alice });
  fm.rememberGuestDevice(alice, { surface: "local", label: "Firefox" });
  const { ctx, page } = await fx.page({ device: c.device, theme: c.theme, lang: "en" }, { path: "/settings/access" });
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  await page.waitForSelector(".s-guests .guest-row", { timeout: 10000 });
  const card = await page.$(".s-guests");
  await card.scrollIntoViewIfNeeded();
  const seen = await page.evaluate(`(() => ({
    rows: [...document.querySelectorAll(".s-guests .guest-row")].map((r) => r.querySelector(".g-id strong").textContent),
    agents: [...document.querySelectorAll(".s-guests .guest-row")].map((r) => [...r.querySelectorAll(".g-chip")].map((c) => c.textContent).join("+")),
    enabled: document.querySelector("#guestsEnabled").checked,
  }))()`);
  await card.screenshot({ path: shotPath(SMOKE, `${c.device}-${c.theme}`, "card") });
  // Sign out Alice: the app's question, then at once. (.btn-danger on a row is Remove access, since #2348.)
  const before = fm.webSessions.list(undefined, (r: any) => r.tier === "guest").length;
  await page.click(`.s-guests .guest-row[data-account="demo:${alice.userId}"] .guest-actions button:text-is("Sign out")`);
  await page.waitForSelector("dialog[open]", { timeout: 5000 });
  await page.click("dialog[open] .btn-danger, dialog[open] .btn-primary");
  await page.waitForTimeout(800);
  const after = fm.webSessions.list(undefined, (r: any) => r.tier === "guest").length;
  results.push({ case: `${c.device}-${c.theme}`, ...seen, signedOut: before > 0 && after === 0, errors });
  await ctx.close();
}
console.log(JSON.stringify(results, null, 1));
const bad = results.filter((r) => r.rows.join() !== "Alice,Bob" || r.agents.join() !== named.join() || !r.enabled || !r.signedOut || r.errors.length);
console.log(bad.length ? `FAIL ${bad.map((b) => b.case).join(", ")}` : "PASS");
await fx.close();
process.exit(bad.length ? 1 : 0);

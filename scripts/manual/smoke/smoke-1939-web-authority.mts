// #1939 S2a-2: Settings → Web → Web authority on the realistic fixture, as an admin: the switch on, 12 h, a non-loopback
// host in web.allowed_hosts (the warning), and the browser's own session authorized (§0). Checks the card renders what is
// in force and lists the authorized session, Revoke asks and revokes at once (the epoch moves, the list empties), and the
// page logs no error; saves the card (desktop light and dark, phone).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-1939-web-authority.mts
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";
const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");

const SMOKE = "smoke-1939-web-authority";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48390), instances: 8,
  webYaml: [
    "  allowed_hosts: [agend.example.com]",
    "  verified_authority:",
    "    enabled: true",
    "    max_session_hours: 12",
  ].join("\n") });
const fm = fx.fm;
const results: any[] = [];
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "en" }, { device: "phone", theme: "light", lang: "zh-TW" }] as const) {
  // A demo account's session, authorized (§0) — the fixture signs pages in with owner-less codes, so the card lists this one.
  fm.initializeWebSessions();
  const owner = { adapterId: "demo", userId: "101101101101101101" };
  const demo = fm.webSessions.create({ tier: "admin", surface: "local", label: "Firefox on Mac", tokenEpoch: tokenEpoch(fm.webToken), owner }).record;
  fm.sessionAuthorizationStore().authorize(demo.handle, owner, Date.now(), fm.webAuthorityState().epoch, Date.now() + 12 * 3_600_000);
  const { ctx, page } = await fx.page(c, { path: "/settings/access" });
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  await page.waitForSelector(".s-web-authority #vaEnabled", { timeout: 10000 });
  // Tall enough that the whole card is on screen: an element shot of a longer one runs under the sticky header/nav.
  await page.setViewportSize({ width: c.device === "phone" ? 390 : 1366, height: 4000 });
  await page.waitForTimeout(300);
  const card = await page.$(".s-web-authority");
  await card.scrollIntoViewIfNeeded();
  const seen = await page.evaluate(`(() => ({
    enabled: document.querySelector("#vaEnabled").checked,
    hours: document.querySelector("#vaHours").value,
    sessions: document.querySelectorAll("#vaSessions li").length,
    warning: !!document.querySelector("#vaLanWarning"),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))()`);
  await card.screenshot({ path: shotPath(SMOKE, `${c.device}-${c.theme}-${c.lang}`, "card") });
  // Revoke: the app's question, then at once.
  const before = fm.webAuthorityState().epoch;
  await page.click("#vaRevoke");
  await page.waitForSelector("dialog[open]", { timeout: 5000 });
  await page.click("dialog[open] .btn-danger, dialog[open] .btn-primary");
  await page.waitForTimeout(800);
  const after = fm.webAuthorityState().epoch;
  const emptied = await page.evaluate(`!!document.querySelector("#vaSessionsNone")`);
  results.push({ case: `${c.device}-${c.theme}-${c.lang}`, ...seen, revoked: after === before + 1 && emptied, errors });
  await ctx.close();
}
console.log(JSON.stringify(results, null, 1));
const bad = results.filter((r) => !r.enabled || r.hours !== "12" || r.sessions !== 1 || !r.warning || r.overflow || !r.revoked || r.errors.length);
console.log(bad.length ? `FAIL ${bad.map((b) => b.case).join(", ")}` : "PASS");
await fx.close();
process.exit(bad.length ? 1 : 0);

// #2208 from defaults (fleet decision a78ebdc5): a hand-written fleet.yaml whose two connections share one admin list
// through a YAML anchor and alias (`&admins` … `*admins`), and two agents sharing a description the same way. Each case
// is a fresh profile with nothing seeded, signed in through the visible /signin. It drives only visible UI: Settings →
// Connections → one connection's Settings → add a user to its list → Stage change → Apply changes. The change is held
// for a fleet admin (#1423); the admin confirms, as the General card or `agend settings confirm <id>` does (the
// store's decide). Judged, per case:
//   - the held change names only that connection (its scope and summary);
//   - fleet.yaml after: that connection's list has the user, the other connection's does not; the file loads with no
//     error, and the agents' untouched anchor and alias are still as written;
//   - the page reports no error ("Expected YAML collection", "internal error") and logs none.
// Cases (the file is put back between them):
//   - desk light en: the anchor holder (main);
//   - phone dark zh-TW (LAN origin in Chromium, reduced motion): the alias holder (side);
//   - the temporary public link (desk light, reduced motion): main again, held for an admin as everywhere.
// Nothing outside the product is started: an access edit only writes fleet.yaml and marks a restart as needed; the
// lifecycle is the fixture's stub. Demo names and ids only.
//   PW_DIR=… REPO=… OUT=… FONTCONFIG_FILE=/etc/fonts/fonts.conf [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2208-yaml-shared-nodes.mts
import { readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { bootFixture, freshPage, mounted, openPublicLink, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2208-yaml-shared-nodes";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
const CANCEL = /^(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/(events|poll)|auth\/session)(\?\S*)? due to access control checks\.$/;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48660), classic: false });
const fm = fx.fm;

// The operator's own file: the fixture's agents (a few), two connections sharing one admin list, two agents sharing
// one description. Written once; put back before every case.
const KEEP = ["observability-dashboards", "search-indexer", "billing-reconciliation"];
const agents = KEEP.map(n => `  ${n}:\n    working_directory: ${JSON.stringify(fx.dir)}\n    backend: claude-code\n`).join("")
  .replace(`  search-indexer:\n    working_directory: ${JSON.stringify(fx.dir)}\n    backend: claude-code\n`,
    `  search-indexer:\n    working_directory: ${JSON.stringify(fx.dir)}\n    backend: claude-code\n    description: &words Indexes the demo docs\n`)
  .replace(`  billing-reconciliation:\n    working_directory: ${JSON.stringify(fx.dir)}\n    backend: claude-code\n`,
    `  billing-reconciliation:\n    working_directory: ${JSON.stringify(fx.dir)}\n    backend: claude-code\n    description: *words\n`);
const web = readFileSync(fm.configPath, "utf8").split("\nweb:\n")[1];
const ORIGINAL = `health_port: ${new URL(fx.base).port}
channels:
  - id: main
    type: telegram
    mode: topic
    bot_token_env: DEMO_MAIN_TOKEN
    group_id: "-1009000000001"
    access:
      mode: locked
      allowed_users: &admins ["9000000001"]
  - id: side
    type: telegram
    mode: topic
    bot_token_env: DEMO_SIDE_TOKEN
    group_id: "-1009000000002"
    access:
      mode: locked
      allowed_users: *admins
instances:
${agents}web:
${web}`;
const restore = () => { writeFileSync(fm.configPath, ORIGINAL); fm.loadConfig(fm.configPath); };            // loadConfig takes its own save snapshot
const lists = () => {
  const d = parseDocument(readFileSync(fm.configPath, "utf8"));
  const js = d.toJS({ maxAliasCount: -1 }) as any;
  return { errors: d.errors.map(e => e.message), main: js.channels[0].access.allowed_users, side: js.channels[1].access.allowed_users, text: String(readFileSync(fm.configPath, "utf8")) };
};
const NEW = "9000000222";
const RAW = /Expected YAML collection|Refusing to save|internal error|unsupported_sensitive_effect/;

async function clickVisible(page: any, selector: string, timeout = 10000): Promise<void> {
  const all = page.locator(selector), end = Date.now() + timeout;
  do {
    for (let i = 0; i < await all.count(); i++) if (await all.nth(i).isVisible()) { await all.nth(i).click(); return; }
    await page.waitForTimeout(100);
  } while (Date.now() < end);
  throw new Error(`nothing visible matches ${selector} on ${page.url()}`);
}
const phone = (p: FreshPage) => p.page.viewportSize().width < 760;
async function toConnections(p: FreshPage) {
  if (phone(p) && !(await p.page.locator(".shell.sb-open").count())) await clickVisible(p.page, 'button[aria-controls="sidebar"]');
  await clickVisible(p.page, 'a[href="/settings"]');
  await p.page.waitForURL("**/settings", { timeout: 10000 });
  await clickVisible(p.page, 'a[href="/settings/bots"]');
  await p.page.waitForSelector(".s-row.s-conn", { timeout: 15000 });
}
async function addUser(p: FreshPage, id: string, lang: string) {
  const row = p.page.locator(".s-row.s-conn").filter({ has: p.page.locator(".tag", { hasText: new RegExp(`^${id}$`) }) }).first();
  await row.locator("button").last().click();                                             // Settings
  await p.page.waitForSelector("dialog[open] .chips-box input", { timeout: 10000 });
  const input = p.page.locator("dialog[open] .chips-box input").first();
  await input.fill(NEW); await input.press("Enter");
  await p.page.getByRole("button", { name: lang === "en" ? "Stage change" : "加入待套用" }).click();
  await p.page.waitForSelector(".s-pending", { timeout: 10000 });
  await p.page.getByRole("button", { name: lang === "en" ? "Apply changes" : "套用變更" }).click();
}
const overflow = (p: FreshPage) => p.page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth");

const results: any[] = [];
async function runCase(name: string, open: () => Promise<FreshPage>, target: "main" | "side", lang: string) {
  restore();
  const before = lists();
  const p = await open();
  await mounted(p.page, 30000);
  const navEnd = p.errors.length;
  const calls: string[] = [];
  p.page.on("response", (r: any) => { const u = new URL(r.url()); if (r.request().method() !== "GET" && u.pathname.startsWith("/api/settings")) { calls.push(`${r.request().method()} ${u.pathname} ${r.status()}`); if (r.status() >= 400) r.text().then((t: string) => calls.push(t.slice(0, 300)), () => {}); } });
  await toConnections(p);
  await addUser(p, target, lang);
  await p.page.waitForSelector(".pending-card.pending", { timeout: 10000 }).catch(() => {});
  await p.page.waitForTimeout(800);
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "1-held") });
  const gate = (fm as any).settingsGate();
  const held = [...gate.store.records.values()].filter((e: any) => e.view.state === "pending");
  const scope = held.map((e: any) => [...gate.store.affectedConnections(e.view.id)]);
  const summary = held.flatMap((e: any) => e.view.summary);
  for (const e of held) await gate.store.decide(e.view.id, "confirm", { label: "fleet admin (smoke)", current: () => true });
  const applied = await p.page.waitForSelector(".pending-card.applied", { timeout: 10000 }).then(() => true, () => false);
  await p.page.waitForTimeout(2500);                                                         // the apply after it
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "2-applied") });
  const after = lists();
  const text = await p.page.evaluate(() => document.body.innerText);
  const other = target === "main" ? "side" : "main";
  const errors = p.errors.filter((e, i) => { const t = e.replace(/ @ \S+$/, "");
    return !(ENGINE === "webkit" && (WEBKIT_OWN.has(t) || (i < navEnd && CANCEL.test(t)))); });
  const chk = {
    startedShared: JSON.stringify(before.main) === JSON.stringify(before.side) && /&admins/.test(before.text) && /\*admins/.test(before.text),
    heldForAdmin: calls.includes("PUT /api/settings/fleet/channels 202") && held.length === 1,
    scopeIsTarget: JSON.stringify(scope) === JSON.stringify([[target]]) && summary.join(" ").includes(target) && !summary.join(" ").includes(other),
    pageSaysApplied: applied,
    targetHasUser: after[target].map(String).includes(NEW),                               // the page sends a Telegram id as a number
    otherUnchanged: JSON.stringify(after[other]) === JSON.stringify(before[other]) && !after[other].map(String).includes(NEW),
    fileLoads: after.errors.length === 0,
    untouchedAnchorKept: /description: &words Indexes the demo docs/.test(after.text) && /description: \*words/.test(after.text),
    noRawError: !RAW.test(text),
    noOverflow: !(await overflow(p)),
    noErrors: errors.length === 0,
  };
  const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length, failed });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${ENGINE}-${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify({ calls, scope, summary, before: [before.main, before.side], after: [after.main, after.side], errors }).slice(0, 1600)}` : ""}`);
  await p.ctx.close();
}

await runCase("anchor-holder-desk-light-en", () => freshPage(fx, { device: "desk", theme: "light", lang: "en" }), "main", "en");
await runCase(ENGINE === "webkit" ? "alias-holder-phone-dark-zh-TW-reduced" : "alias-holder-phone-dark-zh-TW-lan-reduced",
  () => freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, { reducedMotion: true, ...(ENGINE === "webkit" ? {} : { origin: "lan" as const }) }), "side", "zh-TW");
{
  const link = await openPublicLink(fx);
  await runCase("public-link-anchor-holder-desk-light-en-reduced", () => link.publicPage({ device: "desk", theme: "light", lang: "en" }, { reducedMotion: true }), "main", "en");
  await link.close();
}
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : `PASS (${ENGINE})`);
await fx.close();
process.exit(bad.length ? 1 : 0);

/**
 * M-3734 real-app captures (owned web fixture; no Fleet/CLI starts, accounts, Hub or external services): an agent page's
 * "Who can use" — web guests from fleet.yaml's web.guests.grants (three made-up people, Discord), and the agent's Hub share.
 * The member's two Hub reads (pairing, exposures) are answered with fixture data shaped as the member API returns them
 * (as scripts/manual/hub-share-lapse-m3543 does); nothing else is stubbed. People seen in chat (Add a person) are the
 * fixture's guestPeople (the fixture has no chat history), as smoke-2348-guests-look does.
 * Cases: desk light en, desk dark zh-TW, phone light zh-TW, phone dark en. Frames per case:
 *  1-who      the section: Alice (Chat, signed in), Carol (Trusted, also uses beta); Hub: shared, with the Hub link
 *  2-add      Add a person open (Dan, Bob)
 *  3-remove   Remove Carol's question (nothing is written: Cancel)
 *  4-nohub    grants not saved yet (#1920's derived access: Start from today's guests) and no Hub
 *  5-hub      the Hub card on screen: shared, its button, and where the Hub page opens (not from outside the internal network)
 *  phone also 0-index: the agent page's category list, Who can use before Permissions
 * Checks: the rows and levels, the Hub link (the Hub's own address, grant=1, new tab) and its "only where the Hub can be
 * reached" note, every control in the section at least 44 px tall, no sideways scroll, no console error.
 *   CHROME=<chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/agent-who-can-use-m3734/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, labelOf, type MatrixCase } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [], measured: {} };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const shot = async (page: any, name: string, full = true) => {
  await page.waitForTimeout(400);
  const path = `m3734-${name}.png`;
  await page.screenshot({ path: join(OUT, path), fullPage: full });
  receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
};

const PEOPLE = {
  alice: { id: "101101101101101101", name: "Alice", user: "alice.k" },
  bob: { id: "202202202202202202", name: "Bob", user: "bobby" },
  carol: { id: "303303303303303303", name: "Carol", user: "carol_w" },
};
const GRANTS = `    grants:
      "demo:${PEOPLE.alice.id}": { name: Alice, instances: [alpha] }
      "demo:${PEOPLE.bob.id}": { name: Bob, instances: [beta] }
      "demo:${PEOPLE.carol.id}": { name: Carol, instances: [alpha, beta], level: trusted }`;
const fx = await bootFixture({ port: 0, host: true, classic: false, webYaml: `  guests:\n    enabled: true\n${GRANTS}`, roster: [
  { name: "general", backend: "claude-code", general: true, displayName: "General" },
  { name: "alpha", backend: "claude-code", displayName: "Example lead", description: "Synthetic demonstration agent" },
  { name: "beta", backend: "codex", displayName: "Example worker", description: "Synthetic demonstration agent" },
] });
const fm = fx.fm as any;
fm.worlds.set("demo", { adapter: { id: "demo", type: "discord", stop: async () => {} }, groupId: "G", accessManager: { getMode: () => "open", isAllowed: () => true }, stop: async () => {} });
fm.initializeWebSessions();
for (const p of Object.values(PEOPLE)) fm.webPrefs.setProfileName(`person:demo:${p.id}`, p.name);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
fm.guestPeople = () => ({ people: [
  { adapterId: "demo", userId: PEOPLE.bob.id, platform: "discord", username: PEOPLE.bob.user, name: "Bob", lastSeen: ago(90), instances: ["beta"] },
  { adapterId: "demo", userId: "404404404404404404", platform: "discord", username: "dan.r", name: "Dan", lastSeen: ago(35), instances: ["alpha"] },
] });
// The page's member mark reads the raw config (web-api.ts hubMarks), as the runtime does.
const hubMember = (on: boolean) => { fm.rawFleetConfig = { ...fm.rawFleetConfig, hub_member: { ...(fm.rawFleetConfig?.hub_member ?? {}), enabled: on } }; };
const savedGrants = structuredClone(fm.fleetConfig.web.guests.grants);
const PAIRING = { state: "paired", binding: "fixture-binding", link: "online",
  hub: { hubId: "11111111-2222-4333-8444-555555555555", name: "Example Hub", webOrigin: "https://hub.example.test", memberOrigin: "https://hub.example.test:8443", fingerprint: { digest: "ab".repeat(32) } } };
const EXPOSURE_ID = "aaaaaaaa-1111-4222-8333-444444444444";
const EXPOSURES = [{ agent: "alpha", display: "Example lead", exposureId: EXPOSURE_ID, revision: 2, state: "published", contactLimit: true, contactLimitNotice: false,
  policy: { dataView: "agent", tools: [] }, enforceable: true, pending: null }];

const MEASURE = `(() => {
  const root = document.querySelector(".ap-who"), W = innerWidth;
  if (!root) return null;
  const small = [...root.querySelectorAll("button, a.btn, summary, input")].filter((e) => e.getBoundingClientRect().width > 0)
    .map((e) => ({ t: (e.textContent || e.getAttribute("aria-label") || e.tagName).trim().slice(0, 30), h: Math.round(e.getBoundingClientRect().height), r: Math.round(e.getBoundingClientRect().right) }))
    .filter((x) => x.h < 44 || x.r > W + 0.5);
  const rows = [...root.querySelectorAll(".ap-who-guests .ap-who-list:not(.ap-who-pick) .ap-who-row")].map((r) => ({
    name: r.querySelector("strong")?.textContent, pressed: [...r.querySelectorAll("[aria-pressed=true]")].map((b) => b.dataset.level), text: r.innerText }));
  const link = root.querySelector("#whoHubChoose");
  const nav = [...document.querySelectorAll(".s-nav .seg-item")].map((a) => (a.getAttribute("href") || "").split("cat=")[1] || "");
  return { W, scroll: document.documentElement.scrollWidth, small, rows, hub: document.querySelector("#who-hub")?.dataset.hubState,
    href: link?.getAttribute("href") || null, target: link?.getAttribute("target") || null, text: root.innerText, nav };
})()`;

const CASES: MatrixCase[] = [
  { device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" },
  { device: "phone", theme: "light", lang: "zh-TW" }, { device: "phone", theme: "dark", lang: "en" },
];
const L = {
  where: { en: "That page opens only on the internal network: it won't open outside the internal network (for example, at home).", zh: "這個頁面只在內部網路內打得開，在內部網路以外（例如在家）打不開。" },
  button: { en: "Choose who may ask on the Hub", zh: "到 Hub 選擇誰可以問" },
  scope: { en: "Only affects Example lead", zh: "只影響 Example lead" },
  levelAll: { en: "Carol's level (Chat or Trusted) applies to all 2 agents they can use, not only this one.", zh: "Carol 的等級（聊天或信任）套用到他們能用的全部 2 個 Agent，不只這一個。" },
  also: { en: "Can also use: beta", zh: "也可以用：beta" },
  remove: { en: "Remove", zh: "移除" },
  question: { en: "Carol will no longer be able to use Example lead (alpha).", zh: "Carol 將無法再使用 Example lead（alpha）。" },
  derived: { en: "Start from today's guests", zh: "從現有訪客開始" },
  noHub: { en: "This Fleet isn't connected to a Hub.", zh: "這個 Fleet 沒有連接 Hub。" },
  add: { en: "Add a person", zh: "新增人員" },
};
try {
  for (const c of CASES) {
    const tag = caseName(c);
    const errors: string[] = [];
    // The always-mounted Overview asks for this agent's board work; the fixture runs no task board, so that read answers
    // 503 on every agent page (before this change too) — named here and left out. Any other failed read counts.
    const watch = (page: any) => {
      page.on("console", (m: any) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
      page.on("response", (r: any) => { if (r.status() >= 400 && !/\/ui\/tasks\/work\?/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
    };
    fm.fleetConfig.web.guests.grants = structuredClone(savedGrants);
    hubMember(true);
    let { ctx, page } = await fx.page(c, { host: true });
    try {
      watch(page);
      await ctx.route("**/api/hub/member/pairing**", (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pairing: PAIRING }) }));
      await ctx.route("**/api/hub/member/exposures", (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ exposures: EXPOSURES }) }));
      if (c.device === "phone") {
        await page.goto(`${fx.base}/ui/fleet/agent/alpha`);
        await page.locator(".s-nav").waitFor({ timeout: 20000 });
        const m0 = await page.evaluate(MEASURE.replace('if (!root) return null;', 'if (!root) return { nav: [...document.querySelectorAll(".s-nav .seg-item")].map((a) => (a.getAttribute("href") || "").split("cat=")[1] || "") };'));
        check(`${tag}: the category list has Who can use just before Permissions`, JSON.stringify(m0.nav.slice(-2)) === JSON.stringify(["access", "permissions"]), m0.nav);
        await shot(page, `${tag}-0-index`, false);
      }
      await page.goto(`${fx.base}/ui/fleet/agent/alpha?cat=access`);
      await page.locator(".ap-who-guests .ap-who-row").first().waitFor({ timeout: 20000 });
      await page.locator("#whoHubChoose").waitFor({ timeout: 15000 });
      let m = await page.evaluate(MEASURE);
      receipt.measured[`${tag}-who`] = m;
      check(`${tag}: lists the two people whose grant names this agent (not Bob)`, JSON.stringify(m.rows.map((r: any) => r.name)) === JSON.stringify(["Alice", "Carol"]) || JSON.stringify(m.rows.map((r: any) => r.name)) === JSON.stringify(["Carol", "Alice"]), m.rows.map((r: any) => r.name));
      const carol = m.rows.find((r: any) => r.name === "Carol");
      check(`${tag}: Carol is Trusted and also uses beta`, !!carol && carol.pressed[0] === "trusted" && carol.text.includes(labelOf(c, L.also)), carol);
      check(`${tag}: Hub: shared, with the Hub page that chooses who may ask (grant=1, new tab)`, m.hub === "shared" && m.href === `https://hub.example.test/ui/hub/exposures?agent=${EXPOSURE_ID}&grant=1` && m.target === "_blank", [m.hub, m.href, m.target]);
      check(`${tag}: says the Hub page only opens on the internal network, not from outside (e.g. at home)`, m.text.includes(labelOf(c, L.where)), m.text);
      check(`${tag}: Carol's row says her level covers both her agents`, !!carol && carol.text.includes(labelOf(c, L.levelAll)), carol?.text);
      const page_text = await page.evaluate(`document.querySelector(".agent-settings-heading")?.innerText || ""`);
      // The phone's heading has no scope line (the page names the agent above it).
      if (c.device === "desk") check(`${tag}: the scope says the agent's display name`, String(page_text).includes(labelOf(c, L.scope)), page_text);
      check(`${tag}: every control at least 44 px tall and on screen`, m.small.length === 0, m.small);
      check(`${tag}: no sideways scroll`, m.scroll <= m.W, m.scroll);
      await shot(page, `${tag}-1-who`);
      await page.locator("#who-hub").scrollIntoViewIfNeeded();
      const btn = (await page.locator("#whoHubChoose").innerText()).trim();
      check(`${tag}: the Hub button is named, on screen`, btn.startsWith(labelOf(c, L.button)) && await page.locator("#whoHubChoose").isVisible(), btn);
      await shot(page, `${tag}-5-hub`, false);

      await page.locator(".ap-who-add > summary").click();
      await page.locator(".ap-who-pick .ap-who-row").first().waitFor({ timeout: 10000 });
      await page.locator(".ap-who-add").scrollIntoViewIfNeeded();
      m = await page.evaluate(MEASURE);
      const picks = await page.locator(".ap-who-pick .ap-who-row strong").allTextContents();
      check(`${tag}: Add a person offers those not listed yet (Bob, Dan)`, JSON.stringify(picks) === JSON.stringify(["Bob", "Dan"]), picks);
      check(`${tag}: (add) every control at least 44 px tall and on screen`, m.small.length === 0, m.small);
      check(`${tag}: (add) no sideways scroll`, m.scroll <= m.W, m.scroll);
      await shot(page, `${tag}-2-add`);

      const writes: string[] = [];
      page.on("request", (r: any) => { if (r.method() === "PUT") writes.push(r.url()); });
      await page.locator('.ap-who-row[data-account="demo:303303303303303303"]').getByRole("button", { name: labelOf(c, L.remove), exact: true }).click();
      const dialog = page.locator("dialog.dlg[open]");
      await dialog.waitFor({ timeout: 5000 });
      const said = await dialog.innerText();
      check(`${tag}: Remove asks first, naming the person and the agent`, said.includes(labelOf(c, L.question)), said);
      await shot(page, `${tag}-3-remove`, false);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      check(`${tag}: Cancel writes nothing`, writes.length === 0, writes);
      await ctx.close();

      // No grants saved yet, and no Hub.
      delete fm.fleetConfig.web.guests.grants;
      hubMember(false);
      ({ ctx, page } = await fx.page(c, { host: true }));
      watch(page);
      await page.goto(`${fx.base}/ui/fleet/agent/alpha?cat=access`);
      await page.locator("#whoConvert").waitFor({ timeout: 20000 });
      await page.locator("#who-hub[data-hub-state=none]").waitFor({ timeout: 10000 });
      m = await page.evaluate(MEASURE);
      receipt.measured[`${tag}-nohub`] = m;
      const controls = await page.evaluate(`[!!document.querySelector(".ap-who-add"), !!document.querySelector(".ap-who-guests .btn-danger")]`);
      check(`${tag}: before grants: Start from today's guests, no Remove or Add`, m.text.includes(labelOf(c, L.derived)) && JSON.stringify(controls) === "[false,false]", controls);
      check(`${tag}: no Hub: said plainly, no Hub link`, m.hub === "none" && !m.href && m.text.includes(labelOf(c, L.noHub)), [m.hub, m.href]);
      check(`${tag}: (no Hub) every control at least 44 px tall and on screen`, m.small.length === 0, m.small);
      check(`${tag}: (no Hub) no sideways scroll`, m.scroll <= m.W, m.scroll);
      await shot(page, `${tag}-4-nohub`);
      check(`${tag}: no console error, no failed read (but the fixture's task board)`, errors.length === 0, errors);
    } finally { await ctx.close(); }
  }
} finally {
  clearInterval(fm.replyObligationTimer);
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}

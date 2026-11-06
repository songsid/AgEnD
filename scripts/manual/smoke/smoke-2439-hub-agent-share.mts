// M-2439 (docs/design/hub-representative-agent.md): Settings → Access & security → Connect to a Hub on a member fleet —
// P1 shares the agent itself. The member endpoints are answered in the page (route mocks shaped like the new host:
// choices = the one "agent" entry, no tools; a legacy row says republish_required), so the real member client and
// card run. Desk and phone, light and dark, en and zh-TW. Judged: switching on POSTs exactly
// { agent, dataViewId: "agent", tools: [], expectedRevision } with no picker; a shared row says where questions go; a
// legacy row explains itself and Share again POSTs at its revision; no overflow, no page errors.
// SKEW (SKEW=<dir> with the previous release's files):
//   - the new card with a retained old hub-strings.js: the new words still render (hub-agent-copy.js owns them);
//   - an old shell (app.js, app-shell.js, app-stream.js, app.css, instance-nav.js, app-i18n.js) + the new card;
//   - the old card (settings-hub.js, hub-client.js, hub-strings.js) against the new host's rows: its picker cannot
//     publish (it needs a tool, the host offers none), so nothing is POSTed; no page errors.
//   PW_DIR=… REPO=<checkout> OUT=<dir> SKEW=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2439-hub-agent-share.mts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, mounted, shotPath, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2439-hub-agent-share";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48973), classic: false, instances: 3 });
const [a, b] = [fx.instances[0]!.name as string, fx.instances[1]!.name as string];
const results: any[] = [];
let failed = 0;
const record = (name: string, c: Record<string, boolean>, extra: Record<string, unknown> = {}) => {
  const bad = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) failed++;
  results.push({ name, ok: !bad.length, checks: c, ...extra });
  console.log(`${bad.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""} ${JSON.stringify(extra).slice(0, 300)}`);
};
const PAIRED = { state: "paired", hub: { hubId: "00000000-0000-4000-8000-000000000001", name: "Team Hub", memberOrigin: "https://hub.example.test",
  webOrigin: "https://hub.example.test", fingerprint: { kind: "hub-key", digest: "ab".repeat(32) } }, link: "online" };
const AGENT_CHOICES = (label: string) => ({ dataViews: [{ id: "agent", label }], tools: [] });

async function open(c: MatrixCase, routes: Array<[string, string, string]> = []) {
  const { ctx, page } = await fx.page(c, { path: "/ui" });
  const errors: string[] = [], posts: any[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e)));
  page.on("console", (m: any) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  // The new host's member endpoints, in the page: agent A private, agent B a legacy (container) mapping.
  const rows: any[] = [
    { agent: a, display: a, exposureId: null, revision: 0, state: "withdrawn", policy: null, enforceable: true, choices: AGENT_CHOICES(a), pending: null },
    { agent: b, display: b, exposureId: "11111111-2222-4333-8444-555555555555", revision: 3, state: "published", policy: { dataView: "notes", tools: ["documents.read"] },
      enforceable: false, reason: "republish_required", choices: AGENT_CHOICES(b), pending: null },
  ];
  await page.route("**/api/hub/member/**", async (r: any) => {
    const req = r.request(), url = new URL(req.url()), method = req.method();
    const json = (body: unknown, status = 200) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/hub/member/pairing") return json({ ok: true, pairing: PAIRED });
    if (url.pathname === "/api/hub/member/exposures" && method === "GET") return json({ ok: true, exposures: rows });
    if (url.pathname === "/api/hub/member/exposures" && method === "POST") {
      const body = JSON.parse(req.postData() || "{}"); posts.push(body);
      const row = rows.find((x) => x.agent === body.agent);
      if (!row || body.expectedRevision !== row.revision || body.dataViewId !== "agent" || body.tools.length) return json({ ok: false, error: "conflict" }, 409);
      Object.assign(row, { exposureId: row.exposureId ?? "22222222-2222-4333-8444-555555555555", revision: row.revision + 1, state: "published",
        policy: { dataView: "agent", tools: [] }, enforceable: true }); delete row.reason;
      return json({ ok: true, view: row });
    }
    return json({ ok: false, error: "unavailable" }, 404);
  });
  await page.route("**/settings/access", async (r: any) => { const res = await r.fetch(); const body = (await res.text()).replace(/<body([^>]*)>/, '<body$1 data-hub="member">'); await r.fulfill({ response: res, body }); });
  for (const [glob, body, type] of routes) await page.route(glob, (r: any) => r.fulfill({ status: 200, contentType: type, body }));
  await page.goto(`${fx.base}/settings/access`);
  if (!(await mounted(page, 30000))) throw new Error("the app did not mount");
  await page.waitForSelector(".hub-exposure input", { timeout: 20000 });
  return { ctx, page, errors, posts };
}
const shareFirst = async (page: any) => { const box = page.locator(".hub-exposure input").first(); await box.check({ force: true }).catch(() => box.click()); };
const noOverflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-dark-zh-TW,phone-light-en")) {
  const zh = c.lang === "zh-TW";
  const { ctx, page, errors, posts } = await open(c);
  const lead = await page.locator(".hub-exposures > .note").first().textContent();
  const legacyWhy = await page.locator(".hub-exposure-republish").textContent().catch(() => "");
  await page.locator(".hub-exposure-republish").scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: shotPath(SMOKE, c, "list") });
  await shareFirst(page);
  await page.waitForFunction(() => document.querySelectorAll(".hub-exposure.is-shared").length === 2, null, { timeout: 5000 }).catch(() => {});
  const sharedWhy = await page.locator(".hub-exposure.is-shared .hub-exposure-why").first().textContent().catch(() => "");
  const firstPost = posts[0];
  await page.locator(".hub-exposure-republish button").click();
  await page.waitForFunction(() => !document.querySelector(".hub-exposure-republish"), null, { timeout: 5000 }).catch(() => {});
  await page.screenshot({ path: shotPath(SMOKE, c, "shared") });
  record(`${caseName(c)} share the agent; legacy Share again`, {
    "the lead says what sharing means": zh ? /自己的對話/.test(lead || "") : /answers Hub questions in its own conversation/.test(lead || ""),
    "no picker": (await page.locator(".hub-exposure-pick").count()) === 0,
    "switch on POSTs the agent tuple": JSON.stringify(firstPost) === JSON.stringify({ agent: a, dataViewId: "agent", tools: [], expectedRevision: 0 }),
    "a shared row says where questions go": zh ? /自己的對話/.test(sharedWhy || "") : /own conversation/.test(sharedWhy || ""),
    "the legacy row explains itself": zh ? /重新公開這個 Agent 之前/.test(legacyWhy || "") : /refused until you share this agent again/.test(legacyWhy || ""),
    "Share again POSTs at its revision": JSON.stringify(posts[1]) === JSON.stringify({ agent: b, dataViewId: "agent", tools: [], expectedRevision: 3 }),
    "no raw string keys": !/hub\.(agent|republish|shareAgain)/.test(await page.locator("#hub-connect").textContent() || ""),
    "no horizontal overflow": await noOverflow(page),
    "no page errors": errors.length === 0,
  }, { posts, errors: errors.slice(0, 3) });
  await ctx.close();
}
const S = process.env.SKEW;
if (S && existsSync(S)) {
  const c = matrix("desk-light-en")[0]!, file = (f: string) => readFileSync(join(S, f), "utf8");
  const js = (dir: string, fs: string[]) => fs.map((f) => [`**/${dir}/${f}*`, file(f), f.endsWith(".css") ? "text/css" : "text/javascript"] as [string, string, string]);
  {
    const { ctx, page, errors, posts } = await open(c, js("ui/js", ["hub-strings.js"]));
    const text = await page.locator("#hub-connect").textContent() || "";
    await shareFirst(page);
    await page.waitForFunction(() => document.querySelectorAll(".hub-exposure.is-shared").length === 2, null, { timeout: 5000 }).catch(() => {});
    await page.screenshot({ path: shotPath(SMOKE, c, "skew-old-strings") });
    record("SKEW retained old hub-strings + new card", { "the new words render": /answers Hub questions/.test(text) && /Share again/.test(text),
      "no raw string keys": !/hub\.(agent|republish|shareAgain)/.test(text), "Share works": posts.length === 1, "no page errors": errors.length === 0 }, { errors: errors.slice(0, 3) });
    await ctx.close();
  }
  {
    const { ctx, page, errors, posts } = await open(c, js("assets", ["app.js", "app-shell.js", "app-stream.js", "app.css", "instance-nav.js", "app-i18n.js"]));
    await shareFirst(page);
    await page.waitForFunction(() => document.querySelectorAll(".hub-exposure.is-shared").length === 2, null, { timeout: 5000 }).catch(() => {});
    await page.screenshot({ path: shotPath(SMOKE, c, "skew-old-shell") });
    record("SKEW old shell + new card", { "Share works": posts.length === 1 && posts[0].dataViewId === "agent", "no page errors": errors.length === 0 }, { errors: errors.slice(0, 3) });
    await ctx.close();
  }
  {
    const { ctx, page, errors, posts } = await open(c, js("ui/js", ["settings-hub.js", "hub-client.js", "hub-strings.js"]));
    await shareFirst(page);
    await page.waitForSelector(".hub-exposure-pick", { timeout: 5000 }).catch(() => {});
    await page.locator(".hub-exposure-pick").scrollIntoViewIfNeeded().catch(() => {});
    const picker = await page.locator(".hub-exposure-pick").count();
    const shareDisabled = await page.locator(".hub-exposure-pick .btn-primary").isDisabled().catch(() => false);
    await page.locator(".hub-exposure-pick .btn-primary").click({ force: true, timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: shotPath(SMOKE, c, "skew-old-card") });
    record("SKEW old card + new host rows", { "the old picker opens": picker === 1, "its Share is disabled (no tool offered)": shareDisabled,
      "nothing POSTed": posts.length === 0, "the legacy row's switch can still withdraw": !(await page.locator(".hub-exposure input").nth(1).isDisabled()),
      "no page errors": errors.length === 0 }, { errors: errors.slice(0, 3) });
    await ctx.close();
  }
}
const out = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE); mkdirSync(out, { recursive: true });
writeFileSync(join(out, "result.json"), JSON.stringify({ failed, results }, null, 2));
await fx.close();
process.exit(failed ? 1 : 0);

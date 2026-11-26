/**
 * M-3814 real-app captures (owned web fixture; no Fleet/CLI starts, no tunnel, no Cloudflare, no network):
 *   1 the 429 notice: an agent's HTML card whose preview failed on Cloudflare's limit on temporary links — why, that
 *     Download still opens it, and the blue link "Set up a fixed preview address" · 2 the link pressed: Settings →
 *     Access → Sharing, at the fixed address, with the preview address and its one Cloudflare route step below it ·
 *     3 the address typed and saved through the real Settings form · 4 Check, every step ✓.
 * What is stubbed, at the server's decision points only: (1) this page's preview answer is the public link's
 * "failed: rate-limited" (fm.previewForUi), as a fixed link's page gets it — no real link is opened; (4) the check's
 * network (DNS and the fetch of https://<address>/frame) answers with this fixture's own preview listener boot id, and
 * the fixed link counts as open. The page, the routes, the Settings form and the check's own logic are the real ones.
 * Desk light en and phone dark zh-TW.
 *   CHROME=<chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/preview-fixed-host-m3814/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, mounted } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const shot = async (page: any, name: string) => {
  await page.waitForTimeout(400);
  const path = `m3814-${name}.png`;
  await page.screenshot({ path: join(OUT, path) });
  receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
};

const HOST = "agend.example.net", PREVIEW = "preview.agend.example.net";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48614), classic: false, host: true,
  webYaml: `  public_link:\n    hostname: ${HOST}\n    tunnel_token_env: AGEND_CLOUDFLARE_TUNNEL_TOKEN`,
  roster: [
    { name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" },
    { name: "dev", backend: "claude-code", displayName: "Example helper", status: "running" },
  ] });
const fm = fx.fm;
// (1) This page's preview answer: the public link's preview failed on Cloudflare's 429.
const realPreviewForUi = fm.previewForUi.bind(fm);
fm.previewForUi = (host: string | undefined, secure: boolean) => ({ ...realPreviewForUi(host, secure), previewOrigin: null, boot: null,
  code: "publicLinkPreviewFailed", detail: "rate-limited", reason: "Previews are unavailable on this public link (rate-limited)." });
// (4) The check's network only: the address resolves, and /frame answers with this fixture's preview boot id.
const { runPreviewRouteTest } = await import(REPO + "/src/tunnel/named-link-test.ts");
const { publicLinkPreviewHostname } = await import(REPO + "/src/public-web-link.ts");
const asked: string[] = [];
fm.testPreviewRoute = async () => {
  const listener = fm.previewListener;
  return runPreviewRouteTest({ hostname: publicLinkPreviewHostname(fm.fleetConfig?.web), linkOpen: true, bootId: listener.bootId, port: listener.settings.port },
    { resolve4: async () => ["104.16.0.1"], fetchPage: async (u: string) => { asked.push(u); return { status: 200, body: `var BOOT = ${JSON.stringify(listener.bootId)}` }; }, reachMs: 2000, retryMs: 10 });
};
fm.emitSseEvent("message", { instance: "dev", sender: "dev", role: "agent", text: "The status page:\n\n```html\n<!doctype html><title>Status</title><h1>All green</h1>\n```", ts: new Date().toISOString() });

const W = (zh: boolean, en: string, zhText: string) => (zh ? zhText : en);
const scroll = async (page: any) => page.evaluate(`({ w: innerWidth, s: document.documentElement.scrollWidth })`);
const waitFor = async (page: any, expr: string, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await page.evaluate(expr)) return true; await page.waitForTimeout(100); } return false; };
const inView = async (page: any, sel: string) => page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height > 0; })()`);

let saved = false;
async function walk(c: any) {
  const tag = caseName(c), zh = c.lang === "zh-TW", phone = c.device === "phone";
  const { page, ctx, csp } = await fx.page(c, { path: "/ui/chat/dev", prefs: { "preview.optIn": true } as any });
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  const checks: Array<number | string> = []; page.on("request", (r: any) => { if (r.url().endsWith("/api/settings/public-link/preview-test")) checks.push("sent"); });
  page.on("response", (r: any) => { if (r.url().endsWith("/api/settings/public-link/preview-test")) checks.push(r.status()); });
  page.on("console", (m: any) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200)); });
  try {
    // 1 the notice
    await page.waitForSelector(".msg.agent .html-card .pv-note", { timeout: 20000 });
    await page.evaluate(`document.querySelector(".msg.agent .html-card").scrollIntoView({ block: "center" })`);
    const card = await page.evaluate(`(() => { const c = document.querySelector(".msg.agent .html-card"); const n = c.querySelector(".pv-note"), a = n.querySelector("a.pv-fix");
      return { note: n.innerText, link: a && a.innerText, href: a && a.getAttribute("href"), dl: !!c.querySelector(".pv-dl") && !c.querySelector(".pv-dl").hidden,
        run: !c.querySelector(".pv-run").hidden, color: a && getComputedStyle(a).color, noteColor: getComputedStyle(n).color, underline: a && getComputedStyle(a).textDecorationLine,
        accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() }; })()`) as any;
    check(`${tag} 1: the notice says Cloudflare limits temporary links, and to download the file`,
      card.note.includes(W(zh, "Cloudflare is limiting new temporary links from this machine — try again in a while, or download the file to open it", "Cloudflare 正在限制這台機器建立新的臨時連結 — 請過一陣子再試，或下載檔案來開啟")), card.note);
    check(`${tag} 1: the link "${W(zh, "Set up a fixed preview address", "設定固定的預覽網址")}" → Settings → Access at the fixed address`,
      card.link === W(zh, "Set up a fixed preview address", "設定固定的預覽網址") && card.href === "/settings/access#publicWebHostname", card);
    check(`${tag} 1: the link is the accent colour (blue), underlined, unlike the note`, card.color !== card.noteColor && card.underline === "underline", card);
    check(`${tag} 1: Download is offered; Preview is not`, card.dl && !card.run, card);
    const sc1 = await scroll(page); check(`${tag} 1: no sideways scroll`, sc1.s <= sc1.w, sc1);
    await shot(page, `${tag}-1-notice`);

    // 2 the link pressed: Settings → Access, at the fixed address
    await page.locator(".msg.agent .html-card a.pv-fix").click();
    await waitFor(page, `location.pathname === "/settings/access" && !!document.querySelector("#publicWebHostname")`, 20000);
    await page.waitForTimeout(1200);
    const at = await page.evaluate(`({ path: location.pathname + location.hash, tab: (document.querySelector("[data-settings-tab=sharing]") || {}).hidden === false,
      host: (document.querySelector("#publicWebHostname") || {}).value, preview: !!document.querySelector("#publicWebPreviewHostname"),
      steps: [...document.querySelectorAll(".fixed-preview-steps li")].map((l) => l.textContent.trim()) })`) as any;
    check(`${tag} 2: landed on Settings → Access → Sharing (the fixed address's tab)`, at.path === "/settings/access#publicWebHostname" && at.tab, at);
    check(`${tag} 2: the fixed hostname is in view`, await inView(page, "#publicWebHostname") === true, await inView(page, "#publicWebHostname"));
    check(`${tag} 2: the preview address field is right below it, with the route step and this fleet's preview port`,
      at.preview && at.steps.length === 5 && at.steps[2].includes(`http://127.0.0.1:${fx.previewPort}`), at);
    if (!saved) check(`${tag} 2: nothing saved yet → the steps are open`, await page.evaluate(`document.querySelector(".fixed-preview-steps").open`) === true, null);
    const sc2 = await scroll(page); check(`${tag} 2: no sideways scroll`, sc2.s <= sc2.w, sc2);
    await shot(page, `${tag}-2-settings-landed`);
    await page.evaluate(`document.querySelector("#publicPreviewAddress").scrollIntoView({ block: "start" })`);
    await shot(page, `${tag}-2b-route-step`);

    // 3 type and save (first case only; the second sees it saved)
    if (!saved) {
      await page.locator("#publicWebPreviewHostname").fill(PREVIEW);
      await page.waitForTimeout(400);
      await page.click("[role=region] button.btn-primary");
      await page.waitForTimeout(800);
      for (let i = 0; i < 3; i++) {
        const confirm = page.locator("dialog[open] button.btn-primary");
        if (await confirm.count()) { await confirm.first().click(); await page.waitForTimeout(800); } else break;
      }
      saved = await waitFor(page, `!document.querySelector("[role=region] button.btn-primary")`, 15000) && publicLinkPreviewHostname(fm.fleetConfig?.web) === PREVIEW;
      check(`${tag} 3: saved through the form: web.public_link.preview_hostname = ${PREVIEW}`, saved, fm.fleetConfig?.web?.public_link);
      const yaml = readFileSync(join(fx.dir, "fleet.yaml"), "utf8");
      check(`${tag} 3: fleet.yaml has it`, yaml.includes(`preview_hostname: ${PREVIEW}`), yaml.slice(0, 600));
      await page.evaluate(`document.querySelector("#publicPreviewAddress").scrollIntoView({ block: "start" })`);
      await shot(page, `${tag}-3-saved`);
    } else {
      check(`${tag} 3: the saved address is shown`, await page.evaluate(`document.querySelector("#publicWebPreviewHostname").value`) === PREVIEW, null);
    }

    // 4 Check
    await page.evaluate(`document.querySelector("#previewAddressCheck").scrollIntoView({ block: "center" })`);
    await page.waitForTimeout(300);
    const hit = await page.evaluate(`(() => { const b = document.querySelector("#previewAddressCheck").getBoundingClientRect(); const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!e && !!e.closest("#previewAddressCheck"); })()`);
    check(`${tag} 4: Check is on screen, nothing over it`, hit === true, hit);
    await page.click("#previewAddressCheck");
    await waitFor(page, `document.querySelectorAll(".fixed-preview .named-test-steps li").length === 4`, 15000);
    await page.waitForTimeout(300);
    const rows = await page.evaluate(`[...document.querySelectorAll(".fixed-preview .named-test-steps li")].map((l) => l.innerText.trim())`) as string[];
    check(`${tag} 4: every step ✓, the last says it works`, rows.length === 4 && rows.every((r) => r.startsWith("✓"))
      && rows[3].includes(W(zh, `It works: previews over the fixed address use ${PREVIEW}.`, `正常：透過固定網址的預覽會使用 ${PREVIEW}。`)),
      { rows, block: await page.evaluate(`(document.querySelector(".fixed-preview") || {}).innerText`), disabled: await page.evaluate(`document.querySelector("#previewAddressCheck").disabled`), checks, dialog: await page.evaluate(`(document.querySelector("dialog[open]") || {}).innerText || null`), url: page.url() });
    check(`${tag} 4: it asked https://${PREVIEW}/frame`, asked.at(-1) === `https://${PREVIEW}/frame`, asked);
    if (phone) {
      const b = await page.evaluate(`Math.round(document.querySelector("#previewAddressCheck").getBoundingClientRect().height)`);
      check(`${tag} 4: Check is at least 32 px tall`, b >= 32, b);
    }
    await page.evaluate(`document.querySelector("#previewAddressCheck").scrollIntoView({ block: "start" })`);
    await shot(page, `${tag}-4-check`);
    const sc4 = await scroll(page); check(`${tag} 4: no sideways scroll`, sc4.s <= sc4.w, sc4);
    check(`${tag}: no page errors`, errors.length === 0, errors);
    check(`${tag}: no CSP violations`, (await csp()).length === 0, await csp());
  } finally { await ctx.close(); }
}

try {
  for (const c of matrix("desk-light-en,phone-dark-zh-TW")) await walk(c);
} finally {
  receipt.passed = receipt.checks.filter((c: any) => c.ok).length; receipt.total = receipt.checks.length;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(`${receipt.passed}/${receipt.total}`);
  await fx.close();
}

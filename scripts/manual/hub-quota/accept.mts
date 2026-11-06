/**
 * G's B/C component-contract acceptance, before the B chat shell is available. Real Hub HTTP/auth and production
 * quota components in a small host using A's shared rail and composer; this is NOT B's end-to-end chat shell.
 * Before PNGs use an old room DTO (quota absent); after PNGs use the current exhausted DTO. No fleet, tmux or CLI.
 * PW_DIR=$PWD/.artifacts/quota-browser PLAYWRIGHT_BROWSERS_PATH=$PWD/.artifacts/quota-browser/browsers \
 *   npx tsx scripts/manual/hub-quota/accept.mts
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { hubCookieName } from "../../../src/hub/sessions.js";

const origin = "https://quota.example.test";
const out = resolve(process.env.OUT ?? "docs/screenshots/hub-quota-g"); mkdirSync(out, { recursive: true });
const pw = await import(pathToFileURL(resolve(process.env.PW_DIR!, "node_modules/playwright-core/index.mjs")).href);
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
let now = Date.parse("2026-11-06T10:00:00Z");
const r = await s3bRig({ now: () => now, webOrigin: origin });
const owner = r.addPerson("owner", "Olivia"), asker = r.addPerson("asker", "Alex"); void asker;
const link = r.link(randomUUID(), owner), exposureId = randomUUID();
(link.features as Set<string>).add("welcome-caps-v1"); (link.features as Set<string>).add("quota-band-v1");
const exposure = { id: exposureId, fleetId: link.fleetId, owner, displayName: "Atlas", revision: 1, state: "published",
  dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link);
const o = await r.signIn("owner"), a = await r.signIn("asker");
const grant = (await r.call(o, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "asker", days: 7 })).json.grant;
const room = (await r.call(a, "POST", "/hub/v1/rooms", { exposureId, grantId: grant.id })).json.room;
const update = async (band: string) => {
  now += 30_000;
  await r.http.receive(r.frame("exposure.quota", { exposureId, quota: { band, ...(band === "exhausted" ? { resetsAt: Date.parse("2026-11-06T12:15:00Z") } : {}) } }, link) as never, link);
};

const fixtureJs = `
import { html, render } from "/assets/app-html.js";
import { setLang } from "/assets/app-i18n.js";
import { RailFrame } from "/assets/side-rail.js";
import { ComposerInput } from "/assets/chat-composer.js";
import { hubClient } from "/ui/js/hub-client.js";
import { QuotaCard, QuotaChip, QuotaBanner, QuotaVisibilityRow } from "/ui/js/hub-quota.js";
const args = new URL(location.href).searchParams, zh = args.get("lang") === "zh-TW", owner = args.get("owner") === "1";
setLang(zh ? "zh-TW" : "en", { store: false });
document.body.dataset.hub = "hub";
const c = hubClient(); await c.session();
window.refreshQuota = async function(before = false) {
  const dto = owner ? await c.catalog() : await c.read(${JSON.stringify(room.id)});
  const exposure = owner ? dto.mine[0] : null;
  const room = before ? {} : owner ? exposure : dto.room;
  render(html\`<div class="accept-label">Hub quota · B/C component contract fixture</div>
    <div class="accept-layout"><main class="accept-chat p-chat">
      <header class="accept-header"><strong>Atlas</strong><span class="grow"></span><\${QuotaChip} room=\${room} /></header>
      <div class="accept-thread"><\${QuotaBanner} room=\${room} />
        <div class="msg"><div class="meta">Alex · 10:00</div><div class="body">\${zh ? "可以幫我整理本週重點嗎？" : "Could you summarise this week's priorities?"}</div></div>
      </div>
      <div class="accept-composer"><\${ComposerInput} value="" onValue=\${() => {}} placeholder=\${zh ? "輸入問題…" : "Ask a question…"}
        stop=\${{ hidden: true }} send=\${{ hidden: false, disabled: false, label: zh ? "傳送" : "Send", onClick: () => {} }} /></div>
      \${owner ? html\`<div class="p-settings accept-owner"><\${QuotaVisibilityRow} exposure=\${exposure} onSaved=\${() => window.refreshQuota()} /></div>\` : null}
    </main><\${RailFrame} label="Context" title=\${zh ? "對話資訊" : "Conversation context"} closeLabel="Close" onClose=\${() => {}}>
      <section class="u-provider"><div class="u-head"><strong>Atlas</strong></div><div class="u-sub">\${zh ? "代表 Olivia" : "Represents Olivia"}</div></section>
        <\${QuotaCard} room=\${room} />
        <section class="u-provider"><div class="u-head"><strong>\${zh ? "來源" : "Source"}</strong></div><div class="u-sub">Olivia's fleet</div></section>
        <section class="u-provider"><div class="u-head"><strong>\${zh ? "可見範圍" : "Who can see this"}</strong></div><div class="u-sub">\${zh ? "這個房間只有你能閱讀；Agent 端的對話由所有提問者共用。" : "Only you can read this room. The agent's conversation is shared with everyone who asks it."}</div></section>
      </\${RailFrame}></div>\`, document.querySelector("#fixture"));
};
await window.refreshQuota(args.get("before") === "1");
window.quotaReady = true;
`;
const css = `
body{margin:0;padding:24px;background:var(--bg);color:var(--text);font-family:var(--font-ui)}
.accept-label{font-size:12px;color:var(--text-3);margin-bottom:16px}.accept-layout{display:flex;min-height:620px;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--surface)}
.accept-chat{display:flex;flex:1;min-width:0;flex-direction:column}.accept-header{display:flex;align-items:center;gap:16px;min-height:64px;padding:16px 24px;border-bottom:1px solid var(--border)}
.accept-thread{flex:1;padding:24px;display:flex;flex-direction:column;gap:20px}.accept-thread .msg{max-width:100%;align-self:stretch}.accept-thread .meta{font-size:12px;color:var(--text-3);margin-bottom:8px}
.accept-composer{border-top:1px solid var(--border);padding:20px}.accept-composer .composer{width:100%}
.accept-owner{padding:24px;border-top:1px solid var(--border)}.accept-layout > .u-rail{display:flex;padding-top:8px}
@media(max-width:700px){body{padding:12px}.accept-layout{flex-direction:column;min-height:780px}.accept-header{padding:16px;flex-wrap:wrap}.accept-thread{padding:16px;min-height:140px}.accept-composer{padding:16px}.accept-layout > .u-rail{display:flex;width:100%;border-left:0;border-top:1px solid var(--border)}.accept-owner{padding:16px}}
`;
const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/tokens.css"><link rel="stylesheet" href="/assets/app.css"><link rel="stylesheet" href="/fixture.css"></head><body><div id="fixture"></div><script type="module" src="/fixture.js"></script></body></html>';
const results: unknown[] = [];
async function context(viewport: { width: number; height: number }, cookie: string) {
  const c = await browser.newContext({ viewport, timezoneId: "UTC", locale: "en-US" });
  const value = cookie.slice(cookie.indexOf("=") + 1);
  await c.addCookies([{ name: hubCookieName(r.hubId), value, url: origin, secure: true, httpOnly: true, sameSite: "Strict" }]);
  await c.route("**/*", async (route: any) => {
    const req = route.request(), u = new URL(req.url());
    assert.equal(u.origin, origin, "fixture must never request an external host");
    if (u.pathname === "/fixture") return route.fulfill({ contentType: "text/html", body: html });
    if (u.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: fixtureJs });
    if (u.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
    const response = await route.fetch({ url: r.base + u.pathname + u.search, headers: { ...req.headers(), origin } });
    return route.fulfill({ response });
  });
  return c;
}
try {
  for (const [device, viewport] of Object.entries({ desktop: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } })) {
    for (const lang of ["en", "zh-TW"]) {
      const c = await context(viewport, a.cookie), p = await c.newPage(), errors: string[] = [];
      p.on("pageerror", (error: Error) => errors.push(error.message));
      await p.goto(`${origin}/fixture?lang=${lang}&before=1`); await p.waitForFunction(() => (window as any).quotaReady);
      assert.equal(await p.locator(".hub-quota-card").count(), 0);
      await p.screenshot({ path: join(out, `${device}-${lang}-before.png`), fullPage: true });
      for (const band of ["available", "near_limit", "unknown", "exhausted"]) {
        await update(band); await p.evaluate(() => (window as any).refreshQuota());
        await p.waitForFunction(band => document.querySelector(".hub-quota-card") !== null, band);
        assert.equal(await p.locator(".hub-quota-chip").count(), band === "available" ? 0 : 1);
        assert.equal(await p.locator(".hub-quota-banner").count(), band === "exhausted" ? 1 : 0);
        assert(!(await p.locator("#fixture").innerText()).includes("%"));
      }
      assert.equal(await p.locator("#sendBtn").isEnabled(), true);
      assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.equal(await p.locator(".hub-quota-card [style], .hub-quota-banner [style], .hub-quota-chip[style]").count(), 0);
      await p.screenshot({ path: join(out, `${device}-${lang}-after.png`), fullPage: true });
      const oc = await context(viewport, o.cookie), op = await oc.newPage();
      await op.goto(`${origin}/fixture?lang=${lang}&owner=1`); await op.waitForFunction(() => (window as any).quotaReady);
      await op.getByRole("switch").uncheck(); await op.waitForFunction(() => !document.querySelector(".hub-quota-card"));
      await p.evaluate(() => (window as any).refreshQuota());
      assert.equal(await p.locator(".hub-quota-card,.hub-quota-chip,.hub-quota-banner").count(), 0);
      assert(await op.getByRole("switch").evaluate(input => getComputedStyle(input, "::after").backgroundColor !== "rgba(0, 0, 0, 0)"));
      await op.screenshot({ path: join(out, `${device}-${lang}-owner-hidden.png`), fullPage: true });
      await op.getByRole("switch").check(); await op.waitForFunction(() => !!document.querySelector(".hub-quota-card"));
      assert.deepEqual(errors, []); results.push({ device, lang, before: "old room DTO without quota", after: "exhausted", hide: "owner saved and asker omitted" });
      await oc.close(); await c.close();
    }
  }
  mkdirSync(".artifacts/hub-quota-browser", { recursive: true });
  writeFileSync(".artifacts/hub-quota-browser/results.json", JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify({ cases: results.length, pngs: results.length * 3, out }));
} finally { await browser.close(); await r.close(); }

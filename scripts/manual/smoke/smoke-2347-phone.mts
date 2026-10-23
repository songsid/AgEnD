// #2347 §7 (Settings on a phone) from defaults (fleet decision a78ebdc5), through visible UI. A phone (390×844, touch):
// - Settings (the tab bar's 設定 / Settings, /settings) is the list of sections: search on top, the two groups as
//   full-width rows inside the screen (no strip scrolling sideways, nothing cut at an edge), none marked as shown, no
//   section body;
// - a row opens its section on its own with "‹ Settings" (the section's name beside it); the list is not drawn there;
// - an edit shows the Save bar inside the screen, above the bottom tabs; "‹ Settings" goes back to the list, the bar
//   still there; Agents opens Agents (/settings/agents), not the list again;
// - a search result opens its section at the field.
// Desk (1366×900): /settings is unchanged — the list beside Agents, no "‹ Settings".
// Cases: phone light en, phone dark zh-TW, desk light en. LABEL=before|after names the shots.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [LABEL=before] [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2347-phone.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "2347-phone", LABEL = process.env.LABEL ?? "after";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = /^(Viewport argument key "interactive-widget" not recognized and ignored\.|Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.|(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/[a-z-]+|auth\/session|api\/[a-z/-]+)(\?\S*)? due to access control checks\.)/;
const pageErrors = (errors: string[]) => errors.filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.test(e)));
const fx = await bootFixture({ port: Number(process.env.HP ?? 48834), instances: 4 });
const r: any = { engine: ENGINE, label: LABEL, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
const SHOWN = `(() => { const vw = innerWidth, seen = (e) => !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().height > 0;
  const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height) }; };
  const rows = [...document.querySelectorAll(".p-settings > .s-nav .seg-item")].filter(seen).map((a) => ({ text: a.textContent.trim(), href: a.getAttribute("href"), ...box(a),
    marked: a.classList.contains("active") && getComputedStyle(a, "::before").display !== "none" }));
  return { path: location.pathname, vw, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    list: seen(document.querySelector(".p-settings > .s-nav")), body: seen(document.querySelector(".p-settings > .panel-body")),
    search: box(document.querySelector("#settingsSearch")), rows, back: seen(document.querySelector(".p-settings .s-back")) ? document.querySelector(".p-settings .s-back").textContent.trim() : null,
    bar: seen(document.querySelector(".s-pending")) ? box(document.querySelector(".s-pending")) : null, tabs: seen(document.querySelector(".tabs")) ? box(document.querySelector(".tabs")) : null }; })()`;
for (const c of [{ device: "phone", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }, { device: "desk", theme: "light", lang: "en" }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c as any, { path: "/settings" }).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page } = p;
  const shot = (step: string) => page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-${step}`) });
  try {
    ok(res, "mounted", await mounted(page));
    await page.waitForSelector(".p-settings .s-nav", { timeout: 15000 }); await page.waitForTimeout(800);
    const list = await page.evaluate(SHOWN) as any;
    await shot("1-settings");
    if (c.device === "desk") {
      ok(res, "desk:listBesideAgents", list.list && list.body && list.back === null, [list.list, list.body, list.back]);
      ok(res, "desk:noOverflow", !list.overflow);
    } else {
      ok(res, "list:shownAlone", list.list && !list.body, [list.list, list.body]);
      ok(res, "list:searchOnTop", !!list.search && list.rows.length > 0 && list.search.b <= list.rows[0].t, [list.search, list.rows[0]]);
      ok(res, "list:rowsInsideScreen", list.rows.length === 8 && list.rows.every((x: any) => x.l >= 0 && x.r <= list.vw), list.rows.map((x: any) => [x.text, x.l, x.r]));
      ok(res, "list:rowsTapSize", list.rows.every((x: any) => x.h >= 44), list.rows.map((x: any) => x.h));
      ok(res, "list:noneMarked", list.rows.every((x: any) => !x.marked));
      ok(res, "list:noOverflow", !list.overflow);
      // A section, on its own.
      await page.locator(".p-settings > .s-nav .seg-item[href='/settings/agent-defaults']").tap();
      await page.waitForSelector("#g-tp", { timeout: 15000 }); await page.waitForTimeout(500);
      const sec = await page.evaluate(SHOWN) as any;
      ok(res, "section:alone", sec.path === "/settings/agent-defaults" && !sec.list && sec.body, [sec.path, sec.list, sec.body]);
      ok(res, "section:back", !!sec.back && sec.back.includes(c.lang === "en" ? "Settings" : "設定"), sec.back);
      await page.selectOption("#g-tp", { index: 1 }); await page.waitForTimeout(600);
      const edited = await page.evaluate(SHOWN) as any;
      await shot("2-section-edited");
      ok(res, "bar:insideScreenAboveTabs", !!edited.bar && edited.bar.l >= 0 && edited.bar.r <= edited.vw && (!edited.tabs || edited.bar.b <= edited.tabs.t + 1), [edited.bar, edited.tabs]);
      ok(res, "section:noOverflow", !edited.overflow);
      // Back to the list: the change is still unsaved.
      await page.locator(".p-settings .s-back").tap(); await page.waitForTimeout(600);
      const back = await page.evaluate(SHOWN) as any;
      await shot("3-back-to-list");
      ok(res, "back:list", back.path === "/settings" && back.list && !back.body && !!back.bar, [back.path, back.list, back.body, !!back.bar]);
      // Agents opens Agents, not the list again.
      await page.locator(".p-settings > .s-nav .seg-item[href='/settings/agents']").tap(); await page.waitForTimeout(800);
      const agents = await page.evaluate(SHOWN) as any;
      ok(res, "agents:opens", agents.path === "/settings/agents" && agents.body && !agents.list, [agents.path, agents.body, agents.list]);
      // A search result opens its section at the field.
      await page.locator(".p-settings .s-back").tap(); await page.waitForTimeout(500);
      await page.locator("#settingsSearch").fill(c.lang === "en" ? "log level" : "日誌");
      await page.waitForTimeout(500);
      await shot("4-search");
      const hit = page.locator(".s-find-item").first();
      const hits = await page.locator(".s-find-item").count();
      if (hits) { await hit.tap(); await page.waitForTimeout(1200); }
      const found = await page.evaluate(SHOWN) as any;
      ok(res, "search:opensSection", hits > 0 && found.path.startsWith("/settings/") && found.body && !found.list, [hits, found.path, found.body]);
      await shot("5-search-opened");
    }
    ok(res, "noPageErrors", pageErrors(p.errors).length === 0, pageErrors(p.errors));
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await shot("error").catch(() => {});
  }
  await p.ctx.close();
  for (const who of [p.personKey, "operator"]) fx.fm.webPrefs.write(who, new Map([["nav.filter", null]]));
}
r.pass = Object.values(r.cases).every((x: any) => !x.failed);
writeFileSync(shotPath(SMOKE, `result-${LABEL}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, v.failed ?? []])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);

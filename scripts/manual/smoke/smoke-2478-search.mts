// #2478 item 3 (the user's request) from defaults (fleet decision a78ebdc5): global search over the temporary public
// link, on a phone. A fresh phone (390×844, touch) signed in through the public link's own /signin as its owner, an
// admin: the menu's Search row (no Ctrl K hint on a touch screen) → the dialog → type → results → a result opens the
// chat; the header's 🔍 opens it too. Then web.search.public_link: false: no row, no button, and /ui/search answers 404
// over the link. The fleet's real index (search.db in the scratch home), fed as smoke-2293-search does.
// Cases: phone light en, phone dark zh-TW.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [LABEL=before] [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2478-search.mts
import { writeFileSync } from "node:fs";
import { bootFixture, mounted, openPublicLink, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "2478-search", LABEL = process.env.LABEL ?? "after";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = /^(Viewport argument key "interactive-widget" not recognized and ignored\.|Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.|(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/[a-z-]+|auth\/session)(\?\S*)? due to access control checks\.)/;
const pageErrors = (errors: string[]) => errors.filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.test(e)));
const fx = await bootFixture({ port: Number(process.env.HP ?? 48826), instances: 6 });
const fm = fx.fm;
const agents = fx.instances.filter((i: any) => !i.general).map((i: any) => i.name);
const [A, B] = agents;
fm.getInstanceStatus = () => "running";
fm.startSearchIndex(fm.fleetConfig);
for (let i = 0; i < 200 && fm.searchIndex?.status() !== "ready"; i++) await new Promise(r => setTimeout(r, 50));
if (fm.searchIndex?.status() !== "ready") throw new Error(`search index not ready: ${fm.searchIndex?.status()}`);
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const say = (instance: string, role: "user" | "agent", text: string, minutesAgo: number) =>
  fm.emitSseEvent("message", { instance, sender: role === "user" ? "Ann" : instance, role, text, ts: at(minutesAgo) });
say(A, "user", "Please move the nginx reverse proxy on staging to TLS 1.3 and reload it.", 3 * 24 * 60);
say(A, "agent", "Done — nginx on staging now only offers TLS 1.3; config tested and reloaded.", 3 * 24 * 60 - 4);
say(B, "user", "請把 nginx 的 access log 保留天數改成 30 天", 26 * 60);
await new Promise(r => setTimeout(r, 1500));                                          // the worker indexes them

const r: any = { engine: ENGINE, label: LABEL, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
const link = await openPublicLink(fx);
const ENTRY = `(() => { const row = document.querySelector("#sidebar .side-search"), btn = document.querySelector(".panel-head .sb-search");
  const seen = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
  const kbd = row ? row.querySelector(".kbd-hint") : null;
  return { row: !!row, rowSeen: seen(row), kbdSeen: seen(kbd), btn: seen(btn), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`;
for (const c of [{ device: "phone", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  for (const keptOff of [false, true]) {
    const tag = `${c.device}-${c.theme}-${c.lang}${keptOff ? "-kept-off" : ""}`, res: any = (r.cases[tag] = {});
    fm.fleetConfig.web.search = keptOff ? { public_link: false } : {};
    let p: any = null;
    try {
      p = await link.publicPage(c as any, { path: `/ui/chat/${A}` });
      const { page } = p;
      ok(res, "mounted", await mounted(page));
      await page.locator("#msgIn").waitFor({ timeout: 10000 });
      const header = await page.evaluate(ENTRY) as any;
      await page.locator("#main #sbOpen").first().tap();                          // the menu (the sidebar, as a drawer)
      await page.waitForTimeout(400);
      const menu = await page.evaluate(ENTRY) as any;
      await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-1-menu`) });
      const api = await page.evaluate(`fetch("/ui/search?q=nginx", { credentials: "same-origin" }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }))`) as any;
      res.measured = { header, menu, api: { status: api.status, error: api.body?.error ?? null, hits: Array.isArray(api.body?.hits) ? api.body.hits.length : null } };
      if (keptOff) {
        ok(res, "keptOff:noRow", !menu.row);
        ok(res, "keptOff:noButton", !header.btn);
        ok(res, "keptOff:route404", api.status === 404 && api.body?.error === "search_not_over_public_link", res.measured.api);
      } else {
        ok(res, "menu:searchRowShown", menu.rowSeen);
        ok(res, "menu:noCtrlKHintOnTouch", !menu.kbdSeen);
        ok(res, "header:searchButtonShown", header.btn);
        ok(res, "route:answers", api.status === 200 && (res.measured.api.hits ?? 0) > 0, res.measured.api);
        await page.locator("#sidebar .side-search").tap();
        const input = page.locator(".search-input");
        await input.waitFor({ timeout: 8000 });
        await input.fill("nginx");
        await page.waitForTimeout(1200);
        const hits = await page.locator(".search-dlg [role=option]").count();
        await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-2-results`) });
        ok(res, "dialog:results", hits > 0, hits);
        await page.locator(".search-dlg [role=option]").first().tap();
        await page.waitForTimeout(1200);
        const after = await page.evaluate(`({ path: location.pathname, dialog: !!document.querySelector("dialog[open].search-dlg") })`) as any;
        await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-3-opened`) });
        ok(res, "result:opensChat", !after.dialog && /^\/ui\/chat\//.test(after.path), after);
        // The header's 🔍 opens it too.
        await page.locator(".panel-head .sb-search").first().tap();
        ok(res, "header:opensDialog", await page.locator(".search-input").isVisible().catch(() => false));
      }
      ok(res, "noOverflow", !menu.overflow);
      // Kept off: the smoke's own probe of /ui/search is answered 404 — the browser logs that one; anything else counts.
      const errs = pageErrors(p.errors).filter((e: string) => !(keptOff && /status of 404/.test(e) && /\/ui\/search\?q=nginx/.test(e)));
      ok(res, "noPageErrors", errs.length === 0, errs);
    } catch (err) {
      res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
      await p?.page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-error`) }).catch(() => {});
    }
    await p?.ctx.close();
  }
}
fm.fleetConfig.web.search = {};
await link.close();
r.pass = Object.values(r.cases).every((c: any) => !c.failed);
writeFileSync(shotPath(SMOKE, `result-${LABEL}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, { failed: v.failed ?? [], api: v.measured?.api }])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);

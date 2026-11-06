// #2911 (6), M-2216: the preview panel's page list on the realistic fixture with the real preview listener. The agent
// sends "Counter" twice, "Report" once and an attached chart.html; the panel's Pages (3)… lists them newest first, marks
// the shown one, and a click shows another page's newest version waiting for Preview (the running frame stops).
// From defaults (nothing seeded) on a phone, then seeded desk light en and phone dark zh-TW.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2911-preview-pages.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";
import { freshPage } from "../smoke-fixture/from-defaults.mts";

const SMOKE = "smoke-2911-preview-pages";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48480), instances: 2 });
const fm = fx.fm;
const name = fx.instances.find((i: any) => !i.general)!.name;
const { publicAttachment } = await import(process.env.REPO + "/src/web-upload.ts");
const PAGE = (title: string, v: number) => `<title>${title}</title>\n<h1>${title} v${v}</h1>\n<p id=ok>${title} v${v}</p>`;
const say = (text: string, extra: any = {}) => fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text, ts: new Date().toISOString(), ...extra });
say("```html\n" + PAGE("Counter", 1) + "\n```");
say("```html\n" + PAGE("Report", 1) + "\n```");
const chart = join(fx.dir, "chart.html"); writeFileSync(chart, PAGE("Chart file", 1));
say("The chart.", { attachments: [publicAttachment(fm.webFiles.registerServed({ path: chart, instance: name, name: "chart.html", mime: "text/html", kind: "document" }))] });
say("```html\n" + PAGE("Counter", 2) + "\n```");

const PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  return { toggle: q(".pv-pages-toggle")?.textContent ?? null,
    rows: [...document.querySelectorAll(".pv-page")].map(b => [b.querySelector(".pv-page-name").textContent, b.querySelector(".pv-page-meta").textContent, b.getAttribute("aria-current")]),
    frame: !!q(".pv-panel iframe"), run: !!q(".pv-panel-run"), listing: !!q(".pv-pages"), overflowX: document.documentElement.scrollWidth - innerWidth,
    clipped: (() => { const l = q(".pv-pages"), p = q(".pv-panel"); if (!l) return false; const r = l.getBoundingClientRect(), pr = p.getBoundingClientRect(); return r.right > pr.right + 1; })() };
})()`;
const probe = (page: any) => page.evaluate(PROBE);
const openLast = async (page: any) => { await page.waitForSelector(".html-card .pv-open"); await page.evaluate(`[...document.querySelectorAll(".html-card .pv-open")].at(-1).click()`); await page.waitForTimeout(900); };
const want = { en: "Pages (3)", "zh-TW": "頁面（3）" } as const;
const results: any = { browser: fx.browser.version(), cases: {} };

async function run(id: string, page: any, lang: "en" | "zh-TW", errs: () => string[], csp?: () => Promise<string[]>) {
  const r: any = {};
  await openLast(page);
  r.opened = await probe(page);
  await page.click(".pv-pages-toggle"); await page.waitForTimeout(400);
  r.list = await probe(page);
  await page.screenshot({ path: shotPath(SMOKE, id, "1-list") });
  await page.evaluate(`document.querySelectorAll(".pv-page")[1].click()`); await page.waitForTimeout(800);
  r.picked = await probe(page);
  await page.screenshot({ path: shotPath(SMOKE, id, "2-picked") });
  r.errors = errs(); r.csp = csp ? await csp() : [];
  r.pass = r.opened.toggle === want[lang] && r.list.rows.length === 3 && r.list.rows[0][2] === "true" && /Counter/.test(r.list.rows[0][0])
    && r.list.rows[1][0] === "chart.html" && r.list.rows[2][0] === "Report" && !r.list.clipped
    && !r.picked.listing && !r.picked.frame && r.picked.run && r.picked.overflowX <= 0 && !r.errors.length && !r.csp.length;
  results.cases[id] = r;
}
{
  const fp = await freshPage(fx, { device: "phone", theme: "light", lang: "en" } as any, { account: "operator", path: `/ui/chat/${encodeURIComponent(name)}` });
  await run("fresh-phone-light-en", fp.page, "en", () => fp.errors);
  await fp.ctx.close();
}
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const { ctx, page, csp } = await fx.page(c as any, { path: `/ui/chat/${encodeURIComponent(name)}`, prefs: { "preview.optIn": true } as any });
  const errors: string[] = []; page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  await run(`${c.device}-${c.theme}-${c.lang}`, page, c.lang, () => errors, csp);
  await ctx.close();
}
writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
const ok = Object.values(results.cases).every((r: any) => r.pass);
console.log(ok ? "PASS" : "FAIL");
await fx.close();
process.exit(ok ? 0 : 1);

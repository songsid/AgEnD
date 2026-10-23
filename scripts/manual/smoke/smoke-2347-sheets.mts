// #2347 §7 (Settings on a phone) from defaults (fleet decision a78ebdc5), through visible UI: Settings' dialogs are
// full-screen sheets on a phone — an agent's dialog (Agents → Settings) and Help fill the screen, square, their title
// on top and their actions inside it at the bottom; on a desk they stay centred dialogs. And Settings' own header title
// is whole on a phone, at 320 px too (it was cut to "S…").
// Cases: phone light en, phone dark zh-TW, small (320×568) light en, small dark zh-TW, desk light en. LABEL=before|after.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [LABEL=before] [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2347-sheets.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "2347-sheets", LABEL = process.env.LABEL ?? "after";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = /^(Viewport argument key "interactive-widget" not recognized and ignored\.|Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.|(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/[a-z-]+|auth\/session|api\/[a-z/-]+)(\?\S*)? due to access control checks\.)/;
const pageErrors = (errors: string[]) => errors.filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.test(e)));
const fx = await bootFixture({ port: Number(process.env.HP ?? 48840), instances: 3 });
fx.fm.getInstanceStatus = () => "running";
const r: any = { engine: ENGINE, label: LABEL, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
const SMALL = { width: 320, height: 568 };
// The header: its title whole (not ellipsized), nothing wider than the screen.
const HEAD = `(() => { const h = document.querySelector(".p-settings .panel-head h1"), head = document.querySelector(".p-settings .panel-head");
  const hb = head.getBoundingClientRect(), kids = [...head.querySelectorAll("button, .pill, h1")].map((e) => e.getBoundingClientRect());
  const v = document.querySelector(".p-settings .panel-head .pill.ver"), vs = !!v && getComputedStyle(v).display !== "none" && v.getBoundingClientRect().width > 0;
  return { text: h.textContent, whole: h.scrollWidth <= h.clientWidth + 1, w: Math.round(h.clientWidth), sw: h.scrollWidth,
    pill: v ? { text: v.textContent, shown: vs, whole: vs && v.scrollWidth <= v.clientWidth + 1 } : null,
    inside: kids.every((b) => b.width === 0 || (b.left >= hb.left - 1 && b.right <= hb.right + 1)), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`;
// The open dialog: where it sits, its corners, its title and actions in view.
const DLG = `(() => { const d = document.querySelector(".p-settings dialog[open]"); if (!d) return null; const b = d.getBoundingClientRect(), cs = getComputedStyle(d);
  const vw = document.documentElement.clientWidth, vh = innerHeight, box = (s) => { const e = d.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right) }; };
  return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), vw, vh, radius: cs.borderTopLeftRadius,
    head: box(".dlg-head"), actions: box(".dlg-actions"), close: box(".dlg-head .icon-btn") }; })()`;
const full = (d: any) => !!d && d.l <= 0 && d.t <= 0 && d.w >= d.vw - 1 && d.h >= d.vh - 1 && d.radius === "0px";
const actionsIn = (d: any) => !d.actions || (d.actions.b <= d.vh + 1 && d.actions.t >= 0);
for (const c of [{ device: "phone", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" },
  { device: "phone", theme: "light", lang: "en", small: true }, { device: "phone", theme: "dark", lang: "zh-TW", small: true }, { device: "desk", theme: "light", lang: "en" }] as const) {
  const tag = `${"small" in c ? "small" : c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c as any, { path: "/settings/agents" }).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page } = p;
  const shot = (step: string) => page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-${step}`) });
  try {
    ok(res, "mounted", await mounted(page));
    if ("small" in c) await page.setViewportSize(SMALL);
    await page.locator(".p-settings .s-row").first().waitFor({ timeout: 15000 }); await page.waitForTimeout(600);
    const head = await page.evaluate(HEAD) as any;
    res.measured = { head };
    ok(res, "header:titleWhole", head.whole && head.text === (c.lang === "en" ? "Settings" : "設定"), head);
    ok(res, "header:inside", head.inside && !head.overflow, head);
    // The version beside it: whole where there is room (a desk), shortened or not shown on a narrow phone.
    if (c.device === "desk") ok(res, "header:versionWhole", !!head.pill && head.pill.whole, head.pill);
    await shot("1-agents");
    // An agent's dialog.
    const tap = async (loc: any) => (c.device === "phone" ? loc.tap() : loc.click());
    await tap(page.locator(".p-settings .s-row").first().locator("button", { hasText: c.lang === "en" ? /^Settings$/ : /^設定$/ }));
    await page.locator(".p-settings dialog[open]").waitFor({ timeout: 8000 }); await page.waitForTimeout(500);
    const agent = await page.evaluate(DLG) as any;
    res.measured.agent = agent;
    await shot("2-agent-dialog");
    if (c.device === "phone") {
      ok(res, "agent:fullScreen", full(agent), agent);
      ok(res, "agent:headOnTop", !!agent.head && agent.head.t >= 0 && agent.head.t <= 4 && !!agent.close && agent.close.r <= agent.vw, agent.head);
      ok(res, "agent:actionsInView", actionsIn(agent), agent.actions);
    } else {
      ok(res, "desk:centred", !!agent && agent.l > 0 && agent.t > 0 && agent.w < agent.vw - 100 && agent.radius !== "0px", agent);
    }
    await page.keyboard.press("Escape"); await page.waitForTimeout(400);
    // Help.
    await tap(page.locator(".p-settings .panel-head .icon-btn").filter({ has: page.locator("svg") }).last());
    await page.locator(".p-settings dialog[open]").waitFor({ timeout: 8000 }); await page.waitForTimeout(400);
    const help = await page.evaluate(DLG) as any;
    res.measured.help = help;
    await shot("3-help");
    if (c.device === "phone") ok(res, "help:fullScreen", full(help), help);
    else ok(res, "help:centred", !!help && help.l > 0 && help.radius !== "0px", help);
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    ok(res, "noPageErrors", pageErrors(p.errors).length === 0, pageErrors(p.errors));
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await shot("error").catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((x: any) => !x.failed);
writeFileSync(shotPath(SMOKE, `result-${LABEL}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, { failed: v.failed ?? [], head: v.measured?.head && { w: v.measured.head.w, whole: v.measured.head.whole, pill: v.measured.head.pill } }])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);

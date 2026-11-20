// M-3248 (the user): in the AI usage panel a login no agent uses (e.g. Codex wii) said 「此帳號目前沒有 Agent」 as a line of
// text beside its name. It is a quiet ⓘ there now (the muted text colour, never a warning's). M-3443 (no hover-only
// mark): in the grouped view's rows (every window, and one line per login: #4054's compact mode) the ⓘ is only drawn —
// the row is itself a button — and its words are part of the row's name; in a login's full card (the non-grouped view)
// it is the shared info icon, a button whose words show on a focus, a hover or a tap. In the desk's side panel and the
// phone's Usage dialog.
// The real app on the shared fixture (in-process FleetManager, scratch home, loopback only, fake agents); /api/ai-usage
// answered by a route. Headless. Cases: desk light en and dark zh-TW (the side panel), phone light en and dark zh-TW (the
// dialog). Pictured per case: 1-rows (the mark), 2-one-line, 3-card (its words shown: focus on a desk, a tap on a phone).
// Run it on the base too (SMOKE_NAME=…-before): it FAILs there (the words inline, no mark).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] scripts/manual/smoke/run.sh smoke-usage-no-agents-m3248.mts
// ui-gate: {"name": "Usage \"no agents\" mark (rows, one line, card)", "hp": 19673}
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-usage-no-agents-m3248";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49000), instances: 4, classic: false });
const H = 3_600_000, soon = (h: number) => new Date(Date.now() + h * H).toISOString();
const pct = (label: string, key: string, used: number, windowMs: number, resetH: number) =>
  ({ type: "percent", label, labelI18n: { key }, used, windowMs, resetsAt: soon(resetH) });
const claude = (id: string | null, s: number, w: number, extra: Record<string, unknown> = {}) => ({ id: id ? `claude:${id}` : "claude", name: id ? `Claude (${id})` : "Claude", ...(id ? { profile: id } : {}),
  status: "ok", plan: "Team Premium (6.25x)", metrics: [pct("Session", "usage.metric.session", s, 5 * H, 2), pct("Weekly", "usage.metric.weekly", w, 168 * H, 96)], ...extra });
const codex = (id: string | null, w: number, extra: Record<string, unknown> = {}) => ({ id: id ? `codex:${id}` : "codex", name: id ? `Codex (${id})` : "Codex", ...(id ? { profile: id } : {}),
  status: "ok", plan: "Self Serve Business Usage Based", metrics: [pct("Weekly", "usage.metric.weekly", w, 168 * H, 45)], ...extra });
const PROVIDERS = [claude(null, 24, 33), claude("chelly", 6, 83, { noAgents: true }),
  codex(null, 86), codex("yanxian", 18), codex("wii", 45, { noAgents: true }),
  { id: "kiro", name: "Kiro", status: "ok", plan: "Pro+", metrics: [pct("Monthly", "usage.metric.monthly", 40, 720 * H, 200)] }];
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];

try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW")) {
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    const zh = c.lang === "zh-TW", phone = c.device !== "desk";
    const WORDS = zh ? "此帳號目前沒有 Agent" : "No agents on this profile";
    const p = await freshPage(fx, c, { account: "operator", path: "/ui/fleet/org", beforeNavigate: async (ctx: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f" });
      await ctx.route(/\/api\/ai-usage(\?.*)?$/, (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ fetchedAt: new Date().toISOString(), providers: PROVIDERS }) }));
    } });
    const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const show = () => page.evaluate(!phone
      ? `Promise.all([import("/assets/usage-dialog.js"), import("/assets/header-tools.js")]).then(function (m) { m[0].usageViewStore.set({ compact: true }); m[1].setUsageRail(true); })`
      : `Promise.all([import("/assets/usage-dialog.js"), import("/assets/app-shell.js")]).then(function (m) { m[0].usageViewStore.set({ compact: true }); m[1].showDialog(m[0].UsageDialog, {}); })`);
    // The login's mark (a row's or a card's), the words shown anywhere, and whether the bubble is on screen.
    const read = (scope: string) => page.evaluate(`(() => {
      var row = ${JSON.stringify(scope)} === "row" ? [].find.call(document.querySelectorAll(".u-crow"), function (r) { return /wii/.test((r.querySelector(".u-crow-name") || {}).textContent || ""); })
        : [].find.call(document.querySelectorAll(".u-provider"), function (s) { return /wii/.test((s.querySelector(".u-profile") || {}).textContent || ""); });
      var m = row && (${JSON.stringify(scope)} === "row" ? row.querySelector(".u-na") : row.querySelector(".u-na-tip .info-tip-btn"));
      var icon = m && (m.querySelector("svg") || m), sr = row && row.querySelector(".sr-only");
      var tip = [].find.call(document.querySelectorAll(".u-na-tip .info-tip-body"), function (b) { return !b.hidden; }) || null;
      var probe = document.createElement("span"); probe.style.color = "var(--text-3)"; document.body.append(probe); var muted = getComputedStyle(probe).color; probe.remove();
      var visible = [].filter.call(document.querySelectorAll(".u-crow, .u-provider"), function (e) { var c = e.cloneNode(true); [].forEach.call(c.querySelectorAll(".sr-only, .info-tip-body"), function (x) { x.remove(); }); return (c.textContent || "").indexOf(${JSON.stringify(WORDS)}) >= 0; }).length;
      var rr = icon && icon.getBoundingClientRect(), nr = row && row.querySelector(${JSON.stringify(scope)} === "row" ? ".u-crow-name" : ".u-profile-name, .u-profile").getBoundingClientRect(), tr = tip && tip.getBoundingClientRect();
      return { row: !!row, mark: !!m, tag: m && m.tagName, label: m && m.getAttribute("aria-label"), role: m && m.getAttribute("role"), hidden: m && m.getAttribute("aria-hidden"),
        srWords: sr ? sr.textContent : null, controls: row && ${JSON.stringify(scope)} === "row" ? row.querySelectorAll("button, [tabindex]").length : null,
        muted: m ? getComputedStyle(m).color === muted : false, beside: !!(rr && nr && rr.left >= nr.left && Math.abs((rr.top + rr.bottom) / 2 - (nr.top + nr.bottom) / 2) <= 4 && rr.width <= 20),
        inline: visible, tip: tip ? { text: tip.textContent, l: Math.round(tr.left), r: Math.round(tr.right), t: Math.round(tr.top), h: Math.round(tr.height),
          near: !!rr && ((tr.top >= rr.bottom && tr.top - rr.bottom <= 12) || (tr.bottom <= rr.top && rr.top - tr.bottom <= 12)) && tr.left <= rr.right && tr.right >= rr.left - 8 } : null,
        expanded: row && row.getAttribute ? row.getAttribute("aria-expanded") : null, vw: innerWidth,
        wide: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`) as Promise<any>;
    const markAt = (scope: string) => (scope === "row" ? page.locator(".u-crow").filter({ has: page.locator(".u-crow-name", { hasText: "wii" }) }).locator(".u-na")
      : page.locator(".u-provider").filter({ has: page.locator(".u-profile", { hasText: "wii" }) }).locator(".u-na-tip .info-tip-btn")).first();
    // Hover (desk) or tap (phone) the mark, when there is one (on the base there is none: the pictures are taken anyway).
    const poke = async (scope: string, how: "hover" | "tap" | "focus") => { const m = markAt(scope); if (!(await m.count())) return; await m.scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await m[how](); };   // a scroll hides the words: let it settle first
    const shown = (x: any) => x.tip && x.tip.text === WORDS && x.tip.l >= 0 && x.tip.r <= x.vw && x.tip.h > 0 && x.tip.near;   // by the mark, inside the window
    try {
      need(await mounted(page, 30000), "the app mounted");
      // 1. The grouped view, every window: the mark beside the name, quiet, only drawn; its words in the row's name (M-3443).
      await show(); await page.waitForTimeout(1500);
      const a = await read("row");
      need(a.row && a.mark && a.inline === 0, `rows: no inline words, a mark instead (${JSON.stringify({ row: a.row, mark: a.mark, inline: a.inline })})`);
      need(a.tag === "SPAN" && a.hidden === "true" && a.srWords === WORDS && a.controls === 0, `rows: the mark only drawn, the words in the row's name, no control inside the row's button (${JSON.stringify({ tag: a.tag, hidden: a.hidden, srWords: a.srWords, controls: a.controls })})`);
      need(a.muted && a.beside && !a.wide, `rows: muted (--text-3), right of the name; no sideways scroll (${JSON.stringify({ muted: a.muted, beside: a.beside, wide: a.wide })})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "1-rows") });
      // 2. One line per login (#4054's compact mode): the mark still beside the name, its words still in the row's name.
      await page.evaluate(`document.querySelector('.u-cgroup[data-group="Codex"] .u-cg-toggle').click()`); await page.waitForTimeout(400);
      const k = await read("row");
      need(k.mark && k.muted && k.beside && k.inline === 0 && k.srWords === WORDS && !k.wide, `one line per login: the mark beside the name (${JSON.stringify({ mark: k.mark, muted: k.muted, beside: k.beside, inline: k.inline, srWords: k.srWords })})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "2-one-line") });
      await page.evaluate(`document.querySelector('.u-cgroup[data-group="Codex"] .u-cg-toggle').click()`); await page.waitForTimeout(200);
      await page.evaluate(`document.querySelector('.u-cgroup[data-group="Codex"] .u-cg-toggle').click()`); await page.waitForTimeout(200);   // back to every window
      // 3. The full card (the non-grouped view): the shared info icon, a button reached with Tab; focus (a tap on a phone)
      // shows the words beside it, inside the window.
      await page.evaluate(`import("/assets/usage-dialog.js").then(function (m) { m.usageViewStore.set({ compact: false }); })`); await page.waitForTimeout(800);
      const d = await read("card");
      need(d.row && d.mark && d.inline === 0 && d.tag === "BUTTON" && d.label === WORDS && d.muted && d.beside, `card: a quiet ⓘ button beside the profile's name, named by the words (${JSON.stringify({ row: d.row, mark: d.mark, inline: d.inline, tag: d.tag, label: d.label, muted: d.muted, beside: d.beside })})`);
      await poke("card", phone ? "tap" : "focus");
      await page.waitForTimeout(250);
        const e = await read("card");
      need(shown(e), `card: ${phone ? "a tap" : "focus"} shows the words (${JSON.stringify(e.tip)})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "3-card") });
      need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    } catch (err) {
      failed.push(`threw: ${String(err).slice(0, 300)}`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "error") }).catch(() => {});
    }
    results.push({ name: caseName(c), ok: failed.length === 0, failed });
    await p.ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);

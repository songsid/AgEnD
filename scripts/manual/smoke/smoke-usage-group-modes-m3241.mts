// M-3241 (the user): in the AI usage panel's grouped view, a provider of two or more logins (CLAUDE ×5, CODEX ×4) has −/+
// on its header's right, cycling every window of each login → one line per login (its binding window: bar, %, reset) →
// the header alone with the group's highest % — warning colours kept, remembered in this browser.
// The real app on the shared fixture (in-process FleetManager, scratch home, loopback only, fake agents); /api/ai-usage
// answered by a route with logins shaped as the user's panel (five Claude logins with 5h / 7d / Fable windows, four Codex
// with a week, one Kiro). Headless. Cases: desk light en and dark zh-TW (the side panel, the rail), phone light en and
// dark zh-TW (the Usage dialog). Pictured per case: 1-expanded, 2-compact, 3-collapsed; then a reload keeps the state.
// Run it on the base too (SMOKE_NAME=…-before): it FAILs there (no −/+).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] scripts/manual/smoke/run.sh smoke-usage-group-modes-m3241.mts
// ui-gate: {"name": "Usage groups fold (expanded, one line, header)", "hp": 19670}
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-usage-group-modes-m3241";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49000), instances: 4, classic: false });
const H = 3_600_000, soon = (h: number) => new Date(Date.now() + h * H).toISOString();
const pct = (label: string, key: string, used: number, windowMs: number, resetH: number, extra: Record<string, unknown> = {}) =>
  ({ type: "percent", label, labelI18n: { key }, used, windowMs, resetsAt: soon(resetH), ...extra });
const fable = (used: number) => pct("Fable (weekly)", "usage.metric.model_weekly", used, 168 * H, 96, { scope: "model", labelI18n: { key: "usage.metric.model_weekly", args: ["Fable"] } });
const claude = (id: string | null, s: number, w: number, f: number) => ({ id: id ? `claude:${id}` : "claude", name: id ? `Claude (${id})` : "Claude", ...(id ? { profile: id } : {}),
  status: "ok", plan: "Team Premium (6.25x)", metrics: [pct("Session", "usage.metric.session", s, 5 * H, 2), pct("Weekly", "usage.metric.weekly", w, 168 * H, 96), fable(f)] });
const codex = (id: string | null, w: number) => ({ id: id ? `codex:${id}` : "codex", name: id ? `Codex (${id})` : "Codex", ...(id ? { profile: id } : {}),
  status: "ok", plan: "Self Serve Business Usage Based", metrics: [pct("Weekly", "usage.metric.weekly", w, 168 * H, 45)] });
const PROVIDERS = [claude(null, 24, 33, 15), claude("hsinlin", 0, 44, 14), claude("jefflin", 36, 33, 0), claude("alex", 46, 89, 8), claude("chelly", 6, 83, 6),
  codex(null, 86), codex("yanxian", 18), codex("jefflin", 32), codex("wii", 45),
  { id: "kiro", name: "Kiro", status: "ok", plan: "Pro+", metrics: [pct("Monthly", "usage.metric.monthly", 40, 720 * H, 200)] }];
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];

try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW")) {
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    const zh = c.lang === "zh-TW";
    const p = await freshPage(fx, c, { account: "operator", path: "/ui/fleet/org", beforeNavigate: async (ctx: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f" });
      await ctx.route(/\/api\/ai-usage(\?.*)?$/, (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ fetchedAt: new Date().toISOString(), providers: PROVIDERS }) }));
    } });
    const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    // The grouped view (the panel's 精簡 / Compact) — the view the user's screenshot shows — then the rail (desk) or the dialog (phone).
    const show = () => page.evaluate(c.device === "desk"
      ? `Promise.all([import("/assets/usage-dialog.js"), import("/assets/header-tools.js")]).then(function (m) { m[0].usageViewStore.set({ compact: true }); m[1].setUsageRail(true); })`
      : `Promise.all([import("/assets/usage-dialog.js"), import("/assets/app-shell.js")]).then(function (m) { m[0].usageViewStore.set({ compact: true }); m[1].showDialog(m[0].UsageDialog, {}); })`);
    const read = () => page.evaluate(`(() => { var g = function (n) { return document.querySelector('.u-cgroup[data-group="' + n + '"]'); };
      var one = function (n) { var x = g(n); if (!x) return null; var b = x.querySelector(".u-cg-toggle"), top = x.querySelector(".u-cg-top");
        return { rows: x.querySelectorAll(".u-crow").length, ones: x.querySelectorAll(".u-crow.is-one").length, meters: [].map.call(x.querySelectorAll(".u-crow"), function (r) { return r.querySelectorAll(".u-cm").length; }),
          warn: [].filter.call(x.querySelectorAll(".u-cm-pct"), function (e) { return /warn|crit/.test(e.className); }).length, label: b ? b.getAttribute("title") : null,
          top: top ? top.textContent.trim() : null, topWarn: top ? /warn|crit/.test(top.className) : false, toggle: b ? (function (r) { return { w: Math.round(r.width), h: Math.round(r.height) }; })(b.getBoundingClientRect()) : null }; };
      return { claude: one("Claude"), codex: one("Codex"), kiroToggle: !!(g("Kiro") && g("Kiro").querySelector(".u-cg-toggle")), wide: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`) as Promise<any>;
    const cycle = () => page.evaluate(`document.querySelector('.u-cgroup[data-group="Claude"] .u-cg-toggle').click()`).then(() => page.waitForTimeout(400));
    try {
      need(await mounted(page, 30000), "the app mounted");
      await show(); await page.waitForTimeout(1500);
      const a = await read();
      const labels = zh ? ["每個帳號一行", "只顯示標題", "顯示所有用量"] : ["One line per account", "Show only the header", "Show every window"];
      need(a.claude && a.claude.rows === 5 && a.claude.meters.every((n: number) => n === 3) && a.claude.label === labels[0] && !a.kiroToggle && a.codex?.label === labels[0],
        `expanded: every window of each login; −/+ on CLAUDE ×5 and CODEX ×4, none on a single Kiro (${JSON.stringify({ claude: a.claude, codex: a.codex?.label, kiro: a.kiroToggle })})`);
      need(c.device === "desk" || (a.claude?.toggle && a.claude.toggle.w >= 44 && a.claude.toggle.h >= 44), `phone: −/+ a full tap target (${JSON.stringify(a.claude?.toggle)})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "1-expanded") });
      await cycle();
      const b = await read();
      need(b.claude && b.claude.rows === 5 && b.claude.ones === 5 && b.claude.meters.every((n: number) => n === 1) && b.claude.warn === 2 && b.claude.label === labels[1] && !b.wide,
        `compact: one line per login, its binding window (89% and 83% keep their warning colour) (${JSON.stringify(b.claude)})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "2-compact") });
      await cycle();
      const k = await read();
      need(k.claude && k.claude.rows === 0 && /^89%/.test(k.claude.top) && k.claude.topWarn && k.claude.label === labels[2] && k.codex?.rows === 4,
        `collapsed: the header alone with the highest % in its colour; CODEX keeps its own state (${JSON.stringify({ claude: k.claude, codex: k.codex?.rows })})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "3-collapsed") });
      // Remembered in this browser: a reload opens on it.
      await page.reload(); need(await mounted(page, 30000), "reload: the app mounted");
      await show(); await page.waitForTimeout(1500);
      const r = await read();
      need(r.claude && r.claude.rows === 0 && /^89%/.test(r.claude.top), `a reload keeps CLAUDE collapsed (${JSON.stringify(r.claude)})`);
      await cycle();   // back to every window, for the next case
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

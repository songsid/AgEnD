// M-3288 (the user): in the AI usage panel's grouped view, a login that is both stale (cached numbers, "cached at 10:47")
// and used by no agent (M-3248's ⓘ) overflowed its row in the one-line mode (M-3241): the head's cached text ran into
// the window's bar and the name vanished. Every row must keep each part inside it — the name (some of it), the ⓘ, the
// cached mark, the window's tag, bar, percent and reset — with nothing overlapping and the percent never clipped, in
// every window of each login and in one line per login; on the desk's side rail and Usage window, and the phone's.
// The real app on the shared fixture (in-process FleetManager, scratch home, loopback only, fake agents); /api/ai-usage
// answered by a route. Headless. Run it on the base too (SMOKE_NAME=…-before): it FAILs there.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] [HP=…] npx tsx scripts/manual/smoke/smoke-usage-marks-fit-m3288.mts
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-usage-marks-fit-m3288";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49010), instances: 4, classic: false });
const H = 3_600_000, soon = (h: number) => new Date(Date.now() + h * H).toISOString(), ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const pct = (label: string, key: string, used: number, windowMs: number, resetH: number) =>
  ({ type: "percent", label, labelI18n: { key }, used, windowMs, resetsAt: soon(resetH) });
const codex = (id: string | null, w: number, extra: Record<string, unknown> = {}) => ({ id: id ? `codex:${id}` : "codex", name: id ? `Codex (${id})` : "Codex", ...(id ? { profile: id } : {}),
  status: "ok", plan: "Business", metrics: [pct("Weekly", "usage.metric.weekly", w, 168 * H, 45)], ...extra });
const claude = (id: string | null, s: number, w: number, extra: Record<string, unknown> = {}) => ({ id: id ? `claude:${id}` : "claude", name: id ? `Claude (${id})` : "Claude", ...(id ? { profile: id } : {}),
  status: "ok", plan: "Team Premium (6.25x)", metrics: [pct("Session", "usage.metric.session", s, 5 * H, 2), pct("Weekly", "usage.metric.weekly", w, 168 * H, 96)], ...extra });
// The user's shape: CODEX ×4, the last both stale (an expired login, its last numbers kept) and used by no agent; a long name.
const STALE = { stale: true, staleCause: "expired", cachedAt: ago(40), hint: "Sign in again", noAgents: true };
const PROVIDERS = [claude(null, 24, 33), claude("night-shift-reviewer", 6, 83, { ...STALE }),
  codex(null, 91), codex("profile-alpha", 22), codex("team-beta", 64), codex("a-rather-long-profile-name", 86, { ...STALE }),
  { id: "kiro", name: "Kiro", status: "ok", plan: "Pro+", metrics: [pct("Monthly", "usage.metric.monthly", 40, 720 * H, 200)] }];
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];

// Every row of the Codex and Claude groups: each part inside the row, the head's parts clear of the window line, the
// percent whole, some of the name showing, both marks there.
const MEASURE = `(() => {
  var out = [];
  [].forEach.call(document.querySelectorAll('.u-cgroup[data-group="Codex"] .u-crow, .u-cgroup[data-group="Claude"] .u-crow'), function (row) {
    var R = row.getBoundingClientRect(), bad = [];
    var parts = [].slice.call(row.querySelectorAll(".u-crow-name, .u-na, .u-crow-stale, .u-cm-tag, .u-cm-bar, .u-cm-pct, .u-cm-reset, .u-crow-note"))
      .filter(function (e) { var s = getComputedStyle(e); return s.display !== "none" && s.visibility !== "hidden" && e.getBoundingClientRect().width > 0; });
    var box = function (e) { var r = e.getBoundingClientRect(); return { c: e.className.split(" ")[0], l: r.left, r: r.right, t: r.top, b: r.bottom }; };
    var bs = parts.map(box);
    bs.forEach(function (b) { if (b.l < R.left - 0.5 || b.r > R.right + 0.5) bad.push(b.c + " outside the row (" + Math.round(b.l - R.left) + ".." + Math.round(b.r - R.left) + " of " + Math.round(R.width) + ")"); });
    // No two parts overlap (a part's own children are not among them).
    for (var i = 0; i < bs.length; i++) for (var j = i + 1; j < bs.length; j++) {
      var a = bs[i], b = bs[j], ox = Math.min(a.r, b.r) - Math.max(a.l, b.l), oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (ox > 0.5 && oy > 0.5 && !parts[i].contains(parts[j]) && !parts[j].contains(parts[i])) bad.push(a.c + " overlaps " + b.c + " by " + Math.round(ox) + "px");
    }
    // Text that is cut without an ellipsis: the percent always whole; the cached mark whole when it shows words.
    [].forEach.call(row.querySelectorAll(".u-cm-pct"), function (e) { if (e.scrollWidth > e.clientWidth + 0.5) bad.push("percent clipped (" + e.textContent + ")"); });
    var st = row.querySelector(".u-crow-stale");
    if (st && st.scrollWidth > st.clientWidth + 0.5) bad.push("cached mark cut");
    var name = row.querySelector(".u-crow-name"), nw = name ? name.getBoundingClientRect().width : 0;
    if (nw < 14) bad.push("name squeezed to " + Math.round(nw) + "px");
    var stale = row.classList.contains("is-stale");
    if (stale) {
      if (!row.querySelector(".u-na")) bad.push("no ⓘ");
      if (!st) bad.push("no cached mark");
      else if (!/\\d{2}:\\d{2}/.test(st.getAttribute("title") || "") || !/\\d{2}:\\d{2}/.test(st.textContent || "")) bad.push("cached mark lost its time (title or the words read aloud)");
    }
    out.push({ name: name ? name.textContent : "?", one: row.classList.contains("is-one"), stale: stale, w: Math.round(R.width), bad: bad });
  });
  return { rows: out, wide: document.documentElement.scrollWidth > document.documentElement.clientWidth };
})()`;

try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW")) {
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    const phone = c.device !== "desk";
    const p = await freshPage(fx, c, { account: "operator", path: "/ui/fleet/org", beforeNavigate: async (ctx: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f" });
      await ctx.route(/\/api\/ai-usage(\?.*)?$/, (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ fetchedAt: new Date().toISOString(), providers: PROVIDERS }) }));
    } });
    const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const rail = `Promise.all([import("/assets/usage-dialog.js"), import("/assets/header-tools.js")]).then(function (m) { m[0].usageViewStore.set({ compact: true }); m[1].setUsageRail(true); })`;
    const dialog = `Promise.all([import("/assets/usage-dialog.js"), import("/assets/app-shell.js"), import("/assets/header-tools.js")]).then(function (m) { m[0].usageViewStore.set({ compact: true }); ${phone ? "" : "m[2].setUsageRail(false); "}m[1].showDialog(m[0].UsageDialog, {}); })`;
    const cycle = (g: string) => page.evaluate(`document.querySelector('.u-cgroup[data-group="${g}"] .u-cg-toggle').click()`).then(() => page.waitForTimeout(400));
    const check = async (where: string, shot: string) => {
      const m = await page.evaluate(MEASURE) as any;
      need(m.rows.length >= 6, `${where}: the rows are there (${m.rows.length})`);
      for (const r of m.rows) need(!r.bad.length, `${where}: ${r.one ? "one line" : "every window"} — ${r.name}: ${r.bad.join(", ")}`);
      need(!m.wide, `${where}: the page does not scroll sideways`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), shot) });
      return m;
    };
    try {
      need(await mounted(page, 30000), "the app mounted");
      for (const [where, how] of (phone ? [["usage window", dialog]] : [["side rail", rail], ["usage window", dialog]]) as Array<[string, string]>) {
        await page.evaluate(how); await page.waitForTimeout(1500);
        const tag = where === "side rail" ? "rail" : "window";
        await check(`${where} (every window)`, `${tag}-1-every`);
        await cycle("Codex"); await cycle("Claude");
        const one = await check(`${where} (one line)`, `${tag}-2-one-line`);
        need(one.rows.filter((r: any) => r.one).length >= 6, `${where}: one line per login (${one.rows.filter((r: any) => r.one).length})`);
        await cycle("Codex"); await cycle("Codex"); await cycle("Claude"); await cycle("Claude");   // back to every window
        if (where === "side rail") await page.evaluate(`import("/assets/header-tools.js").then(function (m) { m.setUsageRail(false); })`);
        else await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
      }
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

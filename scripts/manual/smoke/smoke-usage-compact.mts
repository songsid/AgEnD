// The AI usage view's compact mode, from defaults (fleet decision a78ebdc5; user request, Discord 1562814671289983058).
// Each case is a fresh profile with nothing seeded, signed in through the visible /signin, reaching the usage view
// through the header's ◔ (desk: the right rail, hidden until asked; phone: the dialog). Demo names only.
// Ten logins (the user has nine): Claude ×4 and Codex ×3 with credential profiles, sessions and weeks at normal / high /
// near-limit levels, long plan names (#2412), one with last known numbers (expired), one failing, one not logged in.
// Per case (desk light en, desk dark zh-TW, phone light zh-TW, phone dark en; reduced motion on the phone):
// - full cards first (they overflow); the header's switch (beside the title) → the logins grouped by provider (its name
//   once), each in three short lines (the user's pick: name and plan; a labelled bar per window, with that window's own
//   reset after its % — 2.3.1, the user: the week's reset was hidden behind the 5 h one's): each account
//   at most 76 px; whether all ten fit without scrolling is reported; no name clipped; both windows' % coloured as the
//   full card; last known numbers (Kiro, expired) as a muted bar with "cached at …" on the name line (2.3.1); a failed
//   account's one muted line;
// - remembered: the host holds "usage.compact" for this person, and a reload shows the lines again;
// - a line pressed opens its full card in place; its − folds it back; the switch goes back to the full cards;
// - no console error, no CSP violation, no horizontal overflow; no real fleet name in any visible text.
// - #2478: the last line keyboard-focused: its straight bar clear of the group's rounded corner, no underline to round.
// Pictures: <case>-1-full, -2-compact, -2b-compact-all (taller, every account), -2c-last-focus, -3-expanded, -4-after-reload.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [ONLY=desk-light-en,…] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-usage-compact.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath, type FreshPage, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-usage-compact";
const REPO = process.env.REPO!;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48600), classic: false });
const fm = fx.fm;
const dir = fm.dataDir ?? fx.dir;
const { setUsageFetcherForTests } = await import(REPO + "/src/usage/usage-api.ts");

// ── The fleet: demo names only ──
const names = ["general", "studio-layout", "studio-copy", "release-notes-drafter"];
fm.fleetConfig.instances = Object.fromEntries(names.map((name, i) => [name, { working_directory: dir, backend: ["claude-code", "codex", "kiro-cli"][i % 3], ...(name === "general" ? { general_topic: true } : {}) }]));
fm.fleetConfig.teams = {};
fm.getInstanceStatus = () => "running";
const REAL = /agend-|t15\d{6}|web-claude|\bsol\b|\bfable\b|qa-1|rd1-|awp-|doupo-|研一官網-t|鬥破|己把鳩/;

// ── Seven logins ──
const H = 3_600_000;
const soon = (h: number) => new Date(Date.now() + h * H).toISOString();
const pct = (key: string, label: string, used: number, windowMs: number, resetH: number) => ({ type: "percent", label, labelI18n: { key }, used, windowMs, resetsAt: soon(resetH) });
const both = (s: number, w: number, sReset = 3, wReset = 90) => [pct("usage.metric.session", "Session", s, 5 * H, sReset), pct("usage.metric.weekly", "Weekly", w, 168 * H, wReset)];
const profiled = (provider: string, profile: string, plan: string, metrics: unknown[]) => ({ id: `${provider.toLowerCase()}:${profile}`, name: `${provider} (${profile})`, profile, status: "ok", plan, metrics });
setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [
  { id: "claude", name: "Claude", status: "ok", plan: "Max (20x)", metrics: [...both(42, 75), { type: "count", label: "Credits", value: "12", unit: "coupons" }] },
  profiled("Claude", "research-team", "Team Premium (6.25x)", both(93, 20, 1, 20)),
  profiled("Codex", "design-studio", "Self Serve Business Usage Based", both(12, 64, 2, 40)),
  { id: "codex", name: "Codex", status: "ok", plan: "Pro", metrics: [pct("usage.metric.weekly", "Weekly", 8, 168 * H, 100)] },
  profiled("Claude", "release-notes-and-changelog-drafting", "Max (5x)", both(71, 91, 4, 30)),
  profiled("Claude", "研究團隊共用帳號", "Pro", both(5, 30, 2, 60)),
  profiled("Codex", "nightly-benchmarks", "Plus", both(33, 48, 1, 70)),
  { id: "kiro", name: "Kiro", status: "ok", plan: "Kiro Pro+ Power Monthly Subscription Plan", stale: true, staleCause: "expired", cachedAt: new Date(Date.now() - 2 * H).toISOString(),
    hint: "Sign in again: kiro-cli login", metrics: [pct("usage.metric.monthly", "Monthly", 55, 720 * H, 200)] },
  { id: "grok", name: "Grok", status: "error", error: "HTTP 500 from the vendor", metrics: [] },
  { id: "muse", name: "Meta Muse Code", status: "no-credentials", metrics: [] },
] }));
fm.getActiveUsageProviderIds = () => null;
const LOGINS = 10, GROUPS = 5;

const results: Array<Record<string, unknown>> = [];
let failed = 0;
function record(name: string, c: Record<string, boolean>, extra: Record<string, unknown> = {}) {
  const bad = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) failed++;
  results.push({ name, ok: !bad.length, checks: c, ...extra });
  console.log(`${bad.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""} ${JSON.stringify(extra).slice(0, 1500)}`);
}
const zh = (c: MatrixCase) => c.lang === "zh-TW";
const W = { compact: (c: MatrixCase) => (zh(c) ? "精簡" : "Compact"), full: (c: MatrixCase) => (zh(c) ? "完整" : "Full") };
const watchCsp = (ctx: any) => ctx.addInitScript({ content: `window.__smokeCsp = []; document.addEventListener("securitypolicyviolation", e => window.__smokeCsp.push(e.violatedDirective + " " + (e.blockedURI || "")));` });

/** The usage view's own scroller: the rail's body, or the dialog's. */
const SCOPE = { desk: ".u-rail", phone: "dialog[open]" } as const;
const SCROLLER = { desk: ".u-rail .u-rail-body", phone: "dialog[open] .dlg-body" } as const;
async function openUsage(p: FreshPage, c: MatrixCase) {
  if (!(await mounted(p.page, 30000))) throw new Error("the app did not mount");
  await p.page.locator("button.hd-usage").first().click();
  await p.page.waitForSelector(`${SCOPE[c.device]} .u-provider, ${SCOPE[c.device]} .u-crow`, { timeout: 15000 });
  await p.page.waitForTimeout(600);
}
/** Whether the scroller fits its content (no scrolling), and every line's name and plan as drawn. */
// A string, not a function: tsx would wrap a named function in a helper the page does not have.
const measure = (p: FreshPage, c: MatrixCase) => p.page.evaluate(`(() => {
  const s = document.querySelector(${JSON.stringify(SCROLLER[c.device])}), root = document.querySelector(${JSON.stringify(SCOPE[c.device])});
  const clipped = (el) => {
    if (!el) return null;
    const range = document.createRange(); range.selectNodeContents(el.querySelector('[aria-hidden="true"]') || el);
    const cs = getComputedStyle(el), inner = el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return range.getBoundingClientRect().width > inner + 0.01;
  };
  const groups = [...root.querySelectorAll(".u-cgroup")].map((g) => ({ name: g.querySelector(".u-cg-name")?.textContent, clipped: clipped(g.querySelector(".u-cg-name")),
    lines: g.querySelectorAll(".u-crow").length }));
  const rows = [...root.querySelectorAll(".u-crow")].map((r) => ({
    group: r.closest(".u-cgroup")?.querySelector(".u-cg-name")?.textContent, profile: r.querySelector(".u-crow-name")?.textContent ?? "",
    profileW: Math.round(r.querySelector(".u-crow-name")?.getBoundingClientRect().width ?? 0), profileClipped: clipped(r.querySelector(".u-crow-name")),
    barW: Math.round(r.querySelector(".u-cm-bar")?.getBoundingClientRect().width ?? 0),
    pcts: [...r.querySelectorAll(".u-cm-pct")].map((x) => x.textContent.replace(/\\s+/g, "") + (x.classList.contains("crit") ? "!" : x.classList.contains("warn") ? "~" : "")),
    mark: r.querySelector(".u-crow-note.is-alert")?.getAttribute("title") ?? null, h: Math.round(r.getBoundingClientRect().height),
    // 2.3.1 (the user, 2026-10-23): each window's own reset on its bar row, none on the name line; whole, never clipped.
    resets: [...r.querySelectorAll(".u-cm")].map((m) => { const x = m.querySelector(".u-cm-reset"); if (!x) return null;
      const range = document.createRange(); range.selectNodeContents(x.firstChild || x);
      return { text: (x.firstChild && x.firstChild.nodeType === 3 ? x.firstChild.textContent : x.textContent.split(" (")[0]).trim(),
        clipped: x.firstChild ? range.getBoundingClientRect().width > x.getBoundingClientRect().width + 0.5 : false }; }),
    nameLineReset: !!r.querySelector(".u-crow-reset"),
    staleMark: r.querySelector(".u-crow-stale")?.getAttribute("title") ?? null,
    staleText: (() => { const x = r.querySelector(".u-crow-stale"); return x && x.firstChild ? x.firstChild.textContent : null; })(),
    // What sticks out of the row and shows: a box inside one that clips (overflow hidden: the plan pill's text) does not.
    out: Math.max(0, ...[...r.querySelectorAll("*")].filter((el) => { for (let a = el.parentElement; a && a !== r; a = a.parentElement) if (getComputedStyle(a).overflow !== "visible") return false; return true; })
      .map((el) => Math.round(el.getBoundingClientRect().right - r.getBoundingClientRect().right))),
  }));
  return { fits: s.scrollHeight <= s.clientHeight + 1, scrollH: s.scrollHeight, clientH: s.clientHeight, cards: root.querySelectorAll(".u-provider").length, rows, groups,
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
})()`) as Promise<any>;
const csp = (page: any) => page.evaluate("window.__smokeCsp || []") as Promise<string[]>;

const ONLY = process.env.ONLY?.split(",");
const CASES: MatrixCase[] = [
  { device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" },
  { device: "phone", theme: "light", lang: "zh-TW" }, { device: "phone", theme: "dark", lang: "en" },
];
for (const c of CASES) {
  const name = `${c.device}-${c.theme}-${c.lang}`;
  if (ONLY && !ONLY.includes(name)) continue;
  const p = await freshPage(fx, c, { reducedMotion: c.device === "phone", path: "/ui/chat/studio-layout", beforeNavigate: watchCsp });
  const ck: Record<string, boolean> = {};
  await openUsage(p, c);
  const navEnd = p.errors.length;
  const toggle = p.page.locator(`${SCOPE[c.device]} .u-compact-toggle`);
  ck.toggleBesideTitle = await toggle.isVisible() && (await toggle.innerText()).trim() === W.compact(c);
  const full = await measure(p, c);
  ck.fullCards = full.cards === LOGINS && full.rows.length === 0;
  await p.page.screenshot({ path: shotPath(SMOKE, name, "1-full") });

  await toggle.click();
  await p.page.waitForFunction((n: number) => document.querySelectorAll(".u-crow").length === n, LOGINS, { timeout: 5000 }).catch(() => {});
  await p.page.waitForTimeout(300);
  const compact = await measure(p, c);
  ck.oneLinePerLogin = compact.rows.length === LOGINS && compact.cards === 0;
  ck.grouped = compact.groups.map((g: any) => `${g.name}:${g.lines}`).join(",") === "Claude:4,Codex:3,Kiro:1,Grok:1,Meta Muse Code:1" && compact.groups.length === GROUPS;
  ck.dense = compact.rows.every((r: any) => r.h <= 76);
  // The user: "too small to see". 2.3.1: each window's own reset takes a column, so the 320 px rail's bar is ~124 px
  // (was ~167); a phone keeps 150+.
  ck.barsWide = compact.rows.filter((r: any) => r.pcts.length).every((r: any) => r.barW >= (c.device === "desk" ? 120 : 150));
  ck.namesWhole = compact.groups.every((g: any) => g.clipped === false);
  // A profile names its login: it keeps room to be read (whole, or at least 56 px of it before its ellipsis).
  ck.profilesReadable = compact.rows.every((r: any) => !r.profile || r.profileClipped === false || r.profileW >= 120);
  ck.nothingOut = compact.rows.every((r: any) => r.out <= 0);
  ck.eachWindowItsReset = compact.rows.filter((r: any) => r.pcts.length).every((r: any) => r.resets.length === r.pcts.length && r.resets.every((x: any) => x && /^↻ \S+$/.test(x.text) && !x.clipped))
    && compact.rows.every((r: any) => !r.nameLineReset);
  ck.weekResetShown = (() => { const r = compact.rows[0]; return !!r && r.resets.length === 2 && !!r.resets[0]?.text && r.resets[0]?.text !== r.resets[1]?.text; })();
  const by = (profile: string) => compact.rows.find((r: any) => r.profile === profile);
  ck.colours = compact.rows[0]?.pcts.join(",") === "42%,75%~" && by("research-team")?.pcts.join(",") === "93%!,20%" && by("release-notes-and-changelog-drafting")?.pcts.join(",") === "71%~,91%!";
  const of = (group: string) => compact.rows.find((r: any) => r.group === group);
  // 2.3.1 (the user): Kiro's last known numbers show as a bar with its reset, muted, and "cached at …" on its name line
  // (why, in the tooltip); a failed read keeps its one line.
  ck.marks = of("Kiro")?.mark === null && of("Kiro")?.pcts.length === 1 && /^(cached at|快取於) /.test(of("Kiro")?.staleText ?? "") && /kiro-cli login/.test(of("Kiro")?.staleMark ?? "")
    && !!of("Grok")?.mark && of("Meta Muse Code")?.mark === null;
  ck.toggleSaysFull = (await toggle.innerText()).trim() === W.full(c) && (await toggle.getAttribute("aria-pressed")) === "true";
  ck.noPageOverflow = !compact.pageOverflow;
  await p.page.screenshot({ path: shotPath(SMOKE, name, "2-compact") });
  // Every account at once (the list scrolls a little at this height): the same page, taller, for a picture of it all.
  const vp = p.page.viewportSize();
  await p.page.setViewportSize({ width: vp.width, height: vp.height + compact.scrollH - compact.clientH + 40 });
  await p.page.waitForTimeout(300);
  await p.page.screenshot({ path: shotPath(SMOKE, name, "2b-compact-all") });
  await p.page.setViewportSize(vp);
  await p.page.waitForTimeout(300);
  // Remembered as the person's synced preference.
  await p.page.waitForTimeout(1200);                                  // the pref write's debounce
  ck.hostRemembers = fm.webPrefs.readForViewer(p.personKey).values?.["usage.compact"] === true;

  // #2478 (Prism r1): the last line keyboard-focused — its straight bar stays clear of the group's rounded, clipping
  // corner (no taper), and nothing full-width is drawn along its bottom for the corner to round.
  await p.page.evaluate(`(() => { const gs = document.querySelectorAll(${JSON.stringify(`${SCOPE[c.device]} .u-cgroup`)}); const rows = gs.length ? gs[gs.length - 1].querySelectorAll(".u-crow") : [];
    document.querySelectorAll("[data-smoke-last]").forEach((e) => e.removeAttribute("data-smoke-last")); if (rows.length) rows[rows.length - 1].setAttribute("data-smoke-last", "1"); })()`);
  const lastSel = `${SCOPE[c.device]} .u-crow[data-smoke-last]`;
  await p.page.locator(lastSel).first().focus();
  await p.page.keyboard.press("Shift+Tab"); await p.page.keyboard.press("Tab");     // keyboard focus: :focus-visible
  await p.page.waitForTimeout(200);
  const lastFocus = await p.page.evaluate(`(() => { const row = document.querySelector(${JSON.stringify(lastSel)}); if (!row) return null;
    const g = row.closest(".u-cgroup"), rr = row.getBoundingClientRect(), gr = g.getBoundingClientRect(), b = getComputedStyle(row, "::before");
    const rad = parseFloat(getComputedStyle(g).borderBottomLeftRadius) || 0, left = rr.left + parseFloat(b.left), bottom = rr.bottom - parseFloat(b.bottom), top = rr.top + parseFloat(b.top);
    // Inside the rounded clip: a point within rad of the corner must lie in the corner's circle.
    const inClip = (x, y) => { const dx = Math.max(0, gr.left + rad - x), dy = Math.max(0, y - (gr.bottom - rad)); return dx * dx + dy * dy <= rad * rad + 0.5; };
    return { focused: document.activeElement === row && row.matches(":focus-visible"), bar: b.content !== "none" && b.width === "3px", radius: rad,
      corners: [inClip(left, bottom), inClip(left + 3, bottom), inClip(left, top)], shadow: getComputedStyle(row).boxShadow, lastInGroup: Math.abs(rr.bottom - gr.bottom) < 2 }; })()`) as any;
  ck.lastFocusBarClear = !!lastFocus && lastFocus.focused && lastFocus.bar && lastFocus.lastInGroup && lastFocus.corners.every(Boolean) && lastFocus.shadow === "none";
  if (!ck.lastFocusBarClear) console.error("lastFocus", JSON.stringify(lastFocus));
  await p.page.locator(lastSel).first().screenshot({ path: shotPath(SMOKE, name, "2c-last-focus") }).catch(() => {});
  await p.page.evaluate(`document.activeElement && document.activeElement.blur(); document.querySelectorAll("[data-smoke-last]").forEach((e) => e.removeAttribute("data-smoke-last"))`);

  // A line pressed: its full card, in place; its − folds it back.
  await p.page.locator(`${SCOPE[c.device]} .u-crow`).first().click();
  await p.page.waitForTimeout(300);
  const opened = await measure(p, c);
  ck.lineOpens = opened.cards === 1 && opened.rows.length === LOGINS - 1;
  await p.page.screenshot({ path: shotPath(SMOKE, name, "3-expanded") });
  await p.page.locator(`${SCOPE[c.device]} .u-collapse`).click();
  await p.page.waitForTimeout(300);
  ck.foldsBack = (await measure(p, c)).rows.length === LOGINS;

  // A reload: still compact (the host's value; the desk's rail stays shown — its own device choice).
  await p.page.reload();
  if (c.device === "phone") await openUsage(p, c);
  else { await mounted(p.page, 30000); await p.page.waitForSelector(".u-rail .u-crow", { timeout: 15000 }).catch(() => {}); }
  await p.page.waitForTimeout(600);
  const again = await measure(p, c);
  ck.keptAfterReload = again.rows.length === LOGINS;
  await p.page.screenshot({ path: shotPath(SMOKE, name, "4-after-reload") });
  await p.page.locator(`${SCOPE[c.device]} .u-compact-toggle`).click();
  await p.page.waitForTimeout(400);
  ck.backToFull = (await measure(p, c)).cards === LOGINS;

  const visible = await p.page.evaluate("document.body.innerText") as string;
  const real = visible.split("\n").filter((l) => REAL.test(l));
  ck.demoNamesOnly = real.length === 0;
  ck.noErrors = p.errors.slice(navEnd).length === 0;
  ck.noCsp = (await csp(p.page)).length === 0;
  record(name, ck, { full: { scrollH: full.scrollH, clientH: full.clientH }, compact: { fits: compact.fits, scrollH: compact.scrollH, clientH: compact.clientH, heights: compact.rows.map((r: any) => r.h), resets: compact.rows.map((r: any) => r.resets.map((x: any) => x?.text).join("|")), nameW: compact.rows.map((r: any) => r.profileW), barW: compact.rows.map((r: any) => r.barW) },
    rows: compact.rows.map((r: any) => `${r.group}/${r.profile}: ${r.pcts.join(" ")}${r.mark ? " [mark]" : ""}`), errors: p.errors.slice(navEnd), real: real.slice(0, 5) });
  await p.ctx.close();
  // The next case starts from defaults: switching back to the full cards cleared the value (the default is not stored).
  if (Object.keys(fm.webPrefs.readForViewer(p.personKey).values ?? {}).length) throw new Error(`${name}: switching back to full left a pref set`);
}

writeFileSync(shotPath(SMOKE, "results", "x").replace(/[^/]+$/, "results.json"), JSON.stringify(results, null, 1));
console.log(`${failed ? "FAIL" : "PASS"} ${results.length} cases`);
await fx.close();
process.exit(failed ? 1 : 0);

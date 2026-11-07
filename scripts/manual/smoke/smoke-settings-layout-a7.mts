// alpha.6 feedback (#3): every Settings section in a real browser on the shared fixture (scripts/manual/smoke-fixture: the
// product's own web server from an in-process FleetManager, a scratch home, no fleet start), over the full matrix — desk 1366 /
// phone 390, light / dark, en / zh-TW. Per section and case:
//   - a picture of the whole section (the viewport is grown to the page's height, so nothing is cut off);
//   - overflow: no visible element in the section reaches past the content column (the report's "cards run off the right edge"),
//     measured twice: as drawn, and with every <details> in the section opened;
//   - the boxes: every bordered or filled block that is the width of a card (≥ 60% of the column), with its border, radius, fill
//     and padding, so one card style can be asserted across sections (box-styles: exactly one signature in a case);
//   - an unbordered card: a top-level block with a fill or a heading but no border (the report's "no border");
//   - the buttons: each visible button's kind and height, so mixed sizes for the same kind show up (button-heights);
//   - no page error, no CSP report, no horizontal scroll of the page.
// LABEL=base records what is (the before pictures; nothing is asserted).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [LABEL=base|branch] [MATRIX=full|quick|<cases>] [SECTIONS=a,b] \
//   FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-settings-layout-a7.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-settings-layout-a7";
const REPO = process.env.REPO!;
const LABEL = process.env.LABEL ?? "branch", BASE = LABEL === "base";
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
mkdirSync(OUT, { recursive: true });
const { SETTINGS_SECTIONS } = await import(REPO + "/src/ui/shared/app-route.js");
const SECTIONS: string[] = process.env.SECTIONS ? process.env.SECTIONS.split(",") : [...SETTINGS_SECTIONS];

const r: Record<string, unknown> = { label: LABEL };
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };

/** What the section looks like, measured in the page (no assertion here). */
const MEASURE = `(() => {
  const col = document.querySelector(".p-settings .panel-body > .col");
  const layout = col && col.querySelector(".s-section-layout");
  if (!col || !layout) return { missing: true };
  const cb = col.getBoundingClientRect();
  const vis = (el) => { const s = getComputedStyle(el), b = el.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && b.width > 0 && b.height > 0 && !el.closest("[hidden]"); };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).slice(0, 3).join(".") : "");
  const path = (el) => { const p = []; for (let e = el; e && e !== col && p.length < 4; e = e.parentElement) p.unshift(name(e)); return p.join(" > "); };
  const page = getComputedStyle(document.body).backgroundColor;
  const over = [], boxes = [], unbordered = [], buttons = [];
  for (const el of col.querySelectorAll("*")) {
    if (!vis(el)) continue;
    const b = el.getBoundingClientRect(), s = getComputedStyle(el);
    // An element clipped by a scrolling ancestor inside the column is fine (a table that scrolls on its own).
    let clipped = false;
    for (let a = el.parentElement; a && a !== col; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") { clipped = a.getBoundingClientRect().right <= cb.right + 1; break; } }
    if (!clipped && b.right > cb.right + 1 && el.closest(".s-section-layout")) over.push({ el: path(el), by: Math.round(b.right - cb.right) });
    const bw = parseFloat(s.borderTopWidth) + parseFloat(s.borderRightWidth);
    const fill = s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== page;
    const inLayout = el.closest(".s-section-layout") === layout;
    if (inLayout && b.width >= cb.width * 0.6 && !el.matches("input, select, textarea, button, a, summary, label, li, tr, td, th, table, tbody, thead, pre, code")) {
      if (bw > 0 && s.borderTopStyle !== "none") boxes.push({ el: path(el), sig: [s.borderTopWidth, s.borderTopStyle, s.borderTopColor, s.borderTopLeftRadius, s.backgroundColor].join(" "), pad: s.paddingTop + " " + s.paddingLeft, w: Math.round(b.width), left: Math.round(b.left - cb.left) });
      else if (fill && b.height > 40 && !el.closest(".card, details, section[class*=card], .s-card")) unbordered.push({ el: path(el), bg: s.backgroundColor, w: Math.round(b.width) });
    }
    // .s-tipbtn is two widgets (the ⓘ and the usage pill), not a button style; a list row's actions are a tap target on a
    // phone (app.css: .s-row .btn { min-height: var(--tap) }), a size on purpose.
    if (el.matches("button, a.btn") && !el.matches(".s-tipbtn") && !el.closest("nav, .s-page-tabs, .s-back, [role=tablist], .s-row")) {
      buttons.push({ cls: (el.className || "").toString().trim().split(/\\s+/).filter((c) => /^(btn|icon-btn|s-)/.test(c)).sort().join(".") || el.tagName.toLowerCase(), h: Math.round(b.height), text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 30) });
    }
  }
  const sigs = [...new Set(boxes.map((x) => x.sig))];
  // The section's own cards (not one inside a drawer or a disclosure; not the full-bleed editor or terminal) and its frames
  // (those cards, the lists, drawers and disclosures beside them): one padding, one border, one corner radius.
  const inBox = (el) => !!el.parentElement.closest("details, .drawer-body, .s-disclosure-body, .s-look-disclosure-body");
  const cards = [...layout.querySelectorAll(".card")].filter((el) => vis(el) && !inBox(el) && !el.matches(".s-dev, .s-access-terminal"))
    .map((el) => { const s = getComputedStyle(el); return { el: path(el), pad: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(" "), border: s.borderTopWidth + " " + s.borderTopStyle, radius: s.borderTopLeftRadius }; });
  // A frame is bordered all round (a row with only a divider above it is not one).
  const allRound = (el) => { const s = getComputedStyle(el); return ["Top", "Right", "Bottom", "Left"].every((side) => parseFloat(s["border" + side + "Width"]) > 0 && s["border" + side + "Style"] !== "none"); };
  const frames = [...layout.querySelectorAll(".card, details, .s-list.s-agents-list, .s-look-advanced, .runtime-connect-guide")]
    .filter((el) => vis(el) && !inBox(el) && allRound(el))
    .map((el) => ({ el: path(el), radius: getComputedStyle(el).borderTopLeftRadius }));
  return { colWidth: Math.round(cb.width), colLeft: Math.round(cb.left), over: over.slice(0, 12), overCount: over.length, boxes, sigs, unbordered: unbordered.slice(0, 8), buttons, cards, frames,
    pageOverflowX: document.documentElement.scrollWidth - innerWidth };
})()`;
/** Per button kind (.btn and .icon-btn: the button styles; a list row or a group head is not one), the heights seen with an
 *  example label each — a kind with two heights is two button styles. */
const kinds = (buttons: { cls: string; h: number; text: string }[]) => { const m: Record<string, string[]> = {};
  for (const b of buttons) { if (!/(^|\.)(btn|icon-btn)(\.|$)/.test(b.cls)) continue; const list = (m[b.cls] ??= []); if (!list.some((x) => x.startsWith(`${b.h}:`))) list.push(`${b.h}:${b.text}`); } return m; };

const fx = await bootFixture({ port: 47310, instances: 24 });
try {
  for (const c of matrix()) {
    const cn = caseName(c);
    const { ctx, page, csp } = await fx.page(c, { path: "/settings/agents" });
    const errs: string[] = [];
    page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    for (const section of SECTIONS) {
      // In-app navigation, as a person clicks the list (and so a section's lazy modules load as they do in use).
      await page.setViewportSize(VIEWPORTS[c.device]);
      await page.goto(`${fx.base}/settings/${section}`);
      await page.waitForSelector(`[data-settings-section="${section}"] .s-section-layout`, { timeout: 15000 });
      await page.waitForFunction(() => !document.querySelector(".s-section-layout .skeleton, .s-section-layout [aria-busy=true]"), null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(700);
      const drawn = await page.evaluate(MEASURE);
      // The whole section in one picture: the panel body scrolls, so the viewport is made as tall as its content.
      const tall = await page.evaluate(`(() => { const b = document.querySelector(".p-settings .panel-body"); return b ? b.scrollHeight - b.clientHeight : 0; })()`) as number;
      if (tall > 0) { await page.setViewportSize({ width: VIEWPORTS[c.device].width, height: Math.min(VIEWPORTS[c.device].height + tall + 40, 14000) }); await page.waitForTimeout(300); }
      await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-${section}`) });
      await page.evaluate(`document.querySelectorAll(".s-section-layout details").forEach((d) => { d.open = true; })`);
      await page.waitForTimeout(300);
      const opened = await page.evaluate(MEASURE);
      const tag = `${cn}:${section}`;
      const got = { drawn, opened: { over: opened.over, overCount: opened.overCount, sigs: opened.sigs, unbordered: opened.unbordered, frames: opened.frames }, buttonKinds: kinds(drawn.buttons ?? []) };
      if (BASE) { r[tag] = got; continue; }
      check(`${tag}:overflow`, !drawn.missing && drawn.overCount === 0 && opened.overCount === 0 && drawn.pageOverflowX <= 0, got);
      const pad = c.device === "phone" ? "16px 16px 16px 16px" : "24px 24px 24px 24px";
      const odd = (drawn.cards ?? []).filter((x: any) => x.pad !== pad || x.border !== "1px solid" || x.radius !== "12px");
      check(`${tag}:one-card`, odd.length === 0, { want: { pad, border: "1px solid", radius: "12px" }, odd });
      const radii = [...new Set((opened.frames ?? []).map((x: any) => x.radius))];
      check(`${tag}:one-radius`, radii.length <= 1 && (radii.length === 0 || radii[0] === "12px"), (opened.frames ?? []).filter((x: any) => x.radius !== "12px"));
      const mixed = Object.entries(got.buttonKinds).filter(([, hs]) => hs.length > 1);
      check(`${tag}:button-heights`, mixed.length === 0, mixed);
    }
    check(`${cn}:no-errors`, errs.length === 0 && (await csp()).length === 0, { errs, csp: await csp() });
    await ctx.close();
  }
  // Real values are longer than the fixture's: a paired PC's name, a model id, a long path. A <select> is as wide as its longest
  // option unless the page bounds it, so every select in the section gets a long option (with all drawers open) and nothing may
  // then reach past the column — the one way found to make a Settings card run off the right edge with this code.
  const LONG = "claude-opus-5-5-20261101-extended-context-preview-with-a-very-long-model-identifier [1m] (Windows PC DESKTOP-ABCDEFGHIJ)";
  for (const c of matrix("desk-dark-zh-TW,phone-dark-en")) {
    const { ctx, page } = await fx.page(c, { path: "/settings/agents" });
    for (const section of SECTIONS) {
      await page.goto(`${fx.base}/settings/${section}`);
      await page.waitForSelector(`[data-settings-section="${section}"] .s-section-layout`, { timeout: 15000 });
      await page.waitForTimeout(700);
      await page.evaluate(`(() => { document.querySelectorAll(".s-section-layout details").forEach((d) => { d.open = true; });
        document.querySelectorAll(".s-section-layout select").forEach((s) => { const o = document.createElement("option"); o.textContent = ${JSON.stringify(LONG)}; s.appendChild(o); }); })()`);
      await page.waitForTimeout(250);
      const m = await page.evaluate(MEASURE);
      const tag = `${caseName(c)}+long:${section}`;
      if (m.overCount || m.pageOverflowX > 0) await page.screenshot({ path: shotPath(SMOKE, `${caseName(c)}+long`, `${LABEL}-${section}`) });
      if (BASE) { if (m.overCount || m.pageOverflowX > 0) r[tag] = { over: m.over, overCount: m.overCount, pageOverflowX: m.pageOverflowX }; continue; }
      check(`${tag}:overflow`, m.overCount === 0 && m.pageOverflowX <= 0, { over: m.over, pageOverflowX: m.pageOverflowX });
    }
    await ctx.close();
  }
  // SKEW, both ways (a tab kept open across the upgrade): the OLD shell stylesheet (app.css from SKEW_BASE) with this branch's
  // lazy Settings modules, and this shell with the OLD lazy modules this branch changed. Each section still draws with no page
  // error and, with the long option in every select, nothing past the column; what the old copy cannot do is recorded.
  if (!BASE) {
    const { execFileSync } = await import("node:child_process");
    const SKEW_BASE = process.env.SKEW_BASE ?? "songsid/release/2.3.5-alpha";
    const old = (p: string) => execFileSync("git", ["-C", REPO, "show", `${SKEW_BASE}:src/ui/${p}`], { encoding: "utf8", maxBuffer: 64 << 20 });
    const changed = execFileSync("git", ["-C", REPO, "diff", "--name-only", SKEW_BASE, "--", "src/ui"], { encoding: "utf8" }).split("\n").filter((f) => /^src\/ui\/[a-z0-9-]+\.js$/.test(f)).map((f) => f.slice(7));
    r.skewModules = changed;
    const ways: [string, (page: any, served: Set<string>) => Promise<void>][] = [
      ["old-shell-css", async (page, served) => page.route(/\/assets\/app\.css(\?.*)?$/, (route: any) => { served.add("app.css"); return route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: old("shared/app.css") }); })],
      ["old-modules", async (page, served) => page.route(/\/ui\/js\/([a-z0-9-]+\.js)(\?.*)?$/, (route: any) => {
        const f = /\/ui\/js\/([a-z0-9-]+\.js)/.exec(route.request().url())![1];
        if (!changed.includes(f)) return route.continue();
        served.add(f); return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: old(f) });
      })],
    ];
    for (const [way, install] of ways) for (const c of matrix("desk-dark-zh-TW,phone-light-en")) {
      const served = new Set<string>();
      const { ctx, page } = await fx.page(c, { path: "/settings/agents" });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      await install(page, served);
      for (const section of ["agent-defaults", "notifications"]) {
        await page.goto(`${fx.base}/settings/${section}`);
        await page.waitForSelector(`[data-settings-section="${section}"] .s-section-layout`, { timeout: 15000 });
        await page.waitForTimeout(800);
        await page.evaluate(`document.querySelectorAll(".s-section-layout select").forEach((s) => { const o = document.createElement("option"); o.textContent = ${JSON.stringify(LONG)}; s.appendChild(o); })`);
        await page.waitForTimeout(250);
        const m = await page.evaluate(MEASURE);
        await page.screenshot({ path: shotPath(SMOKE, `skew-${way}-${caseName(c)}`, `${LABEL}-${section}`) });
        check(`skew-${way}-${caseName(c)}:${section}`, !m.missing && m.overCount === 0 && m.pageOverflowX <= 0, { over: m.over, cards: m.cards });
      }
      check(`skew-${way}-${caseName(c)}:served-and-no-errors`, served.size > 0 && errs.length === 0, { served: [...served], errs });
      await ctx.close();
    }
  }
  // The widths between the two fixed viewports (a laptop window, a half screen, a tablet): the report named no width, and a
  // two-column card is most at risk where the sidebar and the section list take their share. Dark and light, en and zh-TW.
  const WIDTHS = (process.env.WIDTHS ?? "900,960,1024,1100,1180,1280").split(",").map(Number);
  for (const c of matrix("desk-dark-zh-TW,desk-light-en")) {
    const { ctx, page } = await fx.page(c, { path: "/settings/agents" });
    for (const section of SECTIONS) for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fx.base}/settings/${section}`);
      await page.waitForSelector(`[data-settings-section="${section}"] .s-section-layout`, { timeout: 15000 });
      await page.waitForTimeout(600);
      await page.evaluate(`document.querySelectorAll(".s-section-layout details").forEach((d) => { d.open = true; })`);
      await page.waitForTimeout(200);
      const m = await page.evaluate(MEASURE);
      const tag = `${caseName(c)}@${width}:${section}`;
      if (m.overCount || m.pageOverflowX > 0) await page.screenshot({ path: shotPath(SMOKE, `${caseName(c)}@${width}`, `${LABEL}-${section}`), fullPage: false });
      if (BASE) { if (m.overCount || m.pageOverflowX > 0) r[tag] = { over: m.over, overCount: m.overCount, pageOverflowX: m.pageOverflowX, colWidth: m.colWidth }; continue; }
      check(`${tag}:overflow`, m.overCount === 0 && m.pageOverflowX <= 0, { over: m.over, pageOverflowX: m.pageOverflowX, colWidth: m.colWidth });
    }
    await ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  writeFileSync(join(OUT, `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL (${fail.length}): ${fail.slice(0, 40).join(", ")}` : (BASE ? "RECORDED" : "ALL PASS"));
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}

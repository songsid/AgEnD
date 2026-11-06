// #2865: short viewports (landscape phones, user report 2026-10-30): the sidebar's instance list stays usable — several
// instance rows visible, the last one reachable by scrolling, nothing in the sidebar drawn over anything else. Portrait
// phone and desktop unchanged. Each case: a fresh profile (from defaults), the phone cases as a touch device; below 900 px
// the drawer is opened from the header. Shots: the whole page, plus the sidebar scrolled to its end.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2865-sidebar-short.mts
//   LABEL=before|after names the shots (run once on main's code for the "before" pictures).
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "2865-sidebar-short", LABEL = process.env.LABEL ?? "after";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48822), instances: 24 });
const r: any = { label: LABEL, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
// What the sidebar shows: instance rows wholly inside both the sidebar and its list scroller; boxes of the sidebar's
// visible parts that overlap one another (head, nav rows, list, filter, widget, footer items); the footer's items.
const MEASURE = `(() => {
  const sb = document.querySelector("#sidebar"); if (!sb) return null;
  const R = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height }; };
  const s = R(sb), vh = innerHeight;
  const clip = { top: Math.max(s.top, 0), bottom: Math.min(s.bottom, vh) };
  const list = document.querySelector("#instanceList"), lr = list ? R(list) : null;
  const rows = [...document.querySelectorAll("#instanceList .v-li")].map(R);
  const inside = (b, c) => b.top >= c.top - 0.5 && b.bottom <= c.bottom + 0.5;
  // A row under the filter is not visible: on a short viewport the filter stays in view over the list (sticky, opaque).
  const vf = document.querySelector(".v-filter"), fr = vf ? R(vf) : null;
  const visibleRows = rows.filter((b) => inside(b, clip) && (!lr || inside(b, lr)) && (!fr || b.bottom <= fr.top + 0.5 || b.top >= fr.bottom - 0.5)).length;
  const parts = [...sb.querySelectorAll(".side-head, .side-nav > *, #instanceList, .v-filter-box, .nav-facets, .side-widget, .side-foot > *")]
    .filter((el) => el.offsetParent !== null).map((el) => ({ n: (el.className && String(el.className).split(" ")[0]) || el.tagName, b: R(el) }));
  const overlaps = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i].b, b = parts[j].b;
    if (parts[i].n === "side-section" || parts[j].n === "side-section") continue;   // the list scrolls under the filter by design
    if (a.h > 0 && b.h > 0 && a.top < b.bottom - 1 && b.top < a.bottom - 1 && a.left < b.right - 1 && b.left < a.right - 1 && !(parts[i].n === parts[j].n && parts[i].n === "side-head")) overlaps.push(parts[i].n + "×" + parts[j].n);
  }
  const foot = [...sb.querySelectorAll(".side-foot *")].filter((e) => e.children.length === 0 && e.textContent.trim() && e.offsetParent !== null);
  const textClash = [];
  for (let i = 0; i < foot.length; i++) for (let j = i + 1; j < foot.length; j++) {
    const a = R(foot[i]), b = R(foot[j]);
    if (!foot[i].contains(foot[j]) && !foot[j].contains(foot[i]) && a.top < b.bottom - 1 && b.top < a.bottom - 1 && a.left < b.right - 1 && b.left < a.right - 1) textClash.push(foot[i].textContent.trim().slice(0, 12) + "×" + foot[j].textContent.trim().slice(0, 12));
  }
  const footR = sb.querySelector(".side-foot") ? R(sb.querySelector(".side-foot")) : null;
  // The height the list really shows: its box inside the sidebar's visible part, above the filter when that is over it.
  const listShown = lr ? Math.max(0, Math.min(lr.bottom, clip.bottom, fr && fr.top < lr.bottom ? fr.top : Infinity) - Math.max(lr.top, clip.top)) : 0;
  return { viewport: innerWidth + "x" + vh, sidebar: Math.round(s.h), list: lr ? Math.round(lr.h) : null, listShown: Math.round(listShown), listShare: Math.round(listShown / (clip.bottom - clip.top) * 100) / 100, rows: rows.length, visibleRows,
    overlaps, textClash, footInView: !!footR && footR.bottom <= vh + 0.5 && footR.top >= 0,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth };
})()`;
// The scroller that moves the list: the whole sidebar when it scrolls as one column, else the list itself.
const SCROLL_END = `(() => { const sb = document.querySelector("#sidebar"), list = document.querySelector("#instanceList");
  const sc = sb && sb.scrollHeight > sb.clientHeight + 1 && getComputedStyle(sb).overflowY !== "visible" ? sb : list;
  if (!sc) return null; sc.scrollTop = sc.scrollHeight;
  const rows = [...document.querySelectorAll("#instanceList .v-li")]; const last = rows[rows.length - 1]; if (!last) return null;
  const b = last.getBoundingClientRect(), s = sb.getBoundingClientRect(), l = list.getBoundingClientRect();
  return { scroller: sc === sb ? "sidebar" : "list", lastRowVisible: b.top >= Math.max(s.top, l.top, 0) - 0.5 && b.bottom <= Math.min(s.bottom, l.bottom, innerHeight) + 0.5 }; })()`;
const CASES = [
  { tag: "landscape-844x390", device: "phone", size: { width: 844, height: 390 } },
  { tag: "landscape-915x412", device: "phone", size: { width: 915, height: 412 } },
  { tag: "landscape-956x330", device: "phone", size: { width: 956, height: 330 } },   // the user's: 2868×1320 at DPR 3, browser bars ~25%
  { tag: "portrait-390x844", device: "phone", size: { width: 390, height: 844 } },
  { tag: "desk-1366x900", device: "desk", size: { width: 1366, height: 900 } },
] as const;
for (const lang of ["zh-TW", "en"] as const) for (const k of CASES) {
  const theme = lang === "zh-TW" ? "dark" : "light", tag = `${k.tag}-${theme}-${lang}`, res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, { device: k.device, theme, lang } as any).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 240)}`]; return null; });
  if (!p) continue;
  const page = p.page;
  try {
    await page.setViewportSize(k.size);
    ok(res, "mounted", await mounted(page));
    await page.waitForTimeout(400);
    if (k.size.width < 900) { await page.locator("#main button.only-narrow").click(); await page.waitForTimeout(500); }
    await page.locator("#instanceList .v-li").first().waitFor({ timeout: 10000 });
    const m: any = await page.evaluate(MEASURE);
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-1-sidebar`) });
    // Scrolled so the list starts at the top of the sidebar (the one column scrolls; else the list is already there).
    const scrolled: any = await page.evaluate(`(() => { const sb = document.querySelector("#sidebar"), list = document.querySelector("#instanceList");
      if (getComputedStyle(sb).overflowY !== "visible" && sb.scrollHeight > sb.clientHeight + 1) sb.scrollTop += list.getBoundingClientRect().top - sb.getBoundingClientRect().top;
      return null; })()`);
    await page.waitForTimeout(200);
    const m2: any = await page.evaluate(MEASURE);
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-1b-list-at-top`) });
    void scrolled;
    const end: any = await page.evaluate(SCROLL_END);
    await page.waitForTimeout(200);
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-2-scrolled-end`) });
    res.measured = { ...m, rowsListAtTop: m2.visibleRows, listShareAtTop: m2.listShare, end };
    // At once: at least one whole instance row. Scrolled to the list: it gets most of the height and shows 2+ whole rows.
    // 330 px (the user's own, the browser's bars subtracted): the head and nav take the first ~150 px, so the first row
    // shows after one swipe — recorded, checked from 380 px up.
    if (k.size.height >= 380) ok(res, "rowVisibleAtOnce", m.visibleRows >= 1, m.visibleRows);
    ok(res, "listGetsMostOfHeight", m2.listShare >= 0.55, m2.listShare);
    ok(res, "rowsVisibleListAtTop", m2.visibleRows >= 2, m2.visibleRows);
    ok(res, "noOverlapsListAtTop", m2.overlaps.length === 0, m2.overlaps);
    ok(res, "noOverlaps", m.overlaps.length === 0, m.overlaps);
    ok(res, "noFooterTextClash", m.textClash.length === 0, m.textClash);
    ok(res, "lastRowReachable", !!end?.lastRowVisible, end);
    ok(res, "noHorizontalOverflow", !m.overflowX);
    ok(res, "noPageErrors", p.errors.length === 0, p.errors);
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-error`) }).catch(() => {});
  }
  await p.ctx.close();
}
writeFileSync(shotPath(SMOKE, "result", LABEL).replace(/\.png$/, ".json"), JSON.stringify(r, null, 2));
const failed = Object.entries(r.cases).filter(([, c]: any) => c.failed?.length);
console.log(JSON.stringify(Object.fromEntries(Object.entries(r.cases).map(([t, c]: any) => [t, { failed: c.failed ?? [], m: c.measured && { list: c.measured.list, share: c.measured.listShare, shareAtTop: c.measured.listShareAtTop, rows: c.measured.visibleRows, atTop: c.measured.rowsListAtTop, overlaps: c.measured.overlaps, clash: c.measured.textClash, end: c.measured.end } }])), null, 1));
await fx.close();
process.exit(failed.length ? 1 : 0);

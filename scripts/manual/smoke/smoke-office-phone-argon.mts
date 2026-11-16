// Office on a phone (Argon's review): the user's iPhone at 440 × 956 portrait and 956 × 440 landscape (touch, coarse
// pointer), light and dark, zh-TW, the 60-agent fixture fleet in the default zones office. Shots and measurements:
//   1-open   the Office as it opens: the top chrome's height (the stage's top), the stage, rows of the Office bar
//   2-sheet  ⋯ opened (after): the Office's tools in one sheet
//   3-card   an agent's card (opened from the desk list, as a tap does): the sheet's gap to the window's foot
//   4-zone   a zone pill tapped (after): 100 %, a name tag readable
// LABEL=before|after names the shots.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [LABEL=before] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-office-phone-argon.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "office-phone-argon", LABEL = process.env.LABEL ?? "after";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48896), classic: false });
const r: any = { label: LABEL, cases: {} };
const MEASURE = `(() => { const st = document.querySelector(".oo-stage")?.getBoundingClientRect(); const bar = document.querySelector(".oo-bar");
  const shown = (n) => { if (!n) return false; const b = n.getBoundingClientRect(), cs = getComputedStyle(n); return b.width > 0 && b.height > 0 && cs.display !== "none"; };
  const rows = shown(bar) ? new Set([...bar.children].filter(shown).map((n) => Math.round(n.getBoundingClientRect().top))).size : 0;
  const side = document.querySelector("#sidebar"), sb = side ? side.getBoundingClientRect() : null;
  const more = document.querySelector(".oo-more-btn"), mb = more && shown(more) ? more.getBoundingClientRect() : null;
  const k = Number(document.querySelector(".oo-mini-view")?.getAttribute("data-k"));
  return { innerWidth, innerHeight, chrome: st ? Math.round(st.top) : null, stageH: st ? Math.round(Math.min(st.bottom, innerHeight) - st.top) : null,
    stageW: st ? Math.round(st.width) : null, stageBottom: st ? Math.round(st.bottom) : null, barRows: rows, k,
    sidebarW: sb && sb.width > 0 && sb.right > 0 && getComputedStyle(side).visibility !== "hidden" ? Math.round(Math.min(sb.right, innerWidth) - Math.max(0, sb.left)) : 0,
    more: mb ? { w: Math.round(mb.width), h: Math.round(mb.height) } : null,
    pageScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`;
const CARD = `(() => { const c = document.querySelector(".oo-card"); if (!c) return null; const b = c.getBoundingClientRect();
  const btns = [...c.querySelectorAll("button")].map((n) => { const r = n.getBoundingClientRect(); return { cls: n.className, w: Math.round(r.width), h: Math.round(r.height) }; });
  return { sheet: c.classList.contains("sheet"), gapBelow: Math.round(innerHeight - b.bottom), h: Math.round(b.height), btns }; })()`;
const VIEWS = { portrait: { width: 440, height: 956 }, landscape: { width: 956, height: 440 } } as const;
// Landscape with the sidebar collapsed too (its ☰ / sidebar button, kept per device): the header's tabs fit its row.
const CASES = [...(["light", "dark"] as const).flatMap((theme) => (["portrait", "landscape"] as const).map((orient) => ({ theme, orient, collapsed: false }))),
  { theme: "light" as const, orient: "landscape" as const, collapsed: true }];
for (const { theme, orient, collapsed } of CASES) {
  const tag = `${orient}${collapsed ? "-collapsed" : ""}-${theme}`, res: any = (r.cases[tag] = {});
  const c = { device: "phone", theme, lang: "zh-TW" } as any;
  const p = await freshPage(fx, c, { beforeNavigate: async (ctx: any) => {
    await ctx.addInitScript({ content: `try { localStorage.setItem("agend_org_mode", "office");${collapsed ? ` localStorage.setItem("agend_sidebar", "hidden");` : ""} } catch {}` });
  } }).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page, base } = p;
  try {
    await page.setViewportSize(VIEWS[orient]);
    res.coarse = await page.evaluate(`matchMedia("(pointer: coarse)").matches`);
    await page.goto(`${base}/ui/fleet/org`);
    res.mounted = await mounted(page, 30000);
    await page.waitForSelector(".oo-canvas", { timeout: 20000 }); await page.waitForTimeout(1500);
    res.open = await page.evaluate(MEASURE);
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-1-open`) });
    if (await page.locator(".oo-more-btn").isVisible().catch(() => false)) {
      await page.locator(".oo-more-btn").tap(); await page.waitForTimeout(700);
      res.sheet = await page.evaluate(`(() => { const d = document.querySelector("dialog.oo-sheet[open] .dlg-box"); if (!d) return null; const b = d.getBoundingClientRect();
        const small = [...d.querySelectorAll("button, select, input[type=checkbox]")].map((n) => { const h = (n.type === "checkbox" ? n.closest("label") || n : n).getBoundingClientRect(); return { t: (n.textContent || n.getAttribute("aria-label") || n.className || "").trim().slice(0, 20), h: Math.round(h.height) }; }).filter((x) => x.h > 0 && x.h < 44);
        return { top: Math.round(b.top), h: Math.round(b.height), under44: small }; })()`);
      await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-2-sheet`) });
      await page.keyboard.press("Escape"); await page.waitForTimeout(400);
    }
    // An agent's card: a finger's tap on the canvas near (not on) a person — their seat on the overview, through the view.
    res.tapAt = await page.evaluate(`(() => { const f = document.querySelector(".oo-mini-view"), c = document.querySelector(".oo-canvas").getBoundingClientRect();
      const [k, x, y] = ["data-k", "data-x", "data-y"].map((a) => Number(f.getAttribute(a)));
      const dot = [...document.querySelectorAll(".oo-mini-dot")][5]; const cx = Number(dot.getAttribute("cx")), cy = Number(dot.getAttribute("cy"));
      return { x: Math.round(c.left + x + cx * k + 6), y: Math.round(c.top + y + (cy - 24) * k + 6) }; })()`);
    await page.touchscreen.tap(res.tapAt.x, res.tapAt.y);
    await page.waitForTimeout(800);
    res.card = await page.evaluate(CARD);
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-3-card`) });
    await page.evaluate(`document.querySelector(".oo-card-close")?.click()`); await page.waitForTimeout(400);
    const pills = page.locator(".oo-zone-pills button");
    if (await pills.count()) {
      res.pillHit = await page.evaluate(`(() => { const b = document.querySelectorAll(".oo-zone-pills button")[1].getBoundingClientRect(); const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return h ? h.className || h.tagName : null; })()`);
      await pills.nth(1).tap({ timeout: 8000 }); await page.waitForTimeout(900);
      res.zone = await page.evaluate(MEASURE);
      await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-4-zone`) });
    }
    res.errors = p.errors;
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-error`) }).catch(() => {});
  }
  await p.ctx.close();
}
writeFileSync(shotPath(SMOKE, `result-${LABEL}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1));
await fx.close(); process.exit(0);

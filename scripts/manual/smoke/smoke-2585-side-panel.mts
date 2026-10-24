// #2585 (the user) from defaults (fleet decision a78ebdc5), through visible navigation: Edit offices docked on the right.
// A demo fleet (a 38-desk 大廳, the Lobby). Fleet → Org chart → Office with the usage rail shown (◔), then Edit offices:
// - desk 1791 × 1089: the editor is docked in the rail's place (a non-modal dialog beside the page, 400 px, full height),
//   the rail out while it is open; the Office still in view and in use beside it, re-fitted to the narrower canvas and
//   centred; focus in the panel. Cancel closes it: the rail back as it was, focus back on Edit offices. Opened again,
//   Esc closes it.
// - Edit layout (part 2): a Studio office made and saved through Edit offices, picked, then Edit layout — its controls
//   docked in the panel (Reset, Cancel, Save its actions), the canvas whole for the handles; Esc on a handle cancels.
//   Opened again with a change (Add waypoint), Ctrl+K opens search beside it; a Settings result asks first ("Leave … without
//   saving?"): No stays, panel and change kept; Yes goes there, the panel gone.
// - desk 1100 × 900 (below the rail's width): the shared modal dialog, centred in the window (#2586's fix).
// LABEL=before|after names the shots (run "before" on main). Cases: desk light en, desk dark zh-TW.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [LABEL=before] [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2585-side-panel.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "2585-side-panel", LABEL = process.env.LABEL ?? "after";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = /^(Viewport argument key "interactive-widget" not recognized and ignored\.|Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.|(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/[a-z-]+|auth\/sessions?|api\/[a-z/-]+)(\?\S*)? due to access control checks\.)/;
// The fixture serves no message search (its /ui/search answers 404); the Settings results this smoke picks are the page's own.
const NO_MESSAGE_SEARCH = /404 \(Not Found\) @ https?:\/\/[^/]+\/ui\/search\?/;
const pageErrors = (errors: string[]) => errors.filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.test(e)) && !NO_MESSAGE_SEARCH.test(e));
const fx = await bootFixture({ port: Number(process.env.HP ?? 48876), classic: false });
const fm = fx.fm, dir = fm.dataDir ?? fx.dir;
const TEAM = "大廳", MEMBERS = Array.from({ length: 38 }, (_, i) => `desk-${String(i + 1).padStart(2, "0")}`);
const names = ["general", ...MEMBERS, "release-notes-drafter", "nightly-benchmarks"];
fm.fleetConfig.instances = Object.fromEntries(names.map((name, i) => [name, { working_directory: dir, backend: ["claude-code", "codex", "kiro-cli"][i % 3], ...(name === "general" ? { general_topic: true } : {}) }]));
fm.fleetConfig.teams = { [TEAM]: { members: MEMBERS } };
fm.getInstanceStatus = () => "running";
const r: any = { engine: ENGINE, label: LABEL, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
const STATE = `(() => { const b = (e) => e ? (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(e.getBoundingClientRect()) : null;
  const panel = document.querySelector(".shell > dialog.side-panel"), modal = [...document.querySelectorAll("dialog.dlg")].find((d) => d.matches(":modal"));
  const f = document.querySelector(".oo-mini-view"), [, , w, h] = (document.querySelector(".oo-mini")?.getAttribute("viewBox") ?? "0 0 0 0").split(" ").map(Number);
  const [k, x, y] = f ? ["data-k", "data-x", "data-y"].map((a) => Number(f.getAttribute(a))) : [0, 0, 0];
  const cv = document.querySelector(".oo-canvas")?.getBoundingClientRect();
  const a = document.activeElement;
  return { vw: innerWidth, vh: innerHeight, panel: b(panel), rail: b(document.querySelector(".shell > .u-rail")), modal: b(modal), main: b(document.querySelector("main#main")),
    canvas: b(document.querySelector(".oo-canvas")), gaps: cv ? { l: Math.round(x), r: Math.round(cv.width - x - w * k), sw: Math.round(w * k) } : null,
    focusInPanel: !!panel && panel.contains(a), focusOnEdit: !!a && a.classList.contains("oo-edit"), title: panel?.querySelector(".dlg-title")?.textContent ?? null,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`;
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const title = c.lang === "en" ? "Offices" : "辦公室", cancel = c.lang === "en" ? "Cancel" : "取消";   // the editor's own title
  const p = await freshPage(fx, c as any).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page, base } = p;
  const shot = (s: string) => page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-${s}`) });
  const state = () => page.evaluate(STATE) as Promise<any>;
  try {
    ok(res, "mounted", await mounted(page, 30000));
    await page.setViewportSize({ width: 1791, height: 1089 });
    await page.goto(`${base}/ui/fleet/org`);
    await page.locator(".oc-tools .seg-inline button", { hasText: c.lang === "en" ? "Office" : "辦公室" }).click();
    await page.waitForSelector(".oo-canvas", { timeout: 15000 }); await page.waitForTimeout(500);
    await page.locator(".panel-head .hd-usage").first().click(); await page.waitForSelector(".shell > .u-rail"); await page.waitForTimeout(600);
    const s0 = await state();
    await shot("1-office-rail");
    await page.locator(".oo-edit").click(); await page.waitForTimeout(900);
    // An office in the draft (its members shown): the rows as they are edited (Cancel throws the draft away below).
    await page.locator("#oeAdd").click(); await page.waitForTimeout(500);     // a new office opens with its members shown
    const rows = await page.evaluate(`(() => { const d = document.querySelector("dialog.dlg[open]"); if (!d) return null; const r = d.getBoundingClientRect();
      return { fit: [...d.querySelectorAll(".oe-row, .oe-row *")].every((e) => { const b = e.getBoundingClientRect(); return b.width === 0 || (b.left >= r.left - 1 && b.right <= r.right + 1); }),
        body: d.querySelector(".dlg-body").scrollWidth <= d.querySelector(".dlg-body").clientWidth + 1 }; })()`) as any;
    const s1 = await state();
    await shot("2-edit-offices");
    ok(res, "rowsFit", !!rows && rows.fit && rows.body, rows);
    res.measured = { s0, s1 };
    if (LABEL === "after") {
      ok(res, "docked", !!s1.panel && !s1.modal && s1.title === title, { panel: s1.panel, modal: s1.modal, title: s1.title });
      ok(res, "inRailsPlace", !!s1.panel && s1.panel.w === 400 && s1.panel.x + s1.panel.w === s1.vw && s1.panel.h === s1.vh && !s1.rail, s1.panel);
      ok(res, "pageBesideIt", !!s1.main && s1.main.x + s1.main.w <= s1.panel.x + 1 && s1.canvas.w < s0.canvas.w, { main: s1.main, canvasBefore: s0.canvas, canvasAfter: s1.canvas });
      ok(res, "officeCentred", !!s1.gaps && Math.abs(s1.gaps.l - s1.gaps.r) <= 1, s1.gaps);
      ok(res, "focusInPanel", s1.focusInPanel);
      // The page beside it is in use: a + on the canvas zooms it.
      const k0 = await page.evaluate(`Number(document.querySelector(".oo-mini-view").getAttribute("data-k"))`);
      await page.locator(".oo-zoom .oo-zoom-in").click(); await page.waitForTimeout(400);
      const k1 = await page.evaluate(`Number(document.querySelector(".oo-mini-view").getAttribute("data-k"))`);
      ok(res, "officeInUse", (k1 as number) > (k0 as number) && !!(await state()).panel, { k0, k1 });
      await page.locator(".side-panel .dlg-actions button", { hasText: cancel }).click(); await page.waitForTimeout(600);
      const s2 = await state();
      ok(res, "cancel:railBack", !s2.panel && !!s2.rail && s2.rail.w === s0.rail.w, { panel: s2.panel, rail: s2.rail });
      ok(res, "cancel:focusBack", s2.focusOnEdit);
      await page.locator(".oo-edit").click(); await page.waitForTimeout(600);
      await page.keyboard.press("Escape"); await page.waitForTimeout(600);
      const s3 = await state();
      ok(res, "esc:closed", !s3.panel && !!s3.rail && s3.focusOnEdit, { panel: s3.panel, rail: !!s3.rail, focusOnEdit: s3.focusOnEdit });
      await shot("3-closed");
    }
    // ── Edit layout (before: main's bar over the canvas, shot only) ──
    {
      await page.locator(".oo-edit").click(); await page.waitForTimeout(600);
      await page.locator("#oeAdd").click(); await page.waitForTimeout(300);
      await page.locator(".side-panel .oe-name").last().fill(c.lang === "en" ? "Studio room" : "工作室");
      await page.locator(".side-panel .oe-style").last().selectOption("studio");
      await page.locator(".side-panel #oeSave").click(); await page.waitForTimeout(1200);
      if (LABEL === "after") ok(res, "office:saved", !(await state()).panel);
      const officeId = await page.evaluate(`[...document.querySelectorAll(".oo-office option")].map((o) => o.value).filter((v) => !v.startsWith("__")).pop() ?? null`) as string | null;
      if (officeId) await page.locator(".oo-office").selectOption(officeId);
      await page.waitForTimeout(800);
      await page.locator(".oo-layout").click(); await page.waitForTimeout(900);
      const lay = await page.evaluate(`(() => ({ docked: !!document.querySelector(".shell > dialog.side-panel .ol-side .ol-add"),
        actions: [...document.querySelectorAll(".side-panel .dlg-actions button")].map((b) => b.className.split(" ").pop()),
        bar: !!document.querySelector(".ol-bar"), svg: !!document.querySelector("main#main .oo-stage .ol-svg"), handles: document.querySelectorAll("main#main [data-handle]").length }))()`) as any;
      if (LABEL === "after") ok(res, "layout:docked", lay.docked && !lay.bar && lay.svg && lay.handles > 0 && JSON.stringify(lay.actions) === JSON.stringify(["ol-reset", "ol-cancel", "ol-save"]), lay);
      await shot("5-edit-layout");
      if (LABEL !== "after") { await page.locator(".ol-cancel").click(); await page.waitForTimeout(400); }
    }
    if (LABEL === "after") {
      await page.locator("main#main [data-handle]").first().focus();
      await page.keyboard.press("Escape"); await page.waitForTimeout(600);
      const l2 = await page.evaluate(`({ panel: !!document.querySelector(".side-panel"), ol: !!document.querySelector(".ol"), asked: !!document.querySelector("dialog.dlg [data-confirm]") })`) as any;
      ok(res, "layout:escCancels", !l2.panel && !l2.ol && !l2.asked, l2);
      // ── Ctrl+K beside it, with a change: a Settings result asks first ──
      await page.locator(".oo-layout").click(); await page.waitForTimeout(700);
      await page.locator(".side-panel .ol-add").click(); await page.waitForTimeout(300);
      const pick = async () => {
        await page.keyboard.press("Control+k"); await page.waitForSelector("dialog.search-dlg[open] .search-input", { timeout: 8000 });
        await page.locator(".search-input").fill("theme"); await page.waitForTimeout(900);
        await page.locator(".search-settings .search-row").first().click(); await page.waitForTimeout(700);
      };
      await pick();
      const asked = await page.evaluate(`(() => { const d = [...document.querySelectorAll("dialog.dlg[open]")].find((x) => x.querySelector("[data-confirm]")); return d ? d.textContent : null; })()`) as string | null;
      ok(res, "search:asksFirst", !!asked && asked.includes(c.lang === "en" ? "without saving" : "不儲存"), asked);
      await shot("6-leave-asks");
      await page.locator("dialog.dlg[open]:has([data-confirm]) .dlg-actions .btn:not([data-confirm])").click(); await page.waitForTimeout(600);
      const stay = await page.evaluate(`({ path: location.pathname, panel: !!document.querySelector(".side-panel .ol-side"), waypoints: document.querySelectorAll("main#main [data-handle^='wp:']").length })`) as any;
      ok(res, "search:noStays", stay.path === "/ui/fleet/org" && stay.panel, stay);
      await pick();
      await page.locator("dialog.dlg[open] [data-confirm=yes]").click(); await page.waitForTimeout(1200);
      const went = await page.evaluate(`({ path: location.pathname, panel: !!document.querySelector(".side-panel") })`) as any;
      ok(res, "search:yesGoes", went.path.startsWith("/settings") && !went.panel, went);
      await shot("7-left-to-settings");
      await page.goto(`${base}/ui/fleet/org`); await page.waitForSelector(".oo-canvas", { timeout: 15000 }).catch(() => {});
    }
    // Below the rail's width: the modal dialog, centred.
    await page.setViewportSize({ width: 1100, height: 900 }); await page.waitForTimeout(500);
    if (!(await page.evaluate(`!!document.querySelector("dialog.dlg[open]")`))) { await page.locator(".oo-edit").click(); await page.waitForTimeout(700); }
    const s4 = await state();
    await shot("4-narrow-1100");
    res.measured.s4 = s4;
    if (LABEL === "after") {
      ok(res, "narrow:modalCentred", !s4.panel && !!s4.modal && Math.abs(s4.modal.x + s4.modal.w / 2 - s4.vw / 2) <= 2, { modal: s4.modal, vw: s4.vw });
    }
    ok(res, "noOverflow", !s4.overflow && !s1.overflow);
    ok(res, "noPageErrors", pageErrors(p.errors).length === 0, pageErrors(p.errors));
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await shot("error").catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((x: any) => !x.failed);
writeFileSync(shotPath(SMOKE, `result-${LABEL}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, { failed: (v.failed ?? []).map((f: string) => [f, JSON.stringify(v[f]?.detail ?? "").slice(0, 300)]) }])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);

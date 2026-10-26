// #2689: on a phone, Fleet → Org chart → Office zoomed in reaches the bottom of the scene. At 375 × 667 (the Office bar
// wrapped), zoom to at least 2× the fit and drag the scene up to the pan limit: the scene's bottom and the stage's are
// inside what is visible (innerHeight, the panel's bottom, and above the phone's tab bar), the panel body does not
// scroll, and every zoom control is inside the stage and can be hit. A short screen (375 × 480) keeps a 200 px stage
// and lets the panel scroll to it. Desktop (1366 × 900) and fullscreen on the phone (Chromium's Fullscreen API) are
// measured too, for a before/after comparison. LABEL=before|after names the shots (run "before" on main).
// Cases: phone light en, phone dark zh-TW, desk light en.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [LABEL=before] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2689-office-phone.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "2689-office-phone", LABEL = process.env.LABEL ?? "after";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48876), classic: false });
const fm = fx.fm, dir = fm.dataDir ?? fx.dir;
const TEAM = "大廳", MEMBERS = Array.from({ length: 38 }, (_, i) => `desk-${String(i + 1).padStart(2, "0")}`);
const names = ["general", ...MEMBERS, "release-notes-drafter", "nightly-benchmarks"];
fm.fleetConfig.instances = Object.fromEntries(names.map((name, i) => [name, { working_directory: dir, backend: ["claude-code", "codex", "kiro-cli"][i % 3], ...(name === "general" ? { general_topic: true } : {}) }]));
fm.fleetConfig.teams = { [TEAM]: { members: MEMBERS } };
fm.getInstanceStatus = () => "running";
const r: any = { label: LABEL, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
// The stage, the scene in it (the overview's frame: data-k/x/y and its viewBox), and the bottom of what is visible: the
// window, the panel body's bottom edge, and a tab bar fixed over the bottom (the phone's).
const MEASURE = `(() => { const st = document.querySelector(".oo-stage").getBoundingClientRect(), cv = document.querySelector(".oo-canvas").getBoundingClientRect();
  const f = document.querySelector(".oo-mini-view"), [, , w, h] = document.querySelector(".oo-mini").getAttribute("viewBox").split(" ").map(Number);
  const [k, x, y] = ["data-k", "data-x", "data-y"].map((a) => Number(f.getAttribute(a)));
  const body = document.querySelector(".p-fleet > .panel-body"), b = body.getBoundingClientRect();
  const tabs = [...document.querySelectorAll("#app .tabs")].map((n) => n.getBoundingClientRect()).filter((t) => t.height > 0 && t.top > innerHeight / 2);
  const visibleBottom = Math.min(innerHeight, b.bottom, ...tabs.map((t) => t.top));
  const bar = document.querySelector(".oo-bar"), rows = new Set([...bar.children].map((n) => Math.round(n.getBoundingClientRect().top))).size;
  return { innerHeight, k, stageTop: Math.round(st.top), stageBottom: Math.round(st.bottom), stageH: Math.round(st.height), stageW: Math.round(st.width),
    sceneBottom: Math.round(cv.top + y + h * k), visibleBottom: Math.round(visibleBottom), barRows: rows,
    bodyScroll: body.scrollHeight - body.clientHeight, bodyScrollTop: body.scrollTop }; })()`;
// Every zoom control (the label and its buttons) inside the stage and the visible area, and the one hit at its middle.
const CONTROLS = `(() => { const st = document.querySelector(".oo-stage").getBoundingClientRect();
  const tabs = [...document.querySelectorAll("#app .tabs")].map((n) => n.getBoundingClientRect()).filter((t) => t.height > 0 && t.top > innerHeight / 2);
  const bottom = Math.min(innerHeight, st.bottom, ...tabs.map((t) => t.top));
  const out = [...document.querySelectorAll(".oo-zoom > *")].map((n) => { const r = n.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { cls: n.className, top: Math.round(r.top), bottom: Math.round(r.bottom), inside: r.top >= st.top - 0.5 && r.bottom <= bottom + 0.5 && r.left >= st.left - 0.5 && r.right <= st.right + 0.5, hit: !!hit && n.contains(hit) }; });
  return { ok: out.length === 6 && out.every((c) => c.inside && c.hit), stageTop: Math.round(st.top), bottom: Math.round(bottom), controls: out }; })()`;
const FITK = `Number(document.querySelector(".oo-mini-view").getAttribute("data-k"))`;
// Drag the scene up (to its bottom) with the mouse, from the stage's middle, until it stops moving.
async function panToBottom(page: any) {
  for (let i = 0; i < 12; i++) {
    const st = await page.evaluate(`(() => { const r = document.querySelector(".oo-stage").getBoundingClientRect(); return { x: r.left + r.width / 2, top: r.top, bottom: Math.min(r.bottom, innerHeight) }; })()`) as any;
    const y0 = (await page.evaluate(`document.querySelector(".oo-mini-view").getAttribute("data-y")`));
    await page.mouse.move(st.x, st.bottom - 20); await page.mouse.down();
    await page.mouse.move(st.x, st.top + 20, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(150);
    if ((await page.evaluate(`document.querySelector(".oo-mini-view").getAttribute("data-y")`)) === y0) return;
  }
}
async function openOffice(page: any, base: string, lang: string) {
  await page.goto(`${base}/ui/fleet/org`);
  await page.locator(".oc-tools .seg-inline button", { hasText: lang === "en" ? "Office" : "辦公室" }).click();
  await page.waitForSelector(".oo-canvas", { timeout: 15000 }); await page.waitForTimeout(900);
}
const inside = (m: any) => m.sceneBottom <= m.visibleBottom + 1 && m.stageBottom <= m.visibleBottom + 1;
for (const c of [{ device: "phone", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }, { device: "desk", theme: "light", lang: "en" }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c as any).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page, base } = p;
  try {
    ok(res, "mounted", await mounted(page, 30000));
    if (c.device === "desk") {
      await openOffice(page, base, c.lang);
      res.desk = await page.evaluate(MEASURE);
      res.controlsDesk = await page.evaluate(CONTROLS);
      ok(res, "deskZoomControlsReachable", res.controlsDesk.ok, res.controlsDesk);
      await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-desk`) });
    } else {
      await page.setViewportSize({ width: 375, height: 667 });
      await openOffice(page, base, c.lang);
      const open = await page.evaluate(MEASURE) as any;
      res.controlsOpen = await page.evaluate(CONTROLS);
      await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-1-open`) });
      const fitK = await page.evaluate(FITK) as number;
      for (let i = 0; i < 12 && (await page.evaluate(FITK) as number) < 2 * fitK - 1e-6; i++) { await page.locator(".oo-zoom .oo-zoom-in").click(); await page.waitForTimeout(250); }
      await panToBottom(page);
      const zoomed = await page.evaluate(MEASURE) as any;
      await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-2-zoomed-bottom`) });
      res.measured = { open, zoomed, fitK };
      ok(res, "barWrapped", open.barRows >= 2, open.barRows);
      ok(res, "zoomControlsReachable", res.controlsOpen.ok, res.controlsOpen);
      ok(res, "zoomed2x", zoomed.k >= 2 * fitK - 1e-6, { fitK, k: zoomed.k });
      ok(res, "sceneBottomVisible", inside(zoomed), zoomed);
      ok(res, "panelDoesNotScroll", zoomed.bodyScroll <= 1, zoomed.bodyScroll);
      // A short screen: the stage keeps its floor and the panel scrolls to it.
      await page.setViewportSize({ width: 375, height: 480 }); await page.waitForTimeout(700);
      res.short = await page.evaluate(MEASURE);
      await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-3-short`) });
      ok(res, "shortFloor", res.short.stageH >= 199, res.short.stageH);
      // Scrolled to the stage's bottom (a swipe on the bars), its controls too.
      await page.evaluate(`document.querySelector(".p-fleet > .panel-body").scrollTop = 1e6`); await page.waitForTimeout(300);
      res.controlsShort = await page.evaluate(CONTROLS);
      await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-3b-short-scrolled`) });
      ok(res, "shortZoomControlsReachable", res.controlsShort.ok, res.controlsShort);
      // Fullscreen (immersive where the browser refuses): the stage is the window.
      await page.setViewportSize({ width: 375, height: 667 }); await page.waitForTimeout(500);
      await page.locator(".oo-zoom .oo-fs").click(); await page.waitForTimeout(700);
      res.fs = await page.evaluate(`(() => { const s = document.querySelector(".oo-stage").getBoundingClientRect(); return { cls: document.querySelector(".oo").className, top: Math.round(s.top), bottom: Math.round(s.bottom), h: Math.round(s.height), w: Math.round(s.width), innerHeight }; })()`);
      await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-4-fullscreen`) });
      res.controlsFs = await page.evaluate(CONTROLS);
      ok(res, "fsZoomControlsReachable", res.controlsFs.ok, res.controlsFs);
      ok(res, "fullscreenIsWindow", res.fs.top === 0 && res.fs.bottom === res.fs.innerHeight, res.fs);
    }
    ok(res, "noOverflow", !(await page.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)));
    ok(res, "noPageErrors", p.errors.length === 0, p.errors);
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-error`) }).catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((x: any) => !x.failed);
writeFileSync(shotPath(SMOKE, `result-${LABEL}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);

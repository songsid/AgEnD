import { publicRoster } from "../smoke-fixture/public-roster.mts";
// M-3556 on the real app (fleet decision a78ebdc5: from defaults, plus two stored offices put through the page's own API):
// Fleet → Org chart → Office.
//   desk: the Office bar is one row (scope left; Edit offices, Share… and ⚙ Display options right); Display options is a
//         dropdown with Style, the toggles and Key; a tick applies with it still open; a click elsewhere and Esc close
//         it; every option label in one style; nothing scrolls sideways.
//   desk, reduced motion: the M-3547 note on its own line under Drag and pat, inside the dropdown.
//   phone: no bar; ⋯ lists scope, a "Display options" heading, the options, a rule, then the actions; the Office and
//          Show pickers spaced like the rest.
// Pictures per case in $OUT/smoke-office-toolbar-m3556/.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [HP=19756] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-office-toolbar-m3556.mts
// ui-gate: {"name": "Office toolbar (local only)", "hp": 19756}
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-office-toolbar-m3556";
const CASES = [
  { device: "desk", theme: "light", lang: "zh-TW", rm: false }, { device: "desk", theme: "dark", lang: "en", rm: false },
  { device: "desk", theme: "light", lang: "zh-TW", rm: true }, { device: "desk", theme: "dark", lang: "en", rm: true },
  { device: "phone", theme: "light", lang: "zh-TW", rm: false }, { device: "phone", theme: "dark", lang: "en", rm: false },
  { device: "phone", theme: "light", lang: "zh-TW", rm: true }, { device: "phone", theme: "dark", lang: "en", rm: true },
  { device: "desk", theme: "dark", lang: "en", rm: false, short: true },
  { device: "desk", theme: "light", lang: "zh-TW", rm: false, all: true },
] as const;
const W = { en: { office: "Office", display: "Display options", note: "Off: your system asks for reduced motion" }, "zh-TW": { office: "辦公室", display: "顯示選項", note: "已關閉：系統開了「減少動態效果」" } } as const;

const fx = await bootFixture({ roster: publicRoster(8), port: 0, oldPort: Number(process.env.HP ?? 19756), instances: 8, classic: false });
const r: any = { cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
const box = (page: any, s: string) => page.locator(s).first().boundingBox();
/** M-3547 in M-3556: the reason, one line under Drag and pat inside `scope` (the dropdown or the sheet), and nowhere else. */
async function noteCheck(page: any, res: any, scope: string, w: any) {
  const note = page.locator(`${scope} .oo-play .oo-play-still`), nb = await note.boundingBox(), lb = await box(page, `${scope} .oo-play > span:first-of-type`);
  const lines = await note.evaluate((e: any) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight || "16")));
  ok(res, "reduced: one line under Drag and pat", (await note.innerText()).trim() === w.note && !!nb && !!lb && nb.y >= lb.y + lb.height - 2 && lines === 1, { nb, lb, lines });
  ok(res, "reduced: said only there", (await page.locator(".oo-play-still").count()) === 1);
  ok(res, "reduced: box off and locked", (await page.locator(`${scope} .oo-play input`).isDisabled()) && !(await page.locator(`${scope} .oo-play input`).isChecked()));
}
/** Reduced motion: a person's card has no Pat or Feed and no hint of its own (M-3547's card line is gone). */
async function cardCheck(page: any, res: any, tag: string) {
  const person = page.locator("button.oo-desk").first(); await person.focus(); await person.press("Enter");
  await page.locator(".oo-card").waitFor(); await page.waitForTimeout(400);
  ok(res, "reduced: card has no Pat/Feed, no hint", (await page.locator(".oo-card-pat, .oo-card-feed, .oo-card-play-off").count()) === 0);
  await page.screenshot({ path: shotPath(SMOKE, tag, "3-card") });
}

for (const c of CASES) {
  const short = "short" in c && c.short, all = "all" in c && c.all;
  const tag = `${c.device}-${c.theme}-${c.lang}${c.rm ? "-reduced" : ""}${short ? "-short" : ""}${all ? "-all-offices" : ""}`, w = W[c.lang];
  const res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c as any).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page, base } = p;
  try {
    ok(res, "mounted", await mounted(page, 30000));
    await page.emulateMedia({ reducedMotion: c.rm ? "reduce" : "no-preference" });
    if (short) await page.setViewportSize({ width: 1366, height: 520 });   // Prism #3556 P2: a short window
    // Two stored offices, as a fleet that uses them has (the page's own PUT: an admin's).
    await page.evaluate(async () => {
      const g = await fetch("/ui/offices").then((x) => x.json());
      if ((g.offices || []).length) return;
      await fetch("/ui/offices", { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ rev: g.rev ?? 0, offices: [{ id: "front", name: "Front desk", skin: "cozy", members: ["general", "example-agent-01"] }, { id: "lab", name: "Lab", skin: "studio", members: ["example-agent-02", "example-agent-03"] }] }) });
    });                                                                    // the rest are in no office: All offices' lobby tile
    // #4406: with offices the Office opens on All offices (the home map); the bar's own checks are of one office's view
    // (Drag and pat and the team picker are not on the map), so they start in Whole fleet, as before.
    if (!all) await page.evaluate(() => localStorage.setItem("agend_org_office", "auto"));
    await page.goto(`${base}/ui/fleet/org`);
    await page.locator(".oc-tools .seg-inline button", { hasText: w.office }).click();
    await page.waitForSelector(".oo-canvas", { timeout: 15000 }); await page.waitForTimeout(2000);
    if (all) {
      // #4406: a fresh browser opens on All offices, the home map. The lobby tile (大廳格) is one of its options.
      ok(res, "all offices: opens there", (await page.locator(".oo-office").inputValue()) === "*all");
      await page.locator(".oo-office").selectOption("*all"); await page.waitForTimeout(1500);
      await page.locator(".oo-display-btn").click(); await page.waitForTimeout(300);
      ok(res, "all offices: lobby tile offered", (await page.locator(".oo-display-pop .oo-lobby-tile input").count()) === 1 && !(await page.locator(".oo-display-pop .oo-lobby-tile input").isDisabled()));
      await page.screenshot({ path: shotPath(SMOKE, tag, "2-options") });
    } else if (short) {
      // The whole list is reachable on a short window: the dropdown ends on screen, a list longer than it scrolls, and
      // the last option, scrolled to, is on screen and takes a click.
      await page.locator(".oo-display-btn").click(); await page.waitForTimeout(300);
      const vh = await page.evaluate(() => innerHeight), pb = await page.locator(".oo-display-pop").boundingBox();
      ok(res, "short: the dropdown fits on screen", !!pb && pb.y >= 0 && pb.y + pb.height <= vh, { pb, vh });
      const last = page.locator(".oo-display-pop .oo-display-list > .check").last();
      await last.scrollIntoViewIfNeeded(); await page.waitForTimeout(150);
      const lb = await last.boundingBox();
      ok(res, "short: last option on screen", !!lb && lb.y >= 0 && lb.y + lb.height <= vh, { lb, vh });
      const was = await last.locator("input").isChecked(); await last.locator("input").click(); await page.waitForTimeout(200);
      ok(res, "short: last option works", (await last.locator("input").isChecked()) !== was);
      await page.screenshot({ path: shotPath(SMOKE, tag, "2-options") });
    } else if (c.device === "desk") {
      const bar = await box(page, ".oo > .oo-bar"), scope = await box(page, ".oo-bar-scope"), btn = await box(page, ".oo-display-btn");
      ok(res, "one row", !!bar && bar.height < 44, bar);
      ok(res, "scope left, ⚙ right", !!scope && !!btn && scope.x < btn.x && Math.abs(scope.y + scope.height / 2 - (btn.y + btn.height / 2)) < 8, { scope, btn });
      ok(res, "no option in the row", (await page.locator(".oo-bar-row .oo-style, .oo-bar-row .check").count()) === 0);
      ok(res, "⚙ label", (await page.locator(".oo-display-btn").innerText()).trim() === w.display);
      if (!c.rm) await page.screenshot({ path: shotPath(SMOKE, tag, "1-office") });
      await page.locator(".oo-display-btn").click(); await page.waitForTimeout(300);
      const pop = page.locator(".oo-display-pop");
      ok(res, "dropdown open", (await pop.count()) === 1 && (await page.locator(".oo-display-btn").getAttribute("aria-expanded")) === "true");
      ok(res, "dropdown items", (await pop.locator(".oo-style").count()) === 1 && (await pop.locator(".oo-hide-asleep, .oo-play, .oo-night, .oo-dialogue, .oo-key-tick").count()) === 5);
      ok(res, "not modal", (await page.locator(".oo-sheet, .dlg-backdrop").count()) === 0);
      // One style for every option label (Leader's nit: Hide paused was grey and smaller on a desk).
      const looks = await pop.locator(".check > span:first-of-type").evaluateAll((els: any[]) => els.map((e) => { const s = getComputedStyle(e.closest(".check")); return `${s.color}|${s.fontSize}|${s.fontWeight}`; }));
      ok(res, "labels alike", new Set(looks).size === 1, looks);
      ok(res, "no buttons in the options", (await pop.locator(".btn").count()) === 0);
      const pb = await pop.boundingBox(), vw = await page.evaluate(() => innerWidth), zb = await box(page, ".oo-zoom");
      ok(res, "clear of the zoom stack", !!pb && !!zb && (pb.x + pb.width <= zb.x || pb.y >= zb.y + zb.height), { pb, zb });
      ok(res, "dropdown heading", (await pop.locator(".oo-display-h").innerText()).trim() === w.display);
      ok(res, "dropdown on screen", !!pb && pb.x >= 0 && pb.x + pb.width <= vw, pb);
      if (c.rm) {
        await noteCheck(page, res, ".oo-display-pop", w);
        await page.screenshot({ path: shotPath(SMOKE, tag, "2-options") });
        await page.keyboard.press("Escape"); await page.waitForTimeout(200);
        await cardCheck(page, res, tag);
      } else {
        ok(res, "no note", (await page.locator(".oo-play-still").count()) === 0 && !(await pop.locator(".oo-play input").isDisabled()));
        await page.screenshot({ path: shotPath(SMOKE, tag, "2-options") });
        // A tick applies with the dropdown still open (the office stays in view).
        const before = await page.locator(".oo-dialogue-canvas").count();
        await pop.locator(".oo-dialogue input").check(); await page.waitForTimeout(400);
        ok(res, "tick applies, still open", (await page.locator(".oo-display-pop").count()) === 1 && (await page.locator(".oo-dialogue input").isChecked()), { before });
        await pop.locator(".oo-dialogue input").uncheck();
        await page.mouse.click(300, 600); await page.waitForTimeout(300);
        ok(res, "click elsewhere closes", (await page.locator(".oo-display-pop").count()) === 0);
        await page.locator(".oo-display-btn").click(); await page.waitForTimeout(200);
        await page.keyboard.press("Escape"); await page.waitForTimeout(200);
        ok(res, "Esc closes", (await page.locator(".oo-display-pop").count()) === 0);
      }
    } else {
      ok(res, "no desk row", (await page.locator(".oo-bar-row, .oo-display-btn").count()) === 0);
      await page.screenshot({ path: shotPath(SMOKE, tag, "1-office") });
      await page.locator(".oo-more-btn").click(); await page.locator(".oo-sheet .oo-sheet-bar").waitFor(); await page.waitForTimeout(400);
      const order = await page.locator(".oo-sheet .oo-sheet-bar > *").evaluateAll((els: any[]) => els.map((e) => e.tagName === "H3" ? "heading" : e.tagName === "HR" ? "rule"
        : e.querySelector?.(".oo-office") ? "office" : e.querySelector?.(".oo-team") ? "team" : e.querySelector?.(".oo-style") ? "style" : [...e.classList].find((x: string) => x.startsWith("oo-")) ?? e.tagName));
      const hi = order.indexOf("heading"), ri = order.indexOf("rule");
      ok(res, "sheet order", order.slice(0, hi).join() === "office,team,oo-people" && hi > 0 && ri > hi && order.slice(hi + 1, ri).includes("style") && order.slice(ri + 1).includes("oo-edit"), order);
      ok(res, "heading", (await page.locator(".oo-sheet .oo-sheet-h").innerText()).trim() === w.display);
      // Taller than the screen: it scrolls, with a shadow at its foot until the end; the last action is reachable.
      const body = page.locator(".oo-sheet .dlg-body");
      const sc = await body.evaluate((e: any) => ({ sh: e.scrollHeight, ch: e.clientHeight, more: e.hasAttribute("data-more"), fade: getComputedStyle(e, "::after").backgroundImage }));
      ok(res, "sheet scrolls, foot fades", sc.sh > sc.ch && sc.more && /gradient/.test(sc.fade), sc);
      const o = await box(page, ".oo-sheet .oo-office"), t = await box(page, ".oo-sheet .oo-team");
      ok(res, "pickers spaced", !!o && !!t && t.y - (o.y + o.height) >= 6, { o, t });
      if (c.rm) {
        await page.locator(".oo-sheet .oo-play").scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
        await noteCheck(page, res, ".oo-sheet", w);
      } else ok(res, "no note", (await page.locator(".oo-play-still").count()) === 0);
      await page.screenshot({ path: shotPath(SMOKE, tag, "2-options") });
      await body.evaluate((e: any) => { e.scrollTop = e.scrollHeight; }); await page.waitForTimeout(300);
      const share = await box(page, ".oo-sheet .oo-share"), bb = await body.boundingBox();
      ok(res, "last action reachable", !!share && !!bb && share.y + share.height <= bb.y + bb.height + 1, { share, bb });
      ok(res, "no fade at the end", !(await body.evaluate((e: any) => e.hasAttribute("data-more"))));
      // Content that grows while the sheet is open brings the fade back without a scroll (Prism r3 P3).
      const regrown = await body.evaluate(async (e: any) => { const x = document.createElement("div"); x.style.height = "240px"; e.querySelector(".oo-sheet-bar").appendChild(x);
        await new Promise((r) => setTimeout(r, 250)); const on = e.hasAttribute("data-more"); x.remove(); return on; });
      ok(res, "fade follows content", regrown);
      await page.screenshot({ path: shotPath(SMOKE, tag, "2b-options-end") });
      await page.keyboard.press("Escape"); await page.waitForTimeout(300);
      // The page's ⋯ keeps no pressed look once the sheet is closed (a tap left :hover stuck on touch).
      const mb = await page.locator(".oo-more-btn").evaluate((e: any) => getComputedStyle(e).backgroundColor);
      ok(res, "⋯ not stuck pressed", /rgba\(0, 0, 0, 0\)|transparent/.test(mb), mb);
      if (c.rm) await cardCheck(page, res, tag);
    }
    ok(res, "noOverflow", !(await page.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)));
    ok(res, "noPageErrors", p.errors.length === 0, p.errors);
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await page.screenshot({ path: shotPath(SMOKE, tag, "error") }).catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((v: any) => !v.failed);
writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, v.failed ?? []])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);

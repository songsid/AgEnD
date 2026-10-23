// #2347 follow-ups from defaults (fleet decision a78ebdc5), through visible UI:
// (a) opening a dialog paints no focus ring (WebKit drew one on its × at once): after a tap or a click on an agent's
//     Settings, nothing in the dialog shows a ring; Tab then gives the next stop the keyboard's ring.
// (b) the Agents search's placeholder ends in "…" where it does not fit (320 px), not cut mid-word: proven in pixels —
//     where the text is wider than its box, the box drawn as it is styled and with its overflow clipped differ.
// Cases: small (320×568) light en, small dark zh-TW, desk light en. LABEL=before|after names the shots.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [LABEL=before] [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2347-focus-placeholder.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "2347-focus-placeholder", LABEL = process.env.LABEL ?? "after";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = /^(Viewport argument key "interactive-widget" not recognized and ignored\.|Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.|(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/[a-z-]+|auth\/session|api\/[a-z/-]+)(\?\S*)? due to access control checks\.)/;
const pageErrors = (errors: string[]) => errors.filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.test(e)));
const fx = await bootFixture({ port: Number(process.env.HP ?? 48844), instances: 3 });
fx.fm.getInstanceStatus = () => "running";
const r: any = { engine: ENGINE, label: LABEL, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
// What has focus inside the open dialog, and whether anything in it paints a ring (an outline, from :focus-visible).
const RING = `(() => { const d = document.querySelector(".p-settings dialog[open]"); if (!d) return null; const a = document.activeElement;
  const ringed = [...d.querySelectorAll("*")].filter((e) => { const cs = getComputedStyle(e); return cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0; });
  return { active: a ? (a.className || a.tagName) + "" : null, activeIsX: !!a && a.classList.contains("dlg-x"), activeVisible: !!a && a.matches(":focus-visible"),
    ringed: ringed.map((e) => (e.className || e.tagName) + "") }; })()`;
for (const c of [{ device: "phone", theme: "light", lang: "en", small: true }, { device: "phone", theme: "dark", lang: "zh-TW", small: true }, { device: "desk", theme: "light", lang: "en" }] as const) {
  const tag = `${"small" in c ? "small" : c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c as any, { path: "/settings/agents" }).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page } = p;
  const shot = (step: string) => page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-${step}`) });
  try {
    ok(res, "mounted", await mounted(page));
    if ("small" in c) await page.setViewportSize({ width: 320, height: 568 });
    await page.locator(".p-settings .s-row").first().waitFor({ timeout: 15000 }); await page.waitForTimeout(600);
    // (b) The placeholder: does it overflow its box here, and is the overflow drawn as "…"?
    const input = page.locator(".p-settings .s-toolbar .s-search input");
    const fit = await input.evaluate((el: any) => { const cs = getComputedStyle(el), cv = document.createElement("canvas").getContext("2d")!;
      cv.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      return { text: el.placeholder, need: Math.round(cv.measureText(el.placeholder).width), room: Math.round(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)), overflow: cs.textOverflow }; });
    res.measured = { fit };
    const asStyled = await input.screenshot();
    await input.evaluate((el: any) => { el.style.textOverflow = "clip"; });
    const clipped = await input.screenshot();
    await input.evaluate((el: any) => { el.style.textOverflow = ""; });
    await shot("1-agents");
    // Whole where it fits (an engine's own font decides: Chromium fits the English at 320 px, WebKit does not); where it
    // does not, its end is drawn as "…".
    res.measured.overflows = fit.need > fit.room;
    ok(res, "placeholder:wholeOrEllipsis", fit.need <= fit.room || !asStyled.equals(clipped), { ...fit, differs: !asStyled.equals(clipped) });
    if (!("small" in c)) ok(res, "placeholder:fitsOnDesk", fit.need <= fit.room, fit);
    // (a) Open an agent's dialog the way a person does.
    const open = page.locator(".p-settings .s-row").first().locator("button", { hasText: c.lang === "en" ? /^Settings$/ : /^設定$/ });
    if (c.device === "phone") await open.tap(); else await open.click();
    await page.locator(".p-settings dialog[open]").waitFor({ timeout: 8000 }); await page.waitForTimeout(500);
    const opened = await page.evaluate(RING) as any;
    await shot("2-dialog-opened");
    res.measured.opened = opened;
    ok(res, "open:noRing", !!opened && opened.ringed.length === 0 && !opened.activeIsX, opened);
    await page.keyboard.press("Tab"); await page.waitForTimeout(300);
    const tabbed = await page.evaluate(RING) as any;
    await shot("3-after-tab");
    res.measured.tabbed = tabbed;
    ok(res, "tab:ringShown", !!tabbed && tabbed.activeVisible && tabbed.ringed.length === 1, tabbed);
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    ok(res, "noPageErrors", pageErrors(p.errors).length === 0, pageErrors(p.errors));
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await shot("error").catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((x: any) => !x.failed);
writeFileSync(shotPath(SMOKE, `result-${LABEL}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, { failed: v.failed ?? [], m: v.measured }])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);

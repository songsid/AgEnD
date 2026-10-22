// #2478 item 4 (the user's report, beta.26 on iOS Safari) from defaults (fleet decision a78ebdc5), through visible UI:
// with the on-screen keyboard up, the bottom tabs (聊天/待處理/Fleet/設定) and the line under the composer (on the
// temporary public link: "臨時公開連結上無法授權…") stayed between the message box and the keyboard. Now, while a text
// field has focus and the view is shrunk by a keyboard, both go and the box sits on the keyboard; both come back on blur.
// The keyboard is emulated the way iOS Safari reports it: the viewport (innerHeight and visualViewport together) shrinks
// by 336 px after the box is tapped. Cases: phone (390×844, touch) light en on this machine; dark zh-TW over the
// temporary public link; Prism r1's boundaries: turned with the keyboard up (390×508 → 844×200 → back, still focused),
// and a desk window (a fine pointer, no on-screen keyboard) made narrow and shorter while typing — nothing hidden.
// Measured: the gap between the box's bottom and the view's bottom, the tabs and the row shown.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [LABEL=before] [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2478-keyboard.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, openPublicLink, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "2478-keyboard", LABEL = process.env.LABEL ?? "after", KEYBOARD = 336;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48824), instances: 6 });
const CHAT = "agend-dev-claude-t1519896892392083558";
// WebKit's own messages (smoke-composer-row-2215's list): a viewport key it does not know, the sheet it refuses
// under style-src 'self' for its own controls, and fetches a navigation cancels. Anything else is an error.
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = /^(Viewport argument key "interactive-widget" not recognized and ignored\.|Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.|(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/[a-z-]+|auth\/session)(\?\S*)? due to access control checks\.)/;
const pageErrors = (errors: string[]) => errors.filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.test(e)));
const r: any = { engine: ENGINE, label: LABEL, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
const MEASURE = `(() => { const box = document.querySelector("#msgIn"), tabs = document.querySelector(".tabs"), row = document.querySelector(".composer-row");
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight; const b = box ? box.getBoundingClientRect() : null;
  const shown = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0;
  return { vh: Math.round(vh), boxBottom: b ? Math.round(b.bottom) : null, gap: b ? Math.round(vh - b.bottom) : null, tabs: shown(tabs), row: shown(row),
    rowText: row ? row.textContent.trim().slice(0, 60) : null, kb: !!document.querySelector(".shell.kb-open"), focused: document.activeElement === box,
    fontPx: box ? parseFloat(getComputedStyle(box).fontSize) : null }; })()`;
let link: Awaited<ReturnType<typeof openPublicLink>> | null = null;
for (const k of [{ c: { device: "phone", theme: "light", lang: "en" }, pub: false }, { c: { device: "phone", theme: "dark", lang: "zh-TW" }, pub: true },
  { c: { device: "desk", theme: "light", lang: "en" }, pub: false, narrowDesk: true }] as const) {
  const tag = `${k.c.device}-${k.c.theme}-${k.c.lang}${k.pub ? "-public" : ""}${"narrowDesk" in k ? "-narrow-window" : ""}`, res: any = (r.cases[tag] = {});
  let p: any = null;
  try {
    if (k.pub) { link ??= await openPublicLink(fx); p = await link.publicPage(k.c as any, { path: `/ui/chat/${CHAT}` }); }
    else p = await freshPage(fx, k.c as any, { path: `/ui/chat/${CHAT}` });
    const { page } = p;
    ok(res, "mounted", await mounted(page));
    const box = page.locator("#msgIn");
    if ("narrowDesk" in k) {
      // Prism r1: a desk window (a fine pointer: no on-screen keyboard) made narrow, then shorter while typing.
      await page.setViewportSize({ width: 390, height: 844 }); await box.waitFor({ timeout: 10000 }); await page.waitForTimeout(400);
      await box.click();
      await page.setViewportSize({ width: 390, height: 844 - KEYBOARD }); await page.waitForTimeout(500);
      const shorter = await page.evaluate(MEASURE) as any;
      await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-1-shorter-window`) });
      res.measured = { shorter };
      ok(res, "narrowDesk:focused", shorter.focused);
      ok(res, "narrowDesk:noKeyboard", !shorter.kb && shorter.tabs && shorter.row, [shorter.kb, shorter.tabs, shorter.row]);
      ok(res, "noPageErrors", pageErrors(p.errors).length === 0, pageErrors(p.errors));
      await p.ctx.close();
      continue;
    }
    await box.waitFor({ timeout: 10000 }); await page.waitForTimeout(400);
    const rest = await page.evaluate(MEASURE) as any;
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-1-at-rest`) });
    await box.tap();
    await page.setViewportSize({ width: 390, height: 844 - KEYBOARD });             // the keyboard comes up
    await page.waitForTimeout(500);
    const typing = await page.evaluate(MEASURE) as any;
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-2-keyboard-up`) });
    // Prism r1: turned with the keyboard up and the box still focused, and back.
    await page.setViewportSize({ width: 844, height: 200 }); await page.waitForTimeout(500);
    const turned = await page.evaluate(MEASURE) as any;
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-2b-turned-keyboard-up`) });
    await page.setViewportSize({ width: 390, height: 844 - KEYBOARD }); await page.waitForTimeout(500);
    const turnedBack = await page.evaluate(MEASURE) as any;
    await page.evaluate(`document.activeElement && document.activeElement.blur()`);   // done typing: the keyboard goes
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const back = await page.evaluate(MEASURE) as any;
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-3-keyboard-down`) });
    res.measured = { rest, typing, turned, turnedBack, back };
    ok(res, "turned:keyboardStillUp", turned.focused && turned.kb && !turned.tabs && !turned.row, [turned.focused, turned.kb, turned.tabs, turned.row]);
    ok(res, "turnedBack:keyboardStillUp", turnedBack.kb && !turnedBack.tabs, [turnedBack.kb, turnedBack.tabs]);
    ok(res, "atRest:tabsAndRowShown", rest.tabs && rest.row, [rest.tabs, rest.row]);
    ok(res, "keyboard:focused", typing.focused);
    ok(res, "keyboard:tabsHidden", !typing.tabs);
    ok(res, "keyboard:rowHidden", !typing.row, typing.rowText);
    ok(res, "keyboard:boxOnTheKeyboard", typing.gap !== null && typing.gap <= 24, typing.gap);
    ok(res, "blur:tabsAndRowBack", back.tabs && back.row && !back.kb, [back.tabs, back.row, back.kb]);
    ok(res, "iosInputAtLeast16px", typing.fontPx >= 16, typing.fontPx);
    ok(res, "noPageErrors", pageErrors(p.errors).length === 0, pageErrors(p.errors));
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await p?.page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-error`) }).catch(() => {});
  }
  await p?.ctx.close();
}
await link?.close();
r.pass = Object.values(r.cases).every((c: any) => !c.failed);
writeFileSync(shotPath(SMOKE, `result-${LABEL}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, { failed: v.failed ?? [], m: v.measured && (v.measured.rest ? { rest: v.measured.rest.gap, typing: v.measured.typing.gap, turned: v.measured.turned?.kb, row: v.measured.typing.rowText } : v.measured) }])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);

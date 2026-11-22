// M-3244 (the user, iPhone, beta.7, Zhuyin 注音): typing with an IME (a composition open, its candidate bar up), the box was
// not on screen — the keyboard's top sat right under the chat and covered the composer; once, after changing the drawer's
// density in Settings and coming back to a chat, the view above the keyboard was empty and only the box's clipped text
// showed under it. While an IME composes, the shell's keyboard detector waited for compositionend (#2517: no tabs out and
// back on each keystroke) — and since M-3111 (#3900) the shell's height is the view's, set only from that detector, so the
// view getting shorter mid-composition (the keyboard coming up as the first key is typed, or its candidate bar) left the
// shell its old height, the whole screen or the view before the bar, with the box under the keyboard to the end of the
// composition. Now, composing, the shell follows a view that got shorter; it grows back once the IME is done.
// A real browser on the shared fixture (in-process FleetManager, scratch home, loopback only, fake agents), a phone
// (390×844, touch). No headless browser raises an on-screen keyboard: window.visualViewport is a stand-in installed before
// the app loads (as smoke-phone-kb-steady), and the composition is WebKit's events on the box. Per case, in an agent's chat:
//   1-bar     — the keyboard up (480), a composition starts and its candidate bar makes the view 436: the box stays on screen;
//               the bar going away mid-composition does not grow the shell until compositionend, and then once typing has
//               stopped (M-3265: 2 s, not per character)
//   2-rising  — the box tapped and the first key typed as the keyboard comes up (436 mid-composition): the box on screen
//   3-settings — Settings → Preferences → the drawer's density changed, back to the chat, then 2 again: the header and the box
//               both on screen
// Run it on the base too (REPO=<base checkout> SMOKE_NAME=…-before): 1-bar and 2-rising FAIL there.
// PW_ENGINE=webkit runs it in WebKit (Safari's engine).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] [PW_ENGINE=webkit] scripts/manual/smoke/run.sh smoke-phone-ime-keyboard-m3244.mts
// ui-gate: {"name": "Phone box on screen while an IME composes", "hp": 19671}
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-phone-ime-keyboard-m3244";
const WEBKIT = process.env.PW_ENGINE === "webkit";
// The stand-in visual viewport (smoke-phone-kb-steady's): the page's own size until window.__vv(height, offsetTop) moves it
// and fires what Safari fires (resize for a new height, scroll for a pan).
const FAKE_VV = `(() => {
  const t = new EventTarget();
  let set = null;
  const vv = { get width() { return innerWidth; }, get height() { return set ?? innerHeight; }, offsetTop: 0, offsetLeft: 0, pageTop: 0, scale: 1,
    addEventListener: t.addEventListener.bind(t), removeEventListener: t.removeEventListener.bind(t) };
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => vv });
  window.__vv = (height, top = 0) => {
    const resized = height !== vv.height, panned = top !== vv.offsetTop;
    set = height; vv.offsetTop = top;
    if (resized) t.dispatchEvent(new Event("resize"));
    if (panned) t.dispatchEvent(new Event("scroll"));
  };
})();`;
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49140), instances: 3 });
const name = fx.instances[1]!.name;
const chat = `/ui/chat/${encodeURIComponent(name)}`;
const cases = matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW").filter((c) => c.device === "phone");
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
try {
  for (const c of cases) {
    const failed: string[] = [];
    const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
    const p = await freshPage(fx, c, { account: "operator", path: chat, beforeNavigate: async (ctx: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f;" + FAKE_VV });
      await ctx.route("**/ui/authorization", (r: any) => r.request().method() === "GET"
        ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "verified", until: Date.now() + 3_600_000 }) }) : r.continue());
    } });
    const page = p.page;
    // WebKit reports a ResizeObserver loop it settled itself as a page error (on the base too): not the page's.
    const errs: string[] = []; page.on("pageerror", (e: any) => { const m = String(e); if (!(WEBKIT && /ResizeObserver loop completed/.test(m))) errs.push(m.slice(0, 200)); });
    // Where the box (and the chat's header) are against the view: "covered" when the box's bottom is under the view's.
    const read = () => page.evaluate(() => {
      const shell = document.querySelector(".shell") as HTMLElement, box = document.querySelector(".composer") as HTMLElement, vv = window.visualViewport!;
      const head = document.querySelector(".main .panel-head") as HTMLElement | null;
      const r = box.getBoundingClientRect(), view = vv.offsetTop + vv.height, hr = head?.getBoundingClientRect();
      return { kb: shell.classList.contains("kb-open"), shellH: shell.style.height || null, view, bottom: Math.round(r.bottom), onScreen: Math.round(r.bottom) <= view && r.top >= vv.offsetTop,
        head: hr ? { top: Math.round(hr.top), bottom: Math.round(hr.bottom) } : null };
    });
    const vv = (h: number, top = 0) => page.evaluate(([a, b]: [number, number]) => (window as any).__vv(a, b), [h, top] as [number, number]);
    const ime = (type: "compositionstart" | "compositionend") => page.evaluate((type: string) =>
      document.getElementById("msgIn")!.dispatchEvent(new CompositionEvent(type, { bubbles: true, data: type === "compositionend" ? "你" : "ㄋ" })), type);
    // Pictured with a stand-in for the keyboard (no headless browser draws one): a band from the view's bottom down, over the page.
    const shot = async (label: string) => {
      await page.evaluate(() => { const vv = window.visualViewport!, k = document.createElement("div"); k.id = "__kbd";
        k.style.cssText = `position:fixed;left:0;right:0;top:${vv.offsetTop + vv.height}px;bottom:0;background:rgba(120,120,128,.92);color:#fff;font:600 14px system-ui;display:flex;align-items:flex-start;justify-content:center;padding-top:10px;z-index:2147483647;pointer-events:none`;
        k.textContent = "keyboard (stand-in) · 注音"; document.body.append(k); });
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), label) });
      await page.evaluate(() => document.getElementById("__kbd")?.remove());
    };
    const away = async () => { await page.evaluate(() => (document.activeElement as HTMLElement)?.blur()); await vv(844); await page.waitForTimeout(1200); };
    // The first key typed as the keyboard comes up: the composition opens before the view's resize.
    const rising = async (label: string) => {
      await page.locator("#msgIn").tap(); await page.waitForTimeout(50);
      await ime("compositionstart"); await vv(436); await page.waitForTimeout(600);
      const m = await read();
      need(m.onScreen && m.shellH === "436px", `${label}: the keyboard up mid-composition, the box on screen (${JSON.stringify(m)})`);
      await shot(label);
      await ime("compositionend"); await page.waitForTimeout(600);
      const e = await read();
      need(e.kb && e.onScreen, `${label}: after compositionend, kb-open and the box on screen (${JSON.stringify(e)})`);
      return m;
    };
    try {
      need(await mounted(page, 30000), "the app mounted");
      await page.waitForSelector("#msgIn", { timeout: 20000 }); await page.waitForTimeout(800);
      // 1-bar
      await page.locator("#msgIn").tap(); await page.waitForTimeout(200);
      await vv(480); await page.waitForTimeout(1000);
      const up = await read();
      need(up.kb && up.shellH === "480px" && up.onScreen, `the keyboard up: kb-open, the shell the view's 480 px (${JSON.stringify(up)})`);
      await ime("compositionstart"); await vv(436); await page.waitForTimeout(600);   // past #4026's 300 ms hold
      const bar = await read();
      need(bar.kb && bar.shellH === "436px" && bar.onScreen, `1-bar: the candidate bar mid-composition, the box on screen (${JSON.stringify(bar)})`);
      await shot("1-bar");
      await vv(480); await page.waitForTimeout(600);
      const gone = await read();
      need(gone.shellH === "436px", `1-bar: the bar going away mid-composition grows nothing yet (${JSON.stringify(gone)})`);
      await ime("compositionend"); await page.waitForTimeout(600);
      // M-3265: the shell grows back by a bar's height only once typing has stopped (2 s after compositionend), so the next
      // character's bar finds it in place (smoke-phone-typing-steady-m3265).
      const chosen = await read();
      need(chosen.kb && chosen.shellH === "436px" && chosen.onScreen, `1-bar: just after compositionend nothing moves yet (${JSON.stringify(chosen)})`);
      await page.waitForTimeout(1800);
      const done = await read();
      need(done.kb && done.shellH === "480px" && done.onScreen, `1-bar: typing stopped, the shell is the view's 480 px (${JSON.stringify(done)})`);
      // 2-rising
      await away();
      await rising("2-rising");
      // 3-settings: Settings → Preferences, the drawer's density changed, back to the chat (in-app, no reload)
      await away();
      await page.evaluate(() => import("/assets/app-nav.js").then((m: any) => m.navigate("/settings/preferences")));
      await page.waitForSelector("#pref-density", { timeout: 15000 });
      const was = await page.locator("#pref-density").inputValue();
      await page.locator("#pref-density").selectOption(was === "compact" ? "detailed" : "compact"); await page.waitForTimeout(400);
      // Back in the app without a reload (Settings would ask about its staged change: force, as its own "Discard" does).
      await page.evaluate((to: string) => import("/assets/app-nav.js").then((m: any) => m.navigate(to, { force: true })), chat);
      await page.waitForSelector("#msgIn", { timeout: 15000 }); await page.waitForTimeout(800);
      const s = await rising("3-settings");
      need(!!s.head && s.head.top >= 0 && s.head.bottom <= s.view, `3-settings: the chat's header on screen above the box (${JSON.stringify(s.head)})`);
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
process.exit(results.length === cases.length && results.every((r) => r.ok) ? 0 : 1);

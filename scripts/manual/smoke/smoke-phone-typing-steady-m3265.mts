// M-3265 (the user, iPhone, beta.9: typing flickers again — "it keeps getting fixed and coming back"): every write the page
// makes on the shell and the box while typing, per key, on the real app (the shared fixture: in-process FleetManager,
// scratch home, loopback only, fake agents), a phone (390×844, touch), in WebKit (Safari's engine) or Chromium.
// No headless browser raises an on-screen keyboard: window.visualViewport is a stand-in installed before the app loads
// (smoke-phone-kb-steady's), and an IME is WebKit's composition events on the box around real keys. Models, the keyboard up
// (480) and settled first:
//   en        — English: real keys, each with the view reading an iOS-like sequence (the bar 44 px on/off, a pan, one
//               full-height reading) — smoke-phone-kb-steady's;
//   zhuyin    — 注音: per character, compositionstart, the candidate bar (436), three keys 150 ms apart, compositionend, the bar
//               gone (480), then a pause (PAUSE ms, default 450: a person choosing the next character);
//   zhuyin-fast — the same with a 120 ms pause;
//   bar-stays — 注音 where the candidate row stays up between characters (436 all along);
//   keys      — the user's case (iPhone, iOS 27.3, portrait, 注音, the installed app): each key while the candidates show
//               changes the candidate row, and the view with it, by a few px (compositionupdate); keys-pan: the same as a pan.
// The installed app (STANDALONE, default on): display-mode standalone matches, navigator.standalone; Chromium also gets the
// iPhone's safe area. The title bar's colour (#4033's theme-color) is counted too: it must not change while typing.
// Counted per character (or key): style writes on the shell and on #msgIn, kb-open flips, theme-color, the box's bottom moving.
// Steady typing writes nothing: a key that fits the line and a reading that comes and goes with a key move nothing; the
// first character's bar is followed once (M-3244: the box above it), and once typing stops the shell is the view again.
// Fails on #4057 (71d5e04e3) and beta.9: 注音 at a person's pace (436 → 480 on every character) and per key while candidates show
// (keys, keys-pan); on #4026's base English fails too.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [PW_ENGINE=webkit] [MODELS=en,zhuyin] npx tsx scripts/manual/smoke/smoke-phone-typing-steady-m3265.mts
// M-3705 (ui-gate flake, ad158c5f): the page's clock is the test's while it types. The app takes a reading that has held
// DOWN_HOLD_MS (300 ms) as a real change (M-3206), and a reading here lives until the next step sets another — so on a busy
// runner the CDP round trips of one step (the key, its wait, two reads) once kept key 1's bar (436) for over 300 ms, and the
// app rightly followed it (shell writes 2: 436 on key 1, 480 at settle). From the keyboard settled on, the page's timers,
// performance.now and frames run only through page.clock.runFor: each reading lives exactly the time a model gives it.
// ui-gate: {"name": "Phone typing steady per character (IME too)", "hp": 19681}
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-phone-typing-steady-m3265";
const WEBKIT = process.env.PW_ENGINE === "webkit";
const PAUSE = Number(process.env.PAUSE ?? 450);
const MEASURE_ONLY = process.env.MEASURE_ONLY === "1";
// Every style or class write on the shell and the box, with the time (a MutationObserver from the start): window.__writes().
const WRITES = `(() => {
  const seen = []; window.__writes = () => seen.splice(0);
  const watch = () => new MutationObserver((ms) => { for (const m of ms) { const t = m.target;
      if (t.tagName === "META" && t.getAttribute("name") === "theme-color" && m.attributeName === "content") { seen.push("theme-color: " + t.getAttribute("content")); continue; }
      if (t.id === "msgIn" || t.classList?.contains("shell")) {
        const now = t.getAttribute(m.attributeName);
        if (m.attributeName === "class" && t.classList?.contains("shell")) { if (now.includes("kb-open") !== (m.oldValue || "").includes("kb-open")) seen.push("shell kb-open: " + now.includes("kb-open")); }
        else if (m.attributeName === "style") seen.push((t.id || "shell") + " style: " + now);
      } } })
    .observe(document.documentElement, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["style", "class", "content"] });
  if (document.documentElement) watch(); else document.addEventListener("DOMContentLoaded", watch);
})();`;
// The user runs the installed home-screen app (standalone): display-mode standalone matches, navigator.standalone (iOS).
const STANDALONE = process.env.STANDALONE !== "0";
const STANDALONE_JS = `(() => {
  const mm = window.matchMedia.bind(window);
  window.matchMedia = (q) => /display-mode:\\s*standalone/.test(q) ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } } : mm(q);
  Object.defineProperty(navigator, "standalone", { configurable: true, get: () => true });
})();`;
const INSET = { top: 47, bottom: 34, left: 0, right: 0 };
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
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49165), instances: 3 });
const name = fx.instances[1]!.name;
const cases = matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW").filter((c) => c.device === "phone");
const MODELS = (process.env.MODELS ?? "en,zhuyin,zhuyin-fast,bar-stays,keys,keys-pan").split(",");
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
const report: Record<string, unknown> = {};
try {
  for (const c of cases) {
    for (const model of MODELS) {
      const failed: string[] = [];
      const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
      const p = await freshPage(fx, c, { account: "operator", path: `/ui/chat/${encodeURIComponent(name)}`, beforeNavigate: async (ctx: any, pg: any) => {
        await pg.clock.install();   // M-3705: real time until the keyboard has settled; paused for the typing (below)
        await ctx.addInitScript({ content: "window.__name = (f) => f;" + FAKE_VV + WRITES + (STANDALONE ? STANDALONE_JS : "") });
        // Chromium: the iPhone's safe area (an installed app draws under the status bar and over the home indicator).
        if (STANDALONE && !WEBKIT) await (await ctx.newCDPSession(pg)).send("Emulation.setSafeAreaInsetsOverride", { insets: INSET });
        await ctx.route("**/ui/authorization", (r: any) => r.request().method() === "GET"
          ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "verified", until: Date.now() + 3_600_000 }) }) : r.continue());
      } });
      const page = p.page;
      const errs: string[] = []; page.on("pageerror", (e: any) => { const m = String(e); if (!(WEBKIT && /ResizeObserver loop completed/.test(m))) errs.push(m.slice(0, 200)); });
      need(await mounted(page, 30000), "the app mounted");
      await page.waitForSelector("#msgIn", { timeout: 20000 }); await page.waitForTimeout(800);
      const bottom = () => page.evaluate(() => Math.round(document.querySelector(".composer")!.getBoundingClientRect().bottom));
      const view = () => page.evaluate(() => Math.round((window as any).visualViewport.height));
      const shellH = () => page.evaluate(() => (document.querySelector(".shell") as HTMLElement).style.height || null);
      const vv = (h: number, top = 0) => page.evaluate(([a, b]: [number, number]) => (window as any).__vv(a, b), [h, top] as [number, number]);
      const ime = (type: "compositionstart" | "compositionupdate" | "compositionend", data = "") => page.evaluate(([t, d]: [string, string]) =>
        document.getElementById("msgIn")!.dispatchEvent(new CompositionEvent(t, { bubbles: true, data: d })), [type, data] as [string, string]);
      await page.locator("#msgIn").tap(); await page.waitForTimeout(200);
      await vv(480); await page.waitForTimeout(1000);                     // the keyboard up, past the focus follow window
      // M-3705: from here the page's time moves only as the model says (the harness's own latency is never a reading's age).
      // pauseAt takes a time ahead of the page's clock (it fast-forwards to it, so never the past): 250 ms on, which only adds to
      // the settle above; a busy runner that let the page's clock pass it first is asked again.
      for (let at = 0; ; at++) {
        try { await page.clock.pauseAt(Date.now() + 250); break; }
        catch (e) { if (at >= 4 || !/fast-forward to the past/.test(String(e))) throw e; }
      }
      const tick = (ms: number) => page.clock.runFor(ms);
      await page.evaluate(() => (window as any).__writes());
      const per: Array<{ step: string; writes: string[]; moved: boolean; covered: boolean }> = [];
      let last = await bottom();
      // The box's place is read while the bar is up (`during`) and again at the step's end: covered = under the view.
      let covered = false;
      // A few px of a candidate row's own change per key is not "under" it (the box's padding); a bar's height is.
      const during = async () => { if (await bottom() > await view() + 8) covered = true; };
      const step = async (label: string, run: () => Promise<void>) => {
        covered = false;
        await run();
        const b = await bottom();
        per.push({ step: label, writes: await page.evaluate(() => (window as any).__writes()), moved: b !== last, covered }); last = b;
      };
      if (model === "en") {
        const readings: Array<[number, number]> = [[436, 0], [480, 0], [480, 12], [480, 0], [844, 0], [480, 0], [436, 0], [480, 0]];
        for (const [i, [h, top]] of readings.entries()) await step(`key ${i + 1} @${h}/${top}`, async () => { await vv(h, top); await page.keyboard.type("hello wo"[i]!); await tick(60); });
        await step("settle", async () => { await tick(600); });
      } else if (model === "keys" || model === "keys-pan") {
        // The user's iPhone (iOS 27.3, portrait, 注音): each key while the candidates show changes the candidate row, and the
        // view with it — a few px of height (keys), or of pan (keys-pan) — through compositionupdate.
        const jitter = [0, 5, -2, 3, 0, 7, 1, 4];
        for (const [c, ch] of [..."你好"].entries()) {
          await step(`char ${c + 1} bar`, async () => { await ime("compositionstart", "ㄋ"); await vv(436); await tick(150); });
          for (const [k, d] of jitter.entries()) {
            await step(`char ${c + 1} key ${k + 1}`, async () => {
              await ime("compositionupdate", "ㄋㄧ".slice(0, 1 + (k % 2)));
              if (model === "keys") await vv(436 - d); else await vv(436, Math.max(0, d));
              await page.keyboard.type("abcdefgh"[k]!); await tick(150);
              await during();
            });
          }
          await step(`char ${c + 1} chosen`, async () => { await ime("compositionend", ch); await vv(480); await tick(PAUSE); });
        }
      } else {
        const pause = model === "zhuyin-fast" ? 120 : PAUSE;
        if (model === "bar-stays") await vv(436), await tick(600), await page.evaluate(() => (window as any).__writes()), last = await bottom();
        const chars = "你好今天";
        for (const [i, ch] of [...chars].entries()) {
          await step(`char ${i + 1}`, async () => {
            await ime("compositionstart", "ㄋ");
            if (model !== "bar-stays") await vv(436);
            for (const k of "abc") { await page.keyboard.type(k); await tick(150); }
            await during();
            await ime("compositionend", ch);
            if (model !== "bar-stays") await vv(480);
            await tick(pause);
          });
        }
      }
      // Per key or character: the first character's bar is followed once (M-3244: the box above it, never under it); from the
      // second on, nothing — no write on the shell or the box, no kb-open flip, the box in its place.
      const first = model === "en" || model === "bar-stays" ? 0 : model.startsWith("keys") ? 3 : 1;   // keys: the first bar and its first two keys (#4026's 300 ms)
      const typed = per.slice(first);
      const shellWrites = typed.reduce((n, s) => n + s.writes.filter((w) => w.startsWith("shell")).length, 0);
      const boxWrites = per.reduce((n, s) => n + s.writes.filter((w) => w.startsWith("msgIn")).length, 0);
      // The installed app's title bar (#4033: theme-color follows the top surface): a change per key repaints it.
      const titleBar = per.reduce((n, s) => n + s.writes.filter((w) => w.startsWith("theme-color")).length, 0);
      need(titleBar === 0, `${model}: the installed app's title-bar colour never changes while typing (${titleBar})`);
      const moves = typed.filter((s) => s.moved).length;
      need(shellWrites === 0 && moves === 0, `${model}: past the first character, the shell and the box stay put (shell writes ${shellWrites}, box moves ${moves})`);
      need(boxWrites === 0, `${model}: keys that fit the line write no style on the box (${boxWrites})`);
      const opening = per.slice(0, first).flatMap((s) => s.writes.filter((w) => w.startsWith("shell")));
      // One move can be two records (the height, then the place): counted by the values it leaves.
      if (first) need(new Set(opening).size <= 1, `${model}: the first character's bar is followed once (${opening.join(" · ")})`);
      // Under it only for #4026's 300 ms when the first bar comes up (the opening steps), never after.
      need(typed.every((s) => !s.covered), `${model}: the box is never under the view (M-3244) (${typed.filter((s) => s.covered).map((s) => s.step).join(", ")})`);
      // Typing stopped: the shell is the view again (M-3111: no band between the box and the keyboard) — one move, at the end.
      await tick(2500);
      const rest = { shell: await shellH(), view: await view() };
      await page.clock.resume();
      need(rest.shell === `${rest.view}px`, `${model}: once typing stops, the shell is the view again (${JSON.stringify(rest)})`);
      report[`${caseName(c)}/${model}`] = { shellWrites, boxWrites, titleBar, moves, rest, steps: per.map((s) => `${s.step}: ${s.writes.length ? s.writes.join(" · ") : "—"}${s.moved ? " (moved)" : ""}${s.covered ? " (covered)" : ""}`) };
      need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), model) });
      results.push({ name: `${caseName(c)} ${model}`, ok: failed.length === 0, failed });
      await p.ctx.close();
    }
  }
} finally {
  console.log(JSON.stringify(report, null, 1));
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(MEASURE_ONLY || (results.length && results.every((r) => r.ok)) ? 0 : 1);

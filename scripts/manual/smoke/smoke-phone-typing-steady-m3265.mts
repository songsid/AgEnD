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
//   bar-stays — 注音 where the candidate row stays up between characters (436 all along).
// Counted per character (or key): style writes on the shell and on #msgIn, kb-open flips, and the box's bottom moving.
// Steady typing writes nothing: a key that fits the line and a reading that comes and goes with a key move nothing; the
// first character's bar is followed once (M-3244: the box above it), and once typing stops the shell is the view again.
// Fails on #4057 (71d5e04e3: 注音 at a person's pace, the shell 436 → 480 on every character) and on #4026's base (English too).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [PW_ENGINE=webkit] [MODELS=en,zhuyin] npx tsx scripts/manual/smoke/smoke-phone-typing-steady-m3265.mts
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-phone-typing-steady-m3265";
const WEBKIT = process.env.PW_ENGINE === "webkit";
const PAUSE = Number(process.env.PAUSE ?? 450);
const MEASURE_ONLY = process.env.MEASURE_ONLY === "1";
// Every style or class write on the shell and the box, with the time (a MutationObserver from the start): window.__writes().
const WRITES = `(() => {
  const seen = []; window.__writes = () => seen.splice(0);
  const watch = () => new MutationObserver((ms) => { for (const m of ms) { const t = m.target;
      if (t.id === "msgIn" || t.classList?.contains("shell")) {
        const now = t.getAttribute(m.attributeName);
        if (m.attributeName === "class" && t.classList?.contains("shell")) { if (now.includes("kb-open") !== (m.oldValue || "").includes("kb-open")) seen.push("shell kb-open: " + now.includes("kb-open")); }
        else if (m.attributeName === "style") seen.push((t.id || "shell") + " style: " + now);
      } } })
    .observe(document.documentElement, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["style", "class"] });
  if (document.documentElement) watch(); else document.addEventListener("DOMContentLoaded", watch);
})();`;
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
const fx = await bootFixture({ port: Number(process.env.HP ?? 49165), instances: 3 });
const name = fx.instances[1]!.name;
const cases = matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW").filter((c) => c.device === "phone");
const MODELS = (process.env.MODELS ?? "en,zhuyin,zhuyin-fast,bar-stays").split(",");
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
const report: Record<string, unknown> = {};
try {
  for (const c of cases) {
    for (const model of MODELS) {
      const failed: string[] = [];
      const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
      const p = await freshPage(fx, c, { account: "operator", path: `/ui/chat/${encodeURIComponent(name)}`, beforeNavigate: async (ctx: any) => {
        await ctx.addInitScript({ content: "window.__name = (f) => f;" + FAKE_VV + WRITES });
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
      const ime = (type: "compositionstart" | "compositionend", data = "") => page.evaluate(([t, d]: [string, string]) =>
        document.getElementById("msgIn")!.dispatchEvent(new CompositionEvent(t, { bubbles: true, data: d })), [type, data] as [string, string]);
      await page.locator("#msgIn").tap(); await page.waitForTimeout(200);
      await vv(480); await page.waitForTimeout(1000);                     // the keyboard up, past the focus follow window
      await page.evaluate(() => (window as any).__writes());
      const per: Array<{ step: string; writes: string[]; moved: boolean; covered: boolean }> = [];
      let last = await bottom();
      // The box's place is read while the bar is up (`during`) and again at the step's end: covered = under the view.
      let covered = false;
      const during = async () => { if (await bottom() > await view()) covered = true; };
      const step = async (label: string, run: () => Promise<void>) => {
        covered = false;
        await run();
        const b = await bottom();
        per.push({ step: label, writes: await page.evaluate(() => (window as any).__writes()), moved: b !== last, covered }); last = b;
      };
      if (model === "en") {
        const readings: Array<[number, number]> = [[436, 0], [480, 0], [480, 12], [480, 0], [844, 0], [480, 0], [436, 0], [480, 0]];
        for (const [i, [h, top]] of readings.entries()) await step(`key ${i + 1} @${h}/${top}`, async () => { await vv(h, top); await page.keyboard.type("hello wo"[i]!); await page.waitForTimeout(60); });
        await step("settle", async () => { await page.waitForTimeout(600); });
      } else {
        const pause = model === "zhuyin-fast" ? 120 : PAUSE;
        if (model === "bar-stays") await vv(436), await page.waitForTimeout(600), await page.evaluate(() => (window as any).__writes()), last = await bottom();
        const chars = "你好今天";
        for (const [i, ch] of [...chars].entries()) {
          await step(`char ${i + 1}`, async () => {
            await ime("compositionstart", "ㄋ");
            if (model !== "bar-stays") await vv(436);
            for (const k of "abc") { await page.keyboard.type(k); await page.waitForTimeout(150); }
            await during();
            await ime("compositionend", ch);
            if (model !== "bar-stays") await vv(480);
            await page.waitForTimeout(pause);
          });
        }
      }
      // Per key or character: the first character's bar is followed once (M-3244: the box above it, never under it); from the
      // second on, nothing — no write on the shell or the box, no kb-open flip, the box in its place.
      const first = model === "en" || model === "bar-stays" ? 0 : 1;
      const typed = per.slice(first);
      const shellWrites = typed.reduce((n, s) => n + s.writes.filter((w) => w.startsWith("shell")).length, 0);
      const boxWrites = per.reduce((n, s) => n + s.writes.filter((w) => w.startsWith("msgIn")).length, 0);
      const moves = typed.filter((s) => s.moved).length;
      need(shellWrites === 0 && moves === 0, `${model}: past the first character, the shell and the box stay put (shell writes ${shellWrites}, box moves ${moves})`);
      need(boxWrites === 0, `${model}: keys that fit the line write no style on the box (${boxWrites})`);
      if (first) need(per[0]!.writes.filter((w) => w.startsWith("shell")).length <= 1, `${model}: the first character's bar is followed once (${per[0]!.writes.join(" · ")})`);
      need(per.every((s) => !s.covered), `${model}: the box is never under the view (M-3244) (${per.filter((s) => s.covered).map((s) => s.step).join(", ")})`);
      // Typing stopped: the shell is the view again (M-3111: no band between the box and the keyboard) — one move, at the end.
      await page.waitForTimeout(2500);
      const rest = { shell: await shellH(), view: await view() };
      need(rest.shell === `${rest.view}px`, `${model}: once typing stops, the shell is the view again (${JSON.stringify(rest)})`);
      report[`${caseName(c)}/${model}`] = { shellWrites, boxWrites, moves, rest, steps: per.map((s) => `${s.step}: ${s.writes.length ? s.writes.join(" · ") : "—"}${s.moved ? " (moved)" : ""}${s.covered ? " (covered)" : ""}`) };
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

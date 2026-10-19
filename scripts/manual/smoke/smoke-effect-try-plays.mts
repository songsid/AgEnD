// #2220 from defaults (fleet decision a78ebdc5): an agent's "Try this effect" offer shows to a signed-in person and plays.
// A fresh profile signed in through the visible /signin, nothing seeded in the browser; one chat, no effects configured
// (the effects runtime asleep, #2193). The agent offers a Try (effectTools.preview, the tool's own path):
//   card    — the offer shows in the chat, leaves "checking" once the runtime woke, and has the host's Try button;
//   plays   — a trusted click on Try opens the trial panel, its Canvas Worker frame loads, and the panel's pixels move
//             (two screenshots a second apart differ inside it);
//   ends    — leaving the chat ends it (the panel and every /effect-bootstrap frame go; Stop trial sits in the panel's closed shadow root, out of reach of
//             a page locator).
// The second case opens the same chat, whose thread already holds the first offer: that wakes the runtime on open.
// No page error (the effect bootstrap's own CSP line and WebKit's own lines only).
//   PW_DIR=… REPO=… OUT=… [PW_ENGINE=webkit] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-effect-try-plays.mts
import { writeFileSync } from "node:fs";
import { addSnowEffect, bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-effect-try-plays";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
const CANCEL = /^(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/(events|poll|history|traffic)|auth\/sessions?)(\?\S*)? due to access control checks\.$/;
const FRAME_CSP = /^Unrecognized Content-Security-Policy directive 'webrtc'\. @ http:\/\/127\.0\.0\.1:\d+\/effect-bootstrap$/;
const FRAME_CSP_WEBKIT = "Unrecognized Content-Security-Policy directive 'webrtc'.\n @ ?";
const other = (errors: string[]) => errors.filter((e) => { const t = e.replace(/ @ \S+$/, ""); return !(FRAME_CSP.test(e) || ENGINE === "webkit" && (e === FRAME_CSP_WEBKIT || WEBKIT_OWN.has(t) || CANCEL.test(t))); });

const fx = await bootFixture({ port: Number(process.env.HP ?? 48760), classic: false });
const fm = fx.fm;
const NAME = fx.instances.filter((i: any) => i.status === "running" && !i.general).map((i: any) => i.name)[0];
const results: any = { engine: ENGINE, agent: NAME, cases: {} };
let failed = false;
const verdict = (name: string, ok: boolean, d: any) => { results.cases[name] = { ok, ...d }; if (!ok) failed = true; console.log(`${ok ? "ok  " : "FAIL"} ${ENGINE} ${name}: ${JSON.stringify(d).slice(0, 600)}`); };
const until = async (page: any, fn: (a: any) => boolean, arg: any, ms = 15000) => { try { await page.waitForFunction(fn, arg, { timeout: ms, polling: 100 }); return true; } catch { return false; } };
const differ = (a: Buffer, b: Buffer) => a.length !== b.length || !a.equals(b);

let first = true;
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const tag = `${c.device}-${c.theme}`;
  const p = await freshPage(fx, c as any, { reducedMotion: false });
  const page = p.page;
  await page.goto(`${p.base}/ui/chat/${encodeURIComponent(NAME)}`); await mounted(page, 30000); await page.waitForTimeout(1500);
  const asleep = await page.evaluate(`!performance.getEntriesByType("resource").some((e) => e.name.includes("/ui/js/app-effects.js"))`);
  const offered = await fm.effectTools.preview(NAME, { id: addSnowEffect(fx, { kind: "agent", id: NAME }) });
  const shown = await until(page, () => { const el = document.querySelector(".p-chat .effect-trial-offer"); return !!el && !/Checking this session|正在確認工作階段/.test(el.textContent || ""); }, null);
  const offer = await page.evaluate(`(() => { const el = document.querySelector(".p-chat .effect-trial-offer"); return el ? { text: el.textContent.replace(/\\s+/g, " ").trim().slice(0, 160), buttons: [...el.querySelectorAll("button")].map((b) => b.className) } : null; })()`);
  await page.locator(".p-chat .effect-trial-offer").scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${tag}`, "1-offer") });
  verdict(`${tag} card`, offered?.status === "offered" && (asleep || !first) && shown && !!offer && offer.buttons.length === 1 && offer.buttons[0] === "btn btn-sm effect-trial-start" && other(p.errors).length === 0,
    { offered: offered?.status ?? offered, asleep, shown, offer, errors: other(p.errors) });
  const framesBefore = page.frames().length;
  await page.click(".p-chat .effect-trial-offer button.effect-trial-start").catch(() => {});
  const panel = await until(page, () => !!document.querySelector("aside.effect-trial-panel"), null);
  let frame = false; for (let i = 0; i < 100 && !frame; i++) { frame = page.frames().some((f: any) => /\/effect-bootstrap/.test(f.url())); if (!frame) await page.waitForTimeout(100); }
  await page.waitForTimeout(1500);
  const box = await page.locator("aside.effect-trial-panel").boundingBox().catch(() => null);
  let moves = false;
  if (box) {
    const clip = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.max(1, box.width), height: Math.max(1, box.height) };
    const a = await page.screenshot({ clip }); await page.waitForTimeout(1000); const b = await page.screenshot({ clip });
    moves = differ(a, b);
    await page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${tag}`, "2-playing") });
  }
  verdict(`${tag} plays`, panel && frame && !!box && moves && other(p.errors).length === 0, { panel, frame, framesBefore, framesAfter: page.frames().length, box, moves, errors: other(p.errors) });
  const other2 = fx.instances.filter((i: any) => i.status === "running" && !i.general && i.name !== NAME)[0].name;
  await page.evaluate(`(() => { const a = document.querySelector('a[href="/ui/chat/' + encodeURIComponent(${JSON.stringify(other2)}) + '"]'); if (a) a.click(); })()`);
  const ended = await until(page, () => !document.querySelector("aside.effect-trial-panel"), null);
  // The panel AND its effect frame(s): wait (bounded) for every /effect-bootstrap frame to be gone.
  let framesLeft = -1; for (let i = 0; i < 50; i++) { framesLeft = page.frames().filter((f: any) => /\/effect-bootstrap/.test(f.url())).length; if (framesLeft === 0) break; await page.waitForTimeout(100); }
  verdict(`${tag} ends`, ended && framesLeft === 0, { ended, framesLeft });
  first = false;
  await p.ctx.close();
}
writeFileSync(shotPath(SMOKE, "results", ENGINE).replace(/\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(`${failed ? "FAIL" : "PASS"} ${ENGINE}`);
await fx.close();
process.exit(failed ? 1 : 0);

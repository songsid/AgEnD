// #2087: the end of a wheel scroll in web chat (2026-10-18 report: scrolling DOWN to the bottom, the view "re-aligns with the
// latest" once more instead of stopping). On the realistic fixture's long thread (seedChat: long Markdown, code, tables,
// photos), the reader starts well above the bottom and wheels down with real mouse.wheel steps past it. Per frame:
// scrollTop, scrollHeight, clientHeight, whether the "Latest" pill is drawn; and every scrollTop the PAGE writes (not
// the wheel), with where it came from. A screencast keeps the frames for a strip.
// Exits 1 when the page wrote a scrollTop after the reader's last wheel, or (photos already loaded) the scroll's length
// changed under them. The #2087 runs, each against main and the fix:
//   LAND=10 | LAND=-18 (100 px steps; the last lands inside the pill's 38 px) | DELTA=12 STEPS=60 WAIT=16 LAND=0 (a
//   smooth wheel) | DOCK=1 STEPS=5 REACH=1 LAND=5 (stops 5 px short, then the dock grows 40 px).
// Output: scroll-end/<case>-trace.json, the frames (scroll-end/<case>-frames/) and a summary on stdout.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> MATRIX=desk-light-en,phone-light-en npx --prefix <checkout> tsx scripts/manual/smoke/smoke-scroll-end.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootFixture, matrix, caseName, shotPath, seedChat } from "../smoke-fixture/index.mts";

const N = Number(process.env.N ?? 120), STEPS = Number(process.env.STEPS ?? 40), DELTA = Number(process.env.DELTA ?? 100);
// Where the last wheel step lands short of the bottom (px): under the 38 px the pill took is where the view was tugged.
const LAND = Number(process.env.LAND ?? 10), WAIT = Number(process.env.WAIT ?? 50);
// DELAY_IMG (ms): photos answer this late, so one finishes loading while the reader is at the bottom (a slow link).
const DELAY_IMG = Number(process.env.DELAY_IMG ?? 0), SETTLE = Number(process.env.SETTLE ?? 1500);
// DOCK=1: once the reader has stopped, the dock under the thread grows (as a working line or a prompt appears).
const DOCK = process.env.DOCK === "1";
// REACH: the share of the steps that the distance to the bottom takes (the rest press against it); 1 = stop LAND px short.
const REACH = Number(process.env.REACH ?? 0.6);
// STRIP=k: a screenshot of the thread's lower part after each of the last k wheel steps (a frame strip).
const STRIP = Number(process.env.STRIP ?? 0);
const fx = await bootFixture({ port: Number(process.env.HP ?? 48560), instances: 8 });
const name = fx.instances[1]!.name;
await seedChat(fx, [name], N);
const summary: Record<string, unknown> = {};
const failed: string[] = [];

const INSTRUMENT = `(() => {
  const sc = document.querySelector(".p-chat .scroller");
  const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  const t0 = performance.now(), frames = [], writes = [], wheels = [];
  window.__trace = { frames, writes, wheels, t0 };
  Object.defineProperty(sc, "scrollTop", { configurable: true, get() { return proto.get.call(this); }, set(v) {
    const before = proto.get.call(this); proto.set.call(this, v);
    writes.push({ t: performance.now() - t0, asked: Math.round(v), before: Math.round(before), after: Math.round(proto.get.call(this)),
      from: (new Error().stack || "").split("\\n").slice(2, 5).map(s => s.trim().replace(/^at /, "").replace(/https?:\\/\\/[^/]+/, "")).join(" < ") });
  } });
  sc.addEventListener("wheel", (e) => wheels.push({ t: performance.now() - t0, dy: e.deltaY }), { passive: true });
  const frame = () => {
    frames.push({ t: Math.round((performance.now() - t0) * 10) / 10, top: Math.round(sc.scrollTop * 10) / 10, sh: sc.scrollHeight, ch: sc.clientHeight,
      pill: !!sc.querySelector(".jump-latest") });
    if (!window.__trace.stop) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return true;
})()`;

for (const c of matrix(process.env.MATRIX ?? "desk-light-en,phone-light-en")) {
  const tag = caseName(c);
  const { ctx, page } = await fx.page(c);
  if (DELAY_IMG) await ctx.route("**/*", async (route: any) => {
    if (route.request().resourceType() === "image") await new Promise(r => setTimeout(r, DELAY_IMG));
    await route.continue().catch(() => {});
  });
  await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(name)}`);
  await page.waitForFunction((n: number) => document.querySelectorAll(".p-chat .msg").length >= n, N, { timeout: 30000 });
  await page.waitForTimeout(DELAY_IMG ? 300 : 1500);      // chunked history drawn, layout settled (photos too, unless delayed)
  // Start well above the bottom (the reader scrolled up), as the reader would leave it.
  const start = await page.evaluate(`(() => { const sc = document.querySelector(".p-chat .scroller"); sc.scrollTop = sc.scrollHeight - sc.clientHeight - ${Math.round(STEPS * REACH) * DELTA + LAND}; return sc.scrollTop; })()`);
  await page.waitForTimeout(DELAY_IMG ? 100 : 600);
  await page.screenshot({ path: shotPath("scroll-end", c, "pill") });       // scrolled up: the pill shows
  const box = await page.locator(".p-chat .scroller").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(INSTRUMENT);
  const cdp = await ctx.newCDPSession(page);
  const shots: { t: number; data: string }[] = [];
  cdp.on("Page.screencastFrame", (f: any) => { shots.push({ t: f.metadata.timestamp, data: f.data }); void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }); });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  for (let i = 0; i < STEPS; i++) {
    await page.mouse.wheel(0, DELTA); await page.waitForTimeout(WAIT);
    if (STRIP && i >= STEPS - STRIP) await page.screenshot({ path: shotPath("scroll-end", c, `step-${i}`), clip: { x: box.x, y: Math.max(box.y, box.y + box.height - 300), width: box.width, height: Math.min(300, box.height) } });
  }
  if (DOCK) {
    await page.waitForTimeout(300);
    await page.evaluate(`(() => { const d = document.createElement("div"); d.style.height = "40px"; d.className = "smoke-dock-grow"; document.querySelector(".p-chat .dock-col").prepend(d); })()`);
  }
  await page.waitForTimeout(SETTLE);
  await cdp.send("Page.stopScreencast");
  const trace: any = await page.evaluate(`(() => { window.__trace.stop = true; return window.__trace; })()`);
  await page.screenshot({ path: shotPath("scroll-end", c, "end") });
  const lastWheel = trace.wheels.length ? trace.wheels[trace.wheels.length - 1].t : 0;
  const pillFlips = trace.frames.filter((f: any, i: number) => i > 0 && f.pill !== trace.frames[i - 1].pill).map((f: any) => ({ t: f.t, pill: f.pill, sh: f.sh, top: f.top }));
  const shChanges = trace.frames.filter((f: any, i: number) => i > 0 && f.sh !== trace.frames[i - 1].sh).map((f: any) => ({ t: f.t, sh: f.sh, from: trace.frames[trace.frames.findIndex((x: any) => x === f) - 1].sh, top: f.top }));
  const out = {
    start, wheels: trace.wheels.length, lastWheel: Math.round(lastWheel),
    writes: trace.writes, writesAfterLastWheel: trace.writes.filter((w: any) => w.t > lastWheel),
    pillFlips, scrollHeightChanges: shChanges,
    end: trace.frames[trace.frames.length - 1],
  };
  summary[tag] = { writes: out.writes.length, writesAfterLastWheel: out.writesAfterLastWheel.length, pillFlips: pillFlips.length, scrollHeightChanges: shChanges.length };
  // The reader's own scroll is theirs: nothing the page writes after their last wheel, and (photos already loaded) the
  // scroll's length does not change under them — the pill showing or going takes no room.
  if (out.writesAfterLastWheel.length || (!DELAY_IMG && shChanges.length)) failed.push(tag);
  const file = shotPath("scroll-end", c, "trace").replace(/\.png$/, ".json");
  writeFileSync(file, JSON.stringify({ ...out, frames: trace.frames }, null, 1));
  const framesDir = join(dirname(file), `${tag}-frames`); mkdirSync(framesDir, { recursive: true });
  shots.forEach((s, i) => writeFileSync(join(framesDir, `${String(i).padStart(4, "0")}.png`), Buffer.from(s.data, "base64")));
  await ctx.close();
}
console.log(JSON.stringify(summary, null, 1));
if (failed.length) console.log(`FAIL: the view moved under the reader in ${failed.join(", ")}`);
await fx.close(); process.exit(failed.length ? 1 : 0);

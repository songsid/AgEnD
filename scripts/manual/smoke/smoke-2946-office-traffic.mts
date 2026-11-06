// #2946 (hxhsandy): the Office's traffic items — bigger (PROP_SCALE), slower (≥ FLIGHT.MIN_MS), a burst never a backlog
// (at most FLIGHT.MAX in the air, newest first), and the Key under the Office bar. On the shared fixture (web server only:
// no fleet, no CLI), signed in, Fleet → Org chart → Office in Cozy, Guild and School, desk and phone. Traffic is published
// as the outbox publishes it (FleetManager.publishTraffic: the SSE and the snapshot).
// Measured on the page: every fillRect the Office canvas makes in a traffic colour (the four --fx tokens, as the page
// reads them), through the live transform, grouped by frame. Checks per case:
// - one of each kind in the air: four items drawn, each at least 1.5 × 16 scene px across (scene px = device px ÷ the
//   scene's scale), still in the air 2.2 s after it was sent, gone by 6 s;
// - a burst of 30 sends: never more than FLIGHT.MAX (12) in the air in any frame, and none left 8 s after it;
// - the Key: four rows (task, message, report, broadcast) with their words in the case's language, its icons drawn;
// - reduced motion (one extra case): nothing in the air; no console errors anywhere.
// Pictures: <case>-<style>-flight (the four mid-air), <case>-<style>-key (the Key open), desk-light-en-cozy-reduced.
//   PW_DIR=… REPO=<checkout> OUT=<dir> PW_DPR=2 FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2946-office-traffic.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, labelOf, matrix, mounted, shotPath, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2946-office-traffic";
const STYLES = (process.env.STYLES ?? "cozy,guild,school").split(",");
const fx = await bootFixture({ port: Number(process.env.HP ?? 48946), classic: false, instances: 10 });
const fm = fx.fm as any;
const names = fx.instances.map((i: any) => i.name) as string[];

let seq = 0;
const row = (from: string, to: string, requestKind: string, state: string, id: string) => ({
  deliveryId: id, operationId: `op-${id}`, sourceKey: "k", sourceInstance: from, sourceDaemonBootId: "b", targetInstance: to, targetSession: null, targetDaemonBootId: null,
  // A broadcast is its row kind (src/fleet-traffic.ts trafficItem).
  kind: requestKind === "broadcast" ? "broadcast" : "fleet_inbound", correlationId: null, payload: { type: "fleet_inbound", content: "", meta: { request_kind: requestKind } }, state, attemptNo: 0, createdSeq: ++seq,
  managerBootId: null, responseDeliveredAt: null, nextAttemptAt: null, lastError: null, reconciliationPending: false });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const send = (from: string, to: string, kind: string) => fm.publishTraffic(row(from, to, kind, "delivering", `t${++n}`));

// Every traffic-coloured fillRect on the Office canvas, with its device-px box and the scene's scale, by frame.
// Plain JS text: tsx would add its __name helper to a function passed in, which the page doesn't have.
const RECORD = `(() => {
  const w = window; w.__props = []; w.__frame = 0; w.__t0 = performance.now(); let pending = false;
  // The --fx tokens are the org chart's (.oc), as the page reads them for the Office (fleet-office.js readPal).
  const fx = (el) => { const out = {}; for (const k of ["task", "send", "report", "broadcast"]) { const v = getComputedStyle(el).getPropertyValue("--fx-" + k).trim().toLowerCase(); if (v) out[v] = k; } return out; };
  let colours = null;
  const orig = CanvasRenderingContext2D.prototype.fillRect;
  CanvasRenderingContext2D.prototype.fillRect = function (x, y, ww, hh) {
    if (this.canvas && this.canvas.classList && this.canvas.classList.contains("oo-canvas")) {
      if (!colours || !Object.keys(colours).length) colours = fx(this.canvas);
      const kind = colours[String(this.fillStyle).toLowerCase()];
      if (kind) {
        if (!pending) { pending = true; queueMicrotask(function () { pending = false; w.__frame++; }); }
        const m = this.getTransform();
        w.__props.push({ frame: w.__frame, at: performance.now(), kind, x: m.a * x + m.e, y: m.d * y + m.f, w: m.a * ww, h: m.d * hh, k: m.a });
      }
    }
    return orig.call(this, x, y, ww, hh);
  };
})();`;

const results: Array<Record<string, unknown>> = [];
let failed = 0;
function record(name: string, c: Record<string, boolean>, extra: Record<string, unknown> = {}) {
  const bad = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) failed++;
  results.push({ name, ok: !bad.length, checks: c, ...extra });
  console.log(`${bad.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""} ${JSON.stringify(extra).slice(0, 600)}`);
}

/** The items drawn in each frame since `since`: clusters of traffic rects (one item's parts are within 40 device px). */
const frames = (page: any, since: number) => page.evaluate((t: number) => {
  const all = ((window as any).__props as any[]).filter((p) => p.at >= t);
  const by = new Map<number, any[]>();
  for (const p of all) { const f = by.get(p.frame) || []; f.push(p); by.set(p.frame, f); }
  return [...by.values()].map((rects) => {
    const items: any[] = [];
    for (const r of rects) {
      const near = items.find((it) => it.kind === r.kind && Math.abs(it.x0 - r.x) < 40 * Math.max(1, r.k) && Math.abs(it.y0 - r.y) < 40 * Math.max(1, r.k));
      if (near) { near.x0 = Math.min(near.x0, r.x); near.x1 = Math.max(near.x1, r.x + r.w); near.y0 = Math.min(near.y0, r.y); near.y1 = Math.max(near.y1, r.y + r.h); }
      else items.push({ kind: r.kind, x0: r.x, x1: r.x + r.w, y0: r.y, y1: r.y + r.h, k: r.k });
    }
    return { at: rects[0].at, items };
  });
}, since);
const now = (page: any) => page.evaluate(() => performance.now()) as Promise<number>;

async function openOffice(c: MatrixCase, style: string, reduced = false) {
  const { ctx, page } = await fx.page(c, { storage: { agend_org_mode: "office", agend_org_live: "1" } });
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e)));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript({ content: RECORD });
  await page.goto(`${fx.base}/ui/fleet/org`);
  if (!(await mounted(page, 30000))) throw new Error("the app did not mount");
  await page.waitForSelector(".oo-canvas", { timeout: 15000 });
  // The admin picks the style in the Office bar (the whole fleet's, kept on this scratch host: a browser's own pick
  // never overrides the host's).
  const picker = page.locator(".oo-bar select").nth(1);
  if ((await picker.inputValue()) !== style) await picker.selectOption(style);
  await page.waitForTimeout(2500);                                     // the picture style loads, everyone walks to their seat
  return { ctx, page, errors };
}

const KEY_WORDS = { en: ["Folder: a task", "Envelope: a message", "Paper: a report", "Horn: a broadcast"], "zh-TW": ["資料夾：任務", "信封：訊息", "紙張：回報", "喇叭：廣播"] };
const [A, B, C2, D] = [names[0], names[3], names[5], names[8]];

for (const c of matrix(process.env.MATRIX ?? "desk-light-en,phone-dark-zh-TW")) {
  for (const style of STYLES) {
    const { ctx, page, errors } = await openOffice(c, style);
    const chosen = await page.locator(".oo-bar select").nth(1).inputValue().catch(() => "?");
    // One of each kind, across the room.
    const t0 = await now(page);
    send(A, D, "task"); send(D, A, "send"); send(B, C2, "report"); send(C2, B, "broadcast");
    await wait(1200);
    await page.screenshot({ path: shotPath(SMOKE, c, `${style}-flight`) });
    await wait(1000);
    const at22 = (await frames(page, t0 + 2150)).at(0);
    await wait(3800);
    const late = (await frames(page, t0 + 5900)).filter((f: any) => f.items.length);
    const seen = (await frames(page, t0)).filter((f: any) => f.items.length);
    const peak = seen.reduce((m: any, f: any) => (f.items.length > (m?.items.length ?? 0) ? f : m), null);
    const kinds = [...new Set((peak?.items ?? []).map((it: any) => it.kind))].sort();
    // Scene px across: device px ÷ (the scene's scale × PROP_SCALE is inside k: k = scene scale × 1.75), so × 1.75 ÷ k.
    const widths = (peak?.items ?? []).map((it: any) => Math.round(((it.x1 - it.x0) / it.k) * 1.75 * 10) / 10);
    const cssW = (peak?.items ?? []).map((it: any) => Math.round(((it.x1 - it.x0) / Number(process.env.PW_DPR ?? 1)) * 10) / 10);
    record(`${caseName(c)} ${style} one of each`, {
      "the style is in use": chosen === style,
      "four items in the air at once": (peak?.items.length ?? 0) === 4,
      "all four kinds drawn": kinds.join(",") === "broadcast,report,send,task",
      "each at least 1.5 × 16 scene px across (the paper 1.5 × 12)": widths.every((w: number) => w >= 1.5 * 12 - 0.5),
      "still in the air 2.2 s after it was sent": (at22?.items.length ?? 0) >= 1,
      "gone by 6 s": late.length === 0,
      "no page errors": errors.length === 0,
    }, { kinds, widthsScenePx: widths, widthsCssPx: cssW, framesSeen: seen.length, errors: errors.slice(0, 3) });
    // A burst of 30.
    const t1 = await now(page);
    for (let i = 0; i < 30; i++) send(names[i % names.length], names[(i + 1 + Math.floor(i / names.length)) % names.length], "send");   // 30 distinct pairs
    await wait(8200);
    const burst = (await frames(page, t1)).filter((f: any) => f.items.length);
    const most = Math.max(0, ...burst.map((f: any) => f.items.length));
    const lastAt = burst.length ? burst[burst.length - 1].at - t1 : 0;
    record(`${caseName(c)} ${style} a burst of 30`, {
      "something flew": burst.length > 0,
      "never more than 12 in the air": most <= 12,
      "none left after 8 s (no backlog)": lastAt < 8000,
      "no page errors": errors.length === 0,
    }, { most, lastMs: Math.round(lastAt) });
    // The Key.
    await page.locator(".oo-key-btn").click();
    await page.waitForSelector(".oo-key-row", { timeout: 5000 });
    const rows = await page.locator(".oo-key-row span").allTextContents();
    const kindsKey = await page.locator(".oo-key-row").evaluateAll((els: any[]) => els.map((e) => e.getAttribute("data-kind")));
    const painted = await page.locator(".oo-key-icon").evaluateAll((els: any[]) => els.map((cv) => {
      const g = cv.getContext("2d"), d = g.getImageData(0, 0, cv.width, cv.height).data;
      let on = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) on++;
      return on;
    }));
    const btnLabel = await page.locator(".oo-key-btn").textContent();
    await page.screenshot({ path: shotPath(SMOKE, c, `${style}-key`) });
    record(`${caseName(c)} ${style} the Key`, {
      "the toggle in the case's language": btnLabel === labelOf(c, { en: "Key", zh: "圖例" }),
      "four rows in order": kindsKey.join(",") === "task,send,report,broadcast",
      "their words": JSON.stringify(rows) === JSON.stringify(KEY_WORDS[c.lang]),
      "every icon drawn": painted.length === 4 && painted.every((p: number) => p > 40),
      "no horizontal overflow": await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "no page errors": errors.length === 0,
    }, { rows, painted });
    await ctx.close();
  }
}
// Reduced motion: nothing in the air.
{
  const c = matrix("desk-light-en")[0]!;
  const { ctx, page, errors } = await openOffice(c, "cozy", true);
  const t0 = await now(page);
  send(A, D, "task"); send(D, A, "send"); send(B, C2, "report"); send(C2, B, "broadcast");
  await wait(1500);
  await page.screenshot({ path: shotPath(SMOKE, c, "cozy-reduced") });
  const seen = (await frames(page, t0)).filter((f: any) => f.items.length);
  record(`${caseName(c)} cozy reduced motion`, { "nothing in the air": seen.length === 0, "no page errors": errors.length === 0 }, { frames: seen.length });
  await ctx.close();
}
writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, "result.json"), JSON.stringify({ failed, results }, null, 2));
await fx.close();
process.exit(failed ? 1 : 0);

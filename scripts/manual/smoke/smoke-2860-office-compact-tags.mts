// #2860: in Cozy (the default style), an area with more people than seats used to show name tags (and #2761's level
// badges) on hover or focus only. Now it keeps a compact tag (smaller font, smaller plate, its badge) on everyone it
// has room for. The shared fixture (no fleet start) with ~20 members, the host's levels stubbed, Fleet → Org chart →
// Office (Cozy, whole fleet), reduced motion (a still frame).
// What the canvas actually drew is recorded in the page: every fillText of a name tag (TAG 600 10px) or compact tag
// (500 9px), its box through the live transform, grouped by synchronous draw. On the last frame: how many people have a
// readable tag, no two tag boxes overlap, and none leaves the canvas. Pictures: <case>-office, <case>-office-zoom.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf MATRIX=desk-light-en,phone-dark-zh-TW \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2860-office-compact-tags.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath, labelOf } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2860-office-compact-tags";
const N = Number(process.env.MEMBERS ?? 20);
const fx = await bootFixture({ port: Number(process.env.HP ?? 48860), classic: false, instances: N });
const fm = fx.fm as any;
const names = Object.keys(fm.fleetConfig.instances) as string[];
const LEVELS = [3, 12, 27, 40, 50, 120, 1500, 8];
fm.officeLevels = async () => Object.fromEntries(names.map((n, i) => {
  const level = LEVELS[i % LEVELS.length]!;
  return [n, { level, workTokens: level * level * 100_000, estimated: false, today: { workTokens: 1, requests: 1 }, firstSeen: "2026-09-01" }];
}));

// Every tag text the office canvas draws, with its device-pixel box, grouped by synchronous draw (one frame).
// Plain JS text: tsx would add its __name helper to a function passed in, which the page doesn't have.
const RECORD = `(() => {
  const w = window; w.__tags = []; w.__frame = 0; let pending = false;
  const orig = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
    const font = this.font;
    const kind = /^600 10px/.test(font) ? "tag" : /^500 9px/.test(font) ? "compact" : null;
    if (kind && this.canvas && this.canvas.classList && this.canvas.classList.contains("oo-canvas")) {
      if (!pending) { pending = true; queueMicrotask(function () { pending = false; w.__frame++; }); }
      const m = this.getTransform(), tw = this.measureText(text).width, h = kind === "tag" ? 10 : 9;
      const x0 = x - tw / 2, y0 = y - h / 2;
      const ax = m.a * x0 + m.c * y0 + m.e, ay = m.b * x0 + m.d * y0 + m.f;
      const bx = m.a * (x0 + tw) + m.c * (y0 + h) + m.e, by = m.b * (x0 + tw) + m.d * (y0 + h) + m.f;
      w.__tags.push({ frame: w.__frame, kind, text, x: ax, y: ay, w: bx - ax, h: by - ay, cw: this.canvas.width, ch: this.canvas.height });
    }
    return orig.call(this, text, x, y, ...rest);
  };
})();`;

const results: Array<Record<string, unknown>> = [];
let failed = 0;
function record(name: string, c: Record<string, boolean>, extra: Record<string, unknown> = {}) {
  const bad = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) failed++;
  results.push({ name, ok: !bad.length, checks: c, ...extra });
  console.log(`${bad.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""} ${JSON.stringify(extra).slice(0, 700)}`);
}
const overlap = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

for (const c of matrix(process.env.MATRIX ?? "desk-light-en,phone-dark-zh-TW")) {
  const { page, base, errors } = await freshPage(fx, c, { reducedMotion: true, beforeNavigate: async (_ctx: any, pg: any) => { await pg.addInitScript({ content: RECORD }); } } as any);
  if (!(await mounted(page, 30000))) throw new Error("the app did not mount");
  await page.goto(`${base}/ui/fleet/org`);
  if (!(await mounted(page, 30000))) throw new Error("the app did not mount");
  await page.locator(".oc-tools .seg-inline button", { hasText: labelOf(c, { en: "Office", zh: "辦公室" }) }).click();
  await page.waitForSelector(".oo-canvas", { timeout: 15000 });
  await page.waitForTimeout(2500);
  const read = async () => page.evaluate(() => {
    const w = window as any, all = w.__tags as any[];
    const last = Math.max(-1, ...all.map((t) => t.frame));
    const seen = new Map<string, any>();
    for (const t of all.filter((t) => t.frame === last)) seen.set(`${t.text}|${Math.round(t.x)}|${Math.round(t.y)}`, t);
    return { frames: last + 1, tags: [...seen.values()], people: document.querySelectorAll(".oo-desk").length };
  });
  for (const shot of ["office", "office-zoom"]) {
    if (shot === "office-zoom") { await page.locator(".oo-zoom-in").first().click().catch(() => {}); await page.waitForTimeout(800); }
    const r = await read();
    const tags = r.tags.filter((t: any) => t.w > 0);
    const pairs: string[] = [];
    for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) if (overlap(tags[i], tags[j])) pairs.push(`${tags[i].text} × ${tags[j].text}`);
    const outside = tags.filter((t: any) => t.x < 0 || t.y < 0 || t.x + t.w > t.cw + 0.5 || t.y + t.h > t.ch + 0.5).map((t: any) => t.text);
    await page.screenshot({ path: shotPath(SMOKE, c, shot) });
    const kinds = { tag: tags.filter((t: any) => t.kind === "tag").length, compact: tags.filter((t: any) => t.kind === "compact").length };
    record(`${caseName(c)} ${shot}`, {
      "a frame was drawn": r.frames > 0,
      "no two tags overlap": pairs.length === 0,
      // Zoomed in, a tag past the edge is panned out of view, not overflowing: the fit view is the check.
      ...(shot === "office" ? { "no tag leaves the canvas": outside.length === 0 } : {}),
      "no page errors": errors.length === 0,
    }, { errors: errors.slice(0, 3), people: r.people, kinds, readable: kinds.tag + kinds.compact, overlaps: pairs.slice(0, 5), outside });
  }
  await page.context().close();
}
writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, "result.json"), JSON.stringify({ failed, results }, null, 2));
await fx.close();
process.exit(failed ? 1 : 0);

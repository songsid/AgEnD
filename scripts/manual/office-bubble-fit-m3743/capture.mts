/**
 * M-3743 real-app captures (owned web fixture; no Fleet/CLI starts, accounts or external services), for one checkout (REPO):
 * run it on the release tip for "before" and on the branch for "after".
 *  (a) The Office (Cozy) with one agent calling ("Still thinking…", always shown), zoomed in and dragged so the speaker stands
 *      at the canvas's right edge, then at its left edge: its bubble's paper (#fffdf6, read from the canvas) must lie wholly
 *      inside the canvas, nothing of it on the canvas's outer 3 bitmap px, its tail's tip still at the speaker. (The top edge:
 *      the view stops at the map's top and no built-in style seats anyone near it — a pack's riders on its rim do; the unit
 *      tests draw that, tests/office-bubble-fit-m3743.test.ts.)
 *  (b) Phone: the ⋯ sheet's Talk select shows its whole value ("Pop-up window" / 「彈出視窗」).
 * Phone 390 light / dark × en / zh-TW, and the desk (light en, dark zh-TW).
 *   CHROME=<chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/office-bubble-fit-m3743/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, mounted } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [], measured: {} };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const shot = async (page: any, name: string) => {
  await page.waitForTimeout(300);
  const path = `m3743-${name}.png`;
  await page.screenshot({ path: join(OUT, path) });
  receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
};

const fx = await bootFixture({ port: 0, classic: false, host: true, roster: [
  { name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" },
  { name: "example-agent", backend: "codex", displayName: "Example helper", status: "running" },
] });
// The one caller: its bubble always shows (a call), so every frame has it.
fx.fm.getInstanceExecutionState = (name: string) => (name === "example-agent" ? "stuck" : "idle");

// In the page, as a string (tsx would wrap named helpers in __name(), which the page does not have): the speech bubbles'
// paper (#fffdf6) on the canvas, as connected pieces (a 2 px grid), each with its box and its lowest point (the tail's
// tip: where the speaker is) — in bitmap px, and the canvas's size and its CSS scale.
const PAPER = `(() => {
  const cv = document.querySelector(".oo-canvas"), W = cv.width, H = cv.height, d = cv.getContext("2d").getImageData(0, 0, W, H).data;
  const S = 1, gw = Math.ceil(W / S), gh = Math.ceil(H / S), on = new Uint8Array(gw * gh);
  for (let y = 0; y < H; y += S) for (let x = 0; x < W; x += S) { const i = (y * W + x) * 4; if (d[i] === 255 && d[i + 1] === 253 && d[i + 2] === 246) on[(y / S) * gw + x / S] = 1; }
  const seen = new Uint8Array(gw * gh), pieces = [];
  for (let s = 0; s < on.length; s++) {
    if (!on[s] || seen[s]) continue;
    const st = [s]; seen[s] = 1; let l = 1e9, r = -1, t = 1e9, b = -1, tip = null, n = 0;
    while (st.length) { const c = st.pop(), cx = c % gw, cy = (c - cx) / gw; n++;
      l = Math.min(l, cx); r = Math.max(r, cx); t = Math.min(t, cy); if (cy > b) { b = cy; tip = { x: cx * S, y: cy * S }; }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue; const k = ny * gw + nx; if (on[k] && !seen[k]) { seen[k] = 1; st.push(k); } } }
    if (n >= 12) pieces.push({ l: l * S, r: r * S + S - 1, t: t * S, b: b * S + S - 1, tip, n });
  }
  // On the canvas's outer 3 px: any paper there is a bubble cut by the edge.
  let edge = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (x > 2 && x < W - 3 && y > 2 && y < H - 3) { x = W - 4; continue; } const i = (y * W + x) * 4; if (d[i] === 255 && d[i + 1] === 253 && d[i + 2] === 246) edge++; }
  const r = cv.getBoundingClientRect();
  return { W, H, scale: W / r.width, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, pieces, edge };
})()`;
/** The caller's bubble: the biggest piece (the paper of its box and tail). */
const caller = (m: any) => [...m.pieces].sort((a: any, b: any) => b.n - a.n)[0] ?? null;

/** Drag the scene by (dx, dy) CSS px, from a spot on the canvas the move keeps on it. */
async function drag(page: any, m: any, dx: number, dy: number) {
  const fromX = dx > 0 ? m.rect.left + 30 : m.rect.left + m.rect.width - 30, fromY = dy > 0 ? m.rect.top + 30 : m.rect.top + m.rect.height - 30;
  await page.mouse.move(fromX, fromY); await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(fromX + (dx * i) / 12, fromY + (dy * i) / 12);
  await page.mouse.up();
  await page.waitForTimeout(700);
}
/** The caller's bubble's tail tip (the speaker) in CSS px on the page; null when no bubble is found. */
const tipOf = (m: any) => { const c = caller(m); return c ? { x: m.rect.left + c.tip.x / m.scale, y: m.rect.top + c.tip.y / m.scale, c } : null; };
/** The bubble brought whole to the canvas's middle (its tail tip then is the speaker). */
async function centre(page: any) {
  for (let i = 0; i < 3; i++) {
    const m = await page.evaluate(PAPER) as any, t = tipOf(m);
    if (!t) return null;
    const dx = m.rect.left + m.rect.width / 2 - t.x, dy = m.rect.top + m.rect.height / 2 - t.y;
    if (Math.abs(dx) < 30 && Math.abs(dy) < 30) return t;
    await drag(page, m, dx, dy);
  }
  return tipOf(await page.evaluate(PAPER) as any);
}
/** From the middle: the speaker dragged to 14 CSS px from the canvas's right or left edge. */
async function toEdge(page: any, where: "right" | "left") {
  const t = await centre(page);
  if (!t) return null;
  const m = await page.evaluate(PAPER) as any;
  const to = { x: where === "right" ? m.rect.left + m.rect.width - 14 : m.rect.left + 14, y: t.y };
  await drag(page, m, to.x - t.x, to.y - t.y);
  return { from: { x: Math.round(t.x), y: Math.round(t.y) }, to: { x: Math.round(to.x), y: Math.round(to.y) } };
}

try {
  for (const c of matrix("phone-light-en,phone-dark-en,phone-light-zh-TW,phone-dark-zh-TW,desk-light-en,desk-dark-zh-TW")) {
    const tag = caseName(c), zh = c.lang === "zh-TW", phone = c.device === "phone";
    const { page, ctx } = await fx.page(c, { path: "/ui/fleet/org", storage: { agend_org_mode: "office", agend_org_office_skin: "cozy" } });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      check(`${tag}: mounted`, await mounted(page, 30000));
      await page.locator(".oo-canvas").waitFor();
      await page.waitForTimeout(2500);
      const m0 = await page.evaluate(PAPER) as any;
      check(`${tag}: the caller's bubble is drawn`, !!caller(m0), m0.pieces.length);
      await shot(page, `${tag}-0-fit`);
      // Zoomed in about the speaker (the wheel zooms about the pointer), so it can be dragged to any edge of the canvas.
      const t0 = tipOf(m0);
      if (t0) { await page.mouse.move(t0.x, t0.y); for (let i = 0; i < (phone ? 10 : 14); i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(120); } }
      await page.waitForTimeout(600);
      receipt.measured[`${tag}-zoom`] = await page.evaluate(`document.querySelector(".oo-zoom-pct")?.textContent || ""`);
      for (const where of ["right", "left"] as const) {
        const moved = await toEdge(page, where);
        const m = await page.evaluate(PAPER) as any, b = caller(m);
        receipt.measured[`${tag}-${where}`] = { moved, canvas: { W: m.W, H: m.H }, bubble: b, edgePaper: m.edge };
        // Where the speaker is now: where the drag put it (the scene moves with the pointer, unless the view stops at the map's edge).
        const tipAt = b ? { x: m.rect.left + b.tip.x / m.scale, y: m.rect.top + b.tip.y / m.scale } : null;
        const atEdge = !!tipAt && !!moved && (where === "right" ? tipAt.x >= m.rect.left + m.rect.width - 24 : tipAt.x <= m.rect.left + 24);
        check(`${tag} ${where}: the speaker is at the canvas's ${where} edge`, atEdge, { tipAt, moved });
        check(`${tag} ${where}: no bubble paper on the canvas's outer 3 px (nothing cut by the edge)`, m.edge === 0, m.edge);
        check(`${tag} ${where}: the bubble wholly inside the canvas, 4 px or more in`, !!b && b.l >= 4 && b.t >= 4 && b.r <= m.W - 5 && b.b <= m.H - 5, b);
        await shot(page, `${tag}-${where === "right" ? 1 : 2}-${where}`);
      }
      if (phone) {
        await page.locator(".oo-more-btn").click();
        await page.locator(".oo-sheet .oo-talk-mode").waitFor();
        await page.evaluate(`document.querySelector(".oo-sheet .oo-talk-mode")?.scrollIntoView({ block: "center" })`);
        const sel = await page.evaluate(`(() => {
          const s = document.querySelector(".oo-sheet .oo-talk-mode"), cs = getComputedStyle(s), opt = s.options[s.selectedIndex];
          const g = document.createElement("canvas").getContext("2d"); g.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
          const room = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          return { value: s.value, text: opt ? opt.text : "", textW: Math.ceil(g.measureText(opt ? opt.text : "").width), room: Math.floor(room), width: Math.round(s.getBoundingClientRect().width),
            maxWidth: cs.maxWidth, h: Math.round(s.getBoundingClientRect().height), row: Math.round(s.closest(".oo-pick").getBoundingClientRect().width) };
        })()`) as any;
        receipt.measured[`${tag}-talk-select`] = sel;
        // The room for its text: its box less its padding and the native ▼ (about 20 px: 24 kept).
        check(`${tag}: the Talk select shows "${sel.text}" whole (text ${sel.textW} px ≤ room ${sel.room - 24} px)`, sel.text === (zh ? "彈出視窗" : "Pop-up window") && sel.textW <= sel.room - 24, sel);
        check(`${tag}: the Talk select is a 44 px box`, sel.h >= 44, sel);
        await shot(page, `${tag}-3-sheet`);
      }
      check(`${tag}: no page errors`, errors.length === 0, errors);
    } finally { await ctx.close(); }
  }
} finally {
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}

// M-3267 (the user, 11-17: 「引用給 agent 沒有辦法縮放圖再開始畫」): zoom and pan the annotate editor's picture before
// drawing, in a real headless Chromium on the shared smoke fixture (in-process FleetManager, scratch home, loopback, the
// agent a stub at the IPC boundary — no CLI, tmux, vendor or account). Per case (desk-light-en, phone-dark-zh-TW):
//   1. the editor opens fitted;
//   2. zoom in: a desk's wheel over the picture (at the cursor), a phone's two-finger pinch (CDP touch) — the picture
//      grows on screen, the canvas keeps its own pixels (1200 × 800);
//   3. draw a box while zoomed, aimed at picture pixels (800…1000, 150…300): the canvas has red at the box's edge there
//      and nothing at a pixel outside it — a mark lands where it was drawn, in the picture's own pixels;
//   4. a pan: a desk's Space + drag, a phone's hand mode + one finger — the picture moves, no mark is added;
//   5. Fit: back to the whole picture; the box is still where it was drawn; quote → the upload is a 1200 × 800 PNG;
//   no page error, no CSP report. LABEL=before|after names the shots (a "before" run on the base shows no zoom).
//   PW_DIR=… REPO=<checkout> OUT=<dir> [LABEL=after] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx tsx scripts/manual/smoke/smoke-annotate-zoom-m3267.mts
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import type { MatrixCase } from "../smoke-fixture/index.mts";

// Isolated like smoke-classic-room-account-2909: scratch HOME, guard binaries for every CLI and tmux; no fleet start.
const owned = mkdtempSync(join(tmpdir(), "agend-3267-smoke-")), home = join(owned, "home"), bin = join(owned, "bin");
for (const p of [home, bin, join(home, ".claude"), join(home, ".codex"), join(owned, "tmux"), join(home, ".local", "share")]) mkdirSync(p, { recursive: true });
const realFonts = join(process.env.HOME ?? "", ".local", "share", "fonts");
if (existsSync(realFonts)) symlinkSync(realFonts, join(home, ".local", "share", "fonts"));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(process.env.HOME ?? "", ".cache", "ms-playwright");
Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), TMUX_TMPDIR: join(owned, "tmux") });
const guard = `#!${process.execPath}\nprocess.exit(97);\n`;
for (const n of ["claude", "tmux", "codex", "kiro-cli", "agend-private-tmux"]) { writeFileSync(join(bin, n), guard); chmodSync(join(bin, n), 0o755); }
process.env.PATH = [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
process.env.AGEND_TMUX_BIN = join(bin, "agend-private-tmux");
const { bootFixture, caseName, matrix } = await import("../smoke-fixture/index.mts");

const REPO = process.env.REPO ?? process.cwd();
const LABEL = process.env.LABEL ?? "after";
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", "annotate-zoom-m3267");
mkdirSync(OUT, { recursive: true });
const r: Record<string, unknown> = { label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A PNG of w×h: a light gradient with a dark band, so marks on it are visible in a screenshot. */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3, band = y > h * 0.45 && y < h * 0.55 ? 0.35 : 1;
    raw[o] = (200 + (x * 40) / w) * band; raw[o + 1] = (210 + (y * 30) / h) * band; raw[o + 2] = 230 * band;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const fx = await bootFixture({ port: Number(process.env.GATE_PORT ?? 48932), instances: 3 });
const fm = fx.fm;
const A = fx.instances.filter((i: any) => !i.general).map((i: any) => i.name)[0]!;
const delivered: unknown[] = [];
fm.instanceIpcClients.set(A, { connected: true, send(payload: unknown) { delivered.push(payload); return true; } });
fm.getInstanceStatus = () => "running";
const { publicAttachment } = await import(join(REPO, "src/web-upload.ts"));
const original = join(fx.dir, "screen.png");
writeFileSync(original, png(1200, 800));
const originalSha = sha(readFileSync(original));
const att = publicAttachment(fm.webFiles.registerServed({ path: original, instance: A, name: "screen.png", mime: "image/png", kind: "photo" }));
fm.emitSseEvent("message", { instance: A, sender: A, role: "agent", text: "Here is the screen", ts: new Date().toISOString(), attachments: [att] });

/** The canvas: its pixel size, its box on screen, and whether picture pixel (x, y) is the box's red (#e5484d). */
const STATE = `(() => { const c = document.querySelector("dialog.lb .an-canvas"); if (!c) return null; const b = c.getBoundingClientRect();
  const px = (x, y) => Array.from(c.getContext("2d").getImageData(x, y, 1, 1).data);
  return { w: c.width, h: c.height, box: { x: b.x, y: b.y, w: b.width, h: b.height }, edge: px(800, 225), inside: px(900, 225), outside: px(700, 225), far: px(100, 700) }; })()`;
const after2 = (page: any) => page.evaluate(`new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(d)))`);
const isRed = (p: number[]) => !!p && p[0]! > 200 && p[1]! < 120 && p[2]! < 120;
/** Screen point of picture pixel (ix, iy), from the canvas's box as shown now (its transform included). */
const screenOf = (s: any, ix: number, iy: number) => ({ x: s.box.x + (ix / s.w) * s.box.w, y: s.box.y + (iy / s.h) * s.box.h });
async function touch(cdp: any, type: string, pts: { x: number; y: number }[]) {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, i) => ({ ...p, id: i })) });
}

try {
  const cases = (matrix("quick") as MatrixCase[]);
  for (const c of cases) {
    const cn = caseName(c), phone = c.device === "phone";
    const res: Record<string, unknown> = (r[cn] = {});
    const { ctx, page, csp } = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(A)}` });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const uploads: Buffer[] = [];
    await page.route("**/ui/upload**", async (route: any) => { uploads.push(route.request().postDataBuffer() ?? Buffer.alloc(0)); await route.continue(); });
    const cdp = phone ? await ctx.newCDPSession(page) : null;
    const shot = (n: string) => page.screenshot({ path: join(OUT, `${LABEL}-${cn}-${n}.png`) });
    await page.locator("#msgIn").waitFor({ timeout: 20000 });
    const thumb = page.locator(".msg.agent .att-img").last();
    await thumb.waitFor({ timeout: 20000 });
    if (phone) await thumb.tap(); else await thumb.click();
    await page.locator("dialog.lb .lb-annotate").click();
    await page.locator("dialog.lb .an-canvas").waitFor({ timeout: 10000 });
    await page.waitForTimeout(400);
    const fit = await page.evaluate(STATE);
    res.fit = fit.box;
    // The bar's rows (its controls' distinct tops), and every control on screen.
    res.bar = await page.evaluate(`(() => { const els = [...document.querySelectorAll("dialog.lb .an-bar > *")].filter((e) => e.getClientRects().length);
      const mids = els.map((e) => { const b = e.getBoundingClientRect(); return b.top + b.height / 2; }).sort((a, b) => a - b); const tops = { size: mids.filter((m, i) => i === 0 || m - mids[i - 1] > 12).length }; const where = els.map((e) => e.className.split(" ")[0] + "@" + Math.round(e.getBoundingClientRect().top)); const vw = innerWidth;
      const off = [...document.querySelectorAll("dialog.lb .an button")].filter((b) => b.getClientRects().length && (b.getBoundingClientRect().right > vw + 0.5 || b.getBoundingClientRect().left < -0.5)).map((b) => b.className);
      return { rows: tops.size, off, where }; })()`);
    check(`${cn}:bar`, (res.bar as any).off.length === 0 && (res.bar as any).rows <= (phone ? 3 : 1), res.bar);
    await shot("1-fit");
    // 2. Zoom in.
    const at = screenOf(fit, 900, 225);
    if (phone) {
      const a = { x: at.x - 30, y: at.y }, b = { x: at.x + 30, y: at.y };
      await touch(cdp, "touchStart", [a]); await touch(cdp, "touchStart", [a, b]);
      for (let i = 1; i <= 10; i++) await touch(cdp, "touchMove", [{ x: a.x - 9 * i, y: a.y }, { x: b.x + 9 * i, y: b.y }]);
      await touch(cdp, "touchEnd", []);
    } else {
      await page.mouse.move(at.x, at.y);
      for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(40); }
    }
    await after2(page); await page.waitForTimeout(200);
    const zoomed = await page.evaluate(STATE);
    res.zoomed = zoomed.box;
    const grew = zoomed.box.w > fit.box.w * 1.5;
    check(`${cn}:zoomed`, grew && zoomed.w === 1200 && zoomed.h === 800, { fit: fit.box, zoomed: zoomed.box });
    // The pinch's first finger never left a mark.
    check(`${cn}:noStrayMark`, !isRed(zoomed.far) && !isRed(zoomed.inside), { far: zoomed.far, inside: zoomed.inside });
    await shot("2-zoomed");
    // 3. A box while zoomed, aimed at picture pixels (800, 150) → (1000, 300).
    await page.locator("dialog.lb .an-tool-box").click();
    const p0 = screenOf(zoomed, 800, 150), p1 = screenOf(zoomed, 1000, 300);
    if (phone) {
      await touch(cdp, "touchStart", [p0]);
      for (let i = 1; i <= 8; i++) await touch(cdp, "touchMove", [{ x: p0.x + ((p1.x - p0.x) * i) / 8, y: p0.y + ((p1.y - p0.y) * i) / 8 }]);
      await touch(cdp, "touchEnd", []);
    } else {
      await page.mouse.move(p0.x, p0.y); await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(p0.x + ((p1.x - p0.x) * i) / 8, p0.y + ((p1.y - p0.y) * i) / 8);
      await page.mouse.up();
    }
    await after2(page);
    const drawn = await page.evaluate(STATE);
    check(`${cn}:landed`, isRed(drawn.edge) && !isRed(drawn.inside) && !isRed(drawn.outside), { edge: drawn.edge, inside: drawn.inside, outside: drawn.outside });
    await shot("3-drawn-zoomed");
    // 4. Pan without drawing.
    const hand = page.locator("dialog.lb .an-hand");
    const mid = { x: drawn.box.x + drawn.box.w / 2, y: drawn.box.y + drawn.box.h / 2 };
    const vp = page.viewportSize()!, from = { x: vp.width / 2, y: vp.height / 2 }, to = { x: vp.width / 2 + 80, y: vp.height / 2 + 40 };
    void mid;
    if (phone) {
      if (await hand.count()) await hand.click();
      await touch(cdp, "touchStart", [from]);
      for (let i = 1; i <= 8; i++) await touch(cdp, "touchMove", [{ x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 }]);
      await touch(cdp, "touchEnd", []);
      if (await hand.count()) await hand.click();
    } else {
      await page.keyboard.down("Space");
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
      await page.mouse.up(); await page.keyboard.up("Space");
    }
    await after2(page);
    const panned = await page.evaluate(STATE);
    const moved = Math.hypot(panned.box.x - drawn.box.x, panned.box.y - drawn.box.y);
    check(`${cn}:panned`, moved > 20, { before: drawn.box, after: panned.box });
    const hist = await page.locator("dialog.lb .an-undo").isDisabled().catch(() => null);
    check(`${cn}:panNoMark`, isRed(panned.edge) && !isRed(panned.far), { edge: panned.edge, far: panned.far, undoDisabled: hist });
    await shot("4-panned");
    // 5. Fit, then quote.
    const fitBtn = page.locator("dialog.lb .an-zoom-fit");
    if (await fitBtn.count()) await fitBtn.click();
    await after2(page); await page.waitForTimeout(200);
    const back = await page.evaluate(STATE);
    check(`${cn}:fitAgain`, Math.abs(back.box.w - fit.box.w) < 1 && Math.abs(back.box.x - fit.box.x) < 1 && isRed(back.edge), { fit: fit.box, back: back.box });
    await shot("5-fit-again");
    await page.locator('dialog.lb .an-quote[data-target="self"]').click();
    await page.locator("dialog.lb").waitFor({ state: "detached", timeout: 10000 });
    await page.locator("#msgIn").fill("box");
    await page.locator("#sendBtn").click();
    await page.waitForTimeout(1200);
    const up = uploads.at(-1) ?? Buffer.alloc(0);
    const isPng = up.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    check(`${cn}:upload`, isPng && up.readUInt32BE(16) === 1200 && up.readUInt32BE(20) === 800, { isPng, len: up.length });
    check(`${cn}:original`, sha(readFileSync(original)) === originalSha);
    check(`${cn}:noErrors`, errs.length === 0 && (await csp()).length === 0, { errs, csp: await csp() });
    await ctx.close();
  }
} catch (e) {
  fail.push("threw"); r.threw = String(e).slice(0, 400);
} finally {
  writeFileSync(join(OUT, `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "PASS");
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}

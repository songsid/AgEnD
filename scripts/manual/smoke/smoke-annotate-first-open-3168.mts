import { publicRoster } from "../smoke-fixture/public-roster.mts";
// M-3168: the first 「標註」 on a chat image paints the editor in its final layout — no frame of the bare editor (the
// picture at the far left, no tool bar) while its stylesheet arrives — and a page that never annotates loads none of it.
// Real headless Chrome on the shared smoke fixture (the product's own web server, scratch home, loopback only; no CLI).
// The stylesheet is held back DELAY ms (default 700) so its late arrival is deterministic; the user's host showed it at
// ordinary speed. Per case (desk-light-en, phone-dark-zh-TW), a fresh browser context (nothing cached):
//   1. load the chat, open the viewer: no request for image-annotate.js/.css (nothing loaded for a page that never annotates);
//   2. press 「標註」: every animation frame for 2.5 s records the editor's canvas box and tool bar colour; screenshots are
//      taken at 100, 400 and 1000 ms. PASS: from the first frame the editor exists, the bar is drawn
//      (not transparent) and the canvas does not move;
//   3. Esc, then 「標註」 again: the same.
// BEFORE=1 serves the base ref's viewer and editor (BASE_REF, default origin/release/2.3.5-alpha) instead, to capture the bug.
//   PW_DIR=… REPO=… OUT=… [BEFORE=1] [DELAY=700] npx tsx scripts/manual/smoke/smoke-annotate-first-open-3168.mts
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import type { MatrixCase } from "../smoke-fixture/index.mts";

const owned = mkdtempSync(join(tmpdir(), "agend-3168-smoke-")), home = join(owned, "home"), bin = join(owned, "bin");
for (const p of [home, bin, join(home, ".claude"), join(home, ".codex"), join(owned, "tmux"), join(home, ".local", "share")]) mkdirSync(p, { recursive: true });
const realFonts = join(process.env.HOME ?? "", ".local", "share", "fonts");
if (existsSync(realFonts)) symlinkSync(realFonts, join(home, ".local", "share", "fonts"));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(process.env.HOME ?? "", ".cache", "ms-playwright");
// Keep caller HOME/CODEX_HOME intact; bootFixture isolates AGEND_HOME and guarded binaries prevent native launches.
Object.assign(process.env, { CLAUDE_CONFIG_DIR: join(home, ".claude"), TMUX_TMPDIR: join(owned, "tmux") });
const guard = `#!${process.execPath}\nprocess.exit(97);\n`;
for (const n of ["claude", "tmux", "codex", "kiro-cli", "agend-private-tmux"]) { writeFileSync(join(bin, n), guard); chmodSync(join(bin, n), 0o755); }
process.env.PATH = [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
process.env.AGEND_TMUX_BIN = join(bin, "agend-private-tmux");
const { bootFixture, caseName } = await import("../smoke-fixture/index.mts");

const REPO = process.env.REPO ?? process.cwd();
const BEFORE = process.env.BEFORE === "1", BASE_REF = process.env.BASE_REF ?? "origin/release/2.3.5-alpha";
const DELAY = Number(process.env.DELAY ?? 700);
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", "annotate-first-open-3168", BEFORE ? "before" : "after");
mkdirSync(OUT, { recursive: true });
const r: Record<string, unknown> = { mode: BEFORE ? `before (${BASE_REF})` : "after (this checkout)", delayMs: DELAY };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const old = (path: string) => execFileSync("git", ["-C", REPO, "show", `${BASE_REF}:${path}`], { encoding: "utf8", maxBuffer: 16 << 20 });

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

const fx = await bootFixture({ classic: false, roster: publicRoster(2), port: Number(process.env.GATE_PORT ?? 48913), instances: 2 });
const fm = fx.fm;
const A = fx.instances.filter((i: any) => !i.general)[0]!.name;
fm.instanceIpcClients.set(A, { connected: true, send() { return true; } });
fm.getInstanceStatus = () => "running";
const { publicAttachment } = await import(join(REPO, "src/web-upload.ts"));
const original = join(fx.dir, "screen.png"); writeFileSync(original, png(1200, 800));
const att = publicAttachment(fm.webFiles.registerServed({ path: original, instance: A, name: "screen.png", mime: "image/png", kind: "photo" }));
fm.emitSseEvent("message", { instance: A, sender: A, role: "agent", text: "Here is the screen", ts: new Date().toISOString(), attachments: [att] });

/** Every animation frame for `ms`: the editor's canvas box and bar colour (null until the editor exists). */
const SAMPLE = (ms: number) => `new Promise((done) => { const out = [], t0 = performance.now();
  const tick = () => { const an = document.querySelector("dialog.lb .an"), c = document.querySelector("dialog.lb .an-canvas"), bar = document.querySelector("dialog.lb .an-bar");
    if (an) { const b = c ? c.getBoundingClientRect() : null; out.push({ t: Math.round(performance.now() - t0), x: b ? Math.round(b.x) : null, w: b ? Math.round(b.width) : null,
      bar: bar ? getComputedStyle(bar).backgroundColor : null, css: !!document.querySelector('link[data-annotate-css="1"]')?.sheet }); }
    if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick); else done(out); };
  requestAnimationFrame(tick); })`;
const TRANSPARENT = "rgba(0, 0, 0, 0)";
const judge = (s: any[]) => {
  const drawn = s.filter((f) => f.x !== null);
  const bare = s.filter((f) => !f.bar || f.bar === TRANSPARENT);
  const xs = [...new Set(drawn.map((f) => f.x))];
  return { ok: s.length > 0 && bare.length === 0 && xs.length === 1, frames: s.length, bareFrames: bare.length, canvasX: xs, first: s[0], last: s.at(-1) };
};

try {
  const cases: MatrixCase[] = [{ device: "desk", theme: "light", lang: "en" } as MatrixCase, { device: "phone", theme: "dark", lang: "zh-TW" } as MatrixCase];
  for (const c of cases) {
    const cn = caseName(c), phone = c.device === "phone";
    const { ctx, page } = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(A)}` });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const asked: string[] = []; page.on("request", (q: any) => { if (/image-annotate\.(js|css)/.test(q.url())) asked.push(new URL(q.url()).pathname); });
    if (BEFORE) for (const f of ["image-lightbox.js", "image-annotate.js"]) {
      const body = old(`src/ui/shared/${f}`);
      await page.route(`**/assets/${f}`, (route: any) => route.fulfill({ status: 200, contentType: "application/javascript", body }));
    }
    await page.route("**/assets/image-annotate.css*", async (route: any) => { await new Promise((ok) => setTimeout(ok, DELAY)); await route.continue(); });
    await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(A)}`);
    await page.locator("#msgIn").waitFor({ timeout: 20000 });
    const thumb = page.locator(".msg.agent .att-img").last(); await thumb.waitFor({ timeout: 20000 });
    if (phone) await thumb.tap(); else await thumb.click();
    await page.locator("dialog.lb .lb-annotate").waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    check(`${cn}:noLoadUntilAnnotate`, asked.length === 0, asked);
    for (const round of ["first", "second"]) {
      const sampling = page.evaluate(SAMPLE(2500));
      await page.locator("dialog.lb .lb-annotate").click();
      const t0 = Date.now();
      for (const at of [100, 400, 1000]) {           // before / around / after the held stylesheet arrives
        await page.waitForTimeout(Math.max(0, at - (Date.now() - t0)));
        await page.screenshot({ path: join(OUT, `${cn}-${round}-${at}ms.png`) });
      }
      const samples = await sampling;
      const v = judge(samples);
      check(`${cn}:${round}OpenFinalLayout`, v.ok, v);
      r[`${cn}:${round}:samples`] = samples.filter((_: any, i: number) => i < 3 || i === samples.length - 1);
      await page.keyboard.press("Escape");
      await page.locator("dialog.lb").waitFor({ state: "detached", timeout: 5000 });
      if (round === "first") { if (phone) await thumb.tap(); else await thumb.click(); await page.locator("dialog.lb .lb-annotate").waitFor({ timeout: 10000 }); }
    }
    check(`${cn}:noPageError`, errs.length === 0, errs);
    await ctx.close();
  }
} finally {
  await fx.close?.();
}
writeFileSync(join(OUT, "receipt.json"), JSON.stringify({ ...r, fail }, null, 2));
console.log(JSON.stringify({ mode: r.mode, fail }, null, 1));
process.exit(fail.length ? 1 : 0);

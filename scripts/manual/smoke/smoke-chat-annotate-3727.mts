// #3727 (M-2973): annotate a chat image and quote it to the agent, in a real headless Chrome on the shared smoke fixture
// (the product's own web server from an in-process FleetManager, a scratch home, loopback only; the agent is a stub at
// the IPC boundary — no CLI, tmux, vendor or account). Per case (MATRIX=quick, the default: desk-light-en and
// phone-dark-zh-TW; MATRIX=full: all eight device × theme × language): an agent message with a real served PNG (made here) →
//   1. the viewer has 「標註」; it opens the editor on the picture;
//   2. pen (a mouse drag; on a phone a finger drag through CDP touch events), box, arrow, a colour change, text (T, a
//      click, typed, Enter); undo then redo; the canvas pixels changed where drawn;
//   3. 「引用給 Agent」: the viewer closes; the composer holds ONE new attachment <name>-annotated.png and the reply bar
//      names the original message;
//   4. send: /ui/upload carries a PNG (its magic bytes) of the canvas size; /ui/send carries that attachment and
//      replyTo = the original message; the agent's IPC delivery carries both; the original file is byte-identical
//      (its sha256 on disk, and as served) before and after;
//   5. Esc in the editor closes it with nothing added;
//   6. desktop: split chat — the other pane's 「引用到 B」 puts the PNG in B's composer and a quote line in B's draft;
//   7. SKEW: the previous image-lightbox.js (BASE_REF) with this server: no 「標註」, the viewer works; this viewer with
//      image-annotate.js missing (404): a notice, the viewer stays, no page error;
//   no page error, no CSP report.
//   PW_DIR=<playwright-core dir> REPO=<checkout> OUT=<dir> [MATRIX=full] [BASE_REF=origin/release/2.3.5-alpha] \
//   FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-chat-annotate-3727.mts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import type { MatrixCase } from "../smoke-fixture/index.mts";

// Isolated like smoke-classic-room-account-2909: scratch HOME, guard binaries for every CLI and tmux; no fleet start.
const owned = mkdtempSync(join(tmpdir(), "agend-3727-smoke-")), home = join(owned, "home"), bin = join(owned, "bin");
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
const BASE_REF = process.env.BASE_REF ?? "origin/release/2.3.5-alpha";
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", "chat-annotate-3727");
mkdirSync(OUT, { recursive: true });
const r: Record<string, unknown> = { base: BASE_REF };
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

const fx = await bootFixture({ port: Number(process.env.GATE_PORT ?? 48912), instances: 3 });
const fm = fx.fm;
const agents = fx.instances.filter((i: any) => !i.general).map((i: any) => i.name);
const [A, B] = [agents[0]!, agents[1]!];
const delivered: Record<string, unknown[]> = { [A]: [], [B]: [] };
for (const n of [A, B]) fm.instanceIpcClients.set(n, { connected: true, send(payload: unknown) { delivered[n]!.push(payload); return true; } });
fm.getInstanceStatus = () => "running";
const { publicAttachment } = await import(join(REPO, "src/web-upload.ts"));
const original = join(fx.dir, "screen.png");
writeFileSync(original, png(1200, 800));
const originalSha = sha(readFileSync(original));
const att = publicAttachment(fm.webFiles.registerServed({ path: original, instance: A, name: "screen.png", mime: "image/png", kind: "photo" }));
fm.emitSseEvent("message", { instance: A, sender: A, role: "agent", text: "Here is the screen", ts: new Date().toISOString(), attachments: [att] });
const old = (path: string) => { try { return execFileSync("git", ["-C", REPO, "show", `${BASE_REF}:${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };

/** The canvas: its size and a coarse digest of its pixels (to tell a drawn canvas from the bare picture). Read after
 *  two frames, so the editor's paint (an effect after the render a click caused) has run. */
const CANVAS = `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done((() => { const c = document.querySelector("dialog.lb .an-canvas"); if (!c) return null;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 97) s = (s * 31 + d[i]) % 1000000007;
  return { w: c.width, h: c.height, digest: s }; })()))))`;

async function openViewer(page: any, phone: boolean, inPane = "") {
  const thumb = page.locator(`${inPane} .msg.agent .att-img`).last();
  await thumb.waitFor({ timeout: 20000 });
  if (phone) await thumb.tap(); else await thumb.click();
  await page.locator("dialog.lb").waitFor();
}
/** A drag on the canvas, from (x0,y0) to (x1,y1) in fractions of its box: a mouse, or a finger (CDP touch events). */
async function drag(page: any, cdp: any, phone: boolean, [x0, y0]: number[], [x1, y1]: number[]) {
  const box = await page.locator("dialog.lb .an-canvas").boundingBox();
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const a = at(x0!, y0!), b = at(x1!, y1!);
  if (!phone) { await page.mouse.move(a.x, a.y); await page.mouse.down(); for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8); await page.mouse.up(); return; }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [a] });
  for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

try {
  const cases = matrix(process.env.MATRIX ?? "quick") as MatrixCase[];
  check("cases", cases.length > 0, { matrix: process.env.MATRIX ?? "quick" });   // a spec that matches nothing must not pass
  for (const c of cases) {
    const cn = caseName(c), zh = c.lang === "zh-TW", phone = c.device === "phone";
    const L = (en: string, z: string) => zh ? z : en;
    const { ctx, page, csp } = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(A)}` });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const uploads: Buffer[] = [], sends: any[] = [];
    await page.route("**/ui/upload**", async (route: any) => { uploads.push(route.request().postDataBuffer() ?? Buffer.alloc(0)); await route.continue(); });
    await page.route("**/ui/send", async (route: any) => { try { sends.push(JSON.parse(route.request().postData() || "{}")); } catch { /* not JSON */ } await route.continue(); });
    const cdp = phone ? await ctx.newCDPSession(page) : null;
    const shot = (n: string) => page.screenshot({ path: join(OUT, `${cn}-${n}.png`) });
    await page.locator("#msgIn").waitFor({ timeout: 20000 });
    // 1. 「標註」 in the viewer.
    await openViewer(page, phone);
    const annotate = page.locator("dialog.lb .lb-annotate");
    // A phone shows the icon only (its words are hidden there), so its accessible name is what is checked.
    check(`${cn}:button`, (await annotate.count()) === 1 && (await annotate.getAttribute("aria-label")) === L("Annotate", "標註"));
    await shot("1-viewer");
    await annotate.click();
    await page.locator("dialog.lb .an-canvas").waitFor({ timeout: 10000 });
    await page.waitForTimeout(300);
    const bare = await page.evaluate(CANVAS);
    check(`${cn}:canvas`, bare?.w === 1200 && bare?.h === 800, bare);
    await shot("2-editor");
    // 2. Draw: pen, box, arrow, another colour, text; undo then redo.
    await drag(page, cdp, phone, [0.1, 0.2], [0.35, 0.3]);
    await page.locator("dialog.lb .an-tool-box").click();
    await drag(page, cdp, phone, [0.45, 0.15], [0.75, 0.45]);
    await page.locator("dialog.lb .an-colour-blue").click();
    await page.locator("dialog.lb .an-tool-arrow").click();
    await drag(page, cdp, phone, [0.2, 0.8], [0.45, 0.5]);
    await page.locator("dialog.lb .an-tool-text").click();
    const box = await page.locator("dialog.lb .an-canvas").boundingBox();
    if (phone) await page.touchscreen.tap(box.x + box.width * 0.55, box.y + box.height * 0.7); else await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.7);
    await page.locator("dialog.lb .an-text input").fill(L("this one", "這個"));
    await page.locator("dialog.lb .an-text input").press("Enter");
    const drawn = await page.evaluate(CANVAS);
    await page.locator("dialog.lb .an-undo").click();
    const undone = await page.evaluate(CANVAS);
    await page.locator("dialog.lb .an-redo").click();
    const redone = await page.evaluate(CANVAS);
    check(`${cn}:drawn`, drawn.digest !== bare.digest && undone.digest !== drawn.digest && redone.digest === drawn.digest, { bare, drawn, undone, redone });
    await shot("3-marked");
    // 3. Quote to agent.
    await page.locator('dialog.lb .an-quote[data-target="self"]').click();
    await page.locator("dialog.lb").waitFor({ state: "detached", timeout: 10000 });
    const chips = await page.locator(".file-chip").allInnerTexts();
    const replyText = await page.locator(".reply-bar").innerText().catch(() => "");
    // The reply bar's ✕ stays on screen with a long sender name (the fixture's are instance ids), on a phone too.
    const cancel = await page.locator(".reply-bar .reply-cancel").boundingBox(), vw = page.viewportSize()!.width;
    check(`${cn}:replyCancelOnScreen`, !!cancel && cancel.x >= 0 && cancel.x + cancel.width <= vw, { cancel, vw });
    check(`${cn}:composer`, chips.length === 1 && chips[0]!.includes("screen-annotated.png") && replyText.includes("Here is the screen"), { chips, replyText });
    await shot("4-composer");
    // 4. Send: the new PNG, the reply, the delivery; the original unchanged.
    await page.locator("#msgIn").fill(L("Look at the box", "看這個方框"));
    await page.locator("#sendBtn").click();                                   // a phone's Enter is a new line, not Send
    await page.waitForFunction(() => !document.querySelector(".file-chip"), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    const up = uploads.at(-1) ?? Buffer.alloc(0), sent = sends.at(-1) ?? {};
    const isPng = up.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const pngW = isPng ? up.readUInt32BE(16) : 0, pngH = isPng ? up.readUInt32BE(20) : 0;
    check(`${cn}:upload`, isPng && pngW === 1200 && pngH === 800 && sha(up) !== originalSha, { isPng, pngW, pngH });
    check(`${cn}:send`, Array.isArray(sent.attachments) && sent.attachments.length === 1 && typeof sent.replyTo?.id === "number", sent);
    const last = JSON.stringify(delivered[A]!.at(-1) ?? {});
    check(`${cn}:delivered`, last.includes("Look at the box") || last.includes("看這個方框"), last.slice(0, 400));
    const served = Buffer.from(await page.evaluate(async (u: string) => Array.from(new Uint8Array(await (await fetch(u)).arrayBuffer())), `/ui/file/${att.id}`));
    check(`${cn}:original`, sha(readFileSync(original)) === originalSha && sha(served) === originalSha);
    // 5. Esc closes without adding anything.
    await openViewer(page, phone);
    await page.locator("dialog.lb .lb-annotate").click();
    await page.locator("dialog.lb .an-canvas").waitFor();
    await drag(page, cdp, phone, [0.3, 0.3], [0.6, 0.6]);
    await page.keyboard.press("Escape");
    await page.locator("dialog.lb").waitFor({ state: "detached", timeout: 5000 });
    check(`${cn}:esc`, (await page.locator(".file-chip").count()) === 0);
    check(`${cn}:noErrors`, errs.length === 0 && (await csp()).length === 0, { errs });
    await ctx.close();
  }
  // 6. Split chat (desktop): quote to the other pane.
  {
    const c = { device: "desk", theme: "light", lang: "en" } as MatrixCase;
    const { ctx, page } = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(A)}` });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.locator("#msgIn").waitFor({ timeout: 20000 });
    await page.evaluate(async (name: string) => { const { appStore } = await import("/assets/app-store.js"); await (appStore.get() as any).chatWorkspace?.open(name); }, B);
    await page.locator('[data-pane="b"]').waitFor({ timeout: 15000 });
    await openViewer(page, false, '[data-pane="a"]');
    await page.locator("dialog.lb .lb-annotate").click();
    await page.locator("dialog.lb .an-canvas").waitFor();
    await drag(page, null, false, [0.1, 0.1], [0.5, 0.5]);
    const other = page.locator('dialog.lb .an-quote[data-target="other"]');
    check("split:otherButton", (await other.count()) === 1 && (await other.innerText()).includes(B));
    await page.screenshot({ path: join(OUT, "split-1-editor.png") });
    await other.click();
    await page.locator("dialog.lb").waitFor({ state: "detached", timeout: 10000 });
    await page.waitForTimeout(800);
    const bChips = await page.locator('[data-pane="b"] .file-chip').allInnerTexts();
    const bDraft = await page.locator('[data-pane="b"] #pane-b-msgIn, [data-pane="b"] textarea').first().inputValue().catch(() => "");
    const aChips = await page.locator('[data-pane="a"] .file-chip').count();
    // One quote, headed once by the source chat's name (the pane quote adds that header itself).
    const headers = bDraft.split("\n").filter((l) => l.startsWith(`> ${A}:`)).length;
    check("split:otherPane", bChips.length === 1 && bChips[0]!.includes("annotated.png") && bDraft.includes("Here is the screen") && headers === 1 && aChips === 0, { bChips, bDraft, headers, aChips });
    await page.screenshot({ path: join(OUT, "split-2-other-pane.png") });
    await ctx.close();
  }
  // 7. SKEW.
  {
    const c = { device: "desk", theme: "light", lang: "en" } as MatrixCase;
    const before = old("src/ui/image-lightbox.js");
    const p1 = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(A)}` });
    const e1: string[] = []; p1.page.on("pageerror", (e: any) => e1.push(String(e).slice(0, 200)));
    if (before) await p1.page.route("**/ui/js/image-lightbox.js", (route: any) => route.fulfill({ status: 200, contentType: "application/javascript", body: before }));
    await p1.page.goto(`${fx.base}/ui/chat/${encodeURIComponent(A)}`); await p1.page.locator("#msgIn").waitFor({ timeout: 20000 });
    await openViewer(p1.page, false);
    check("skew:oldViewer", !!before && (await p1.page.locator("dialog.lb .lb-annotate").count()) === 0 && (await p1.page.locator("dialog.lb .lb-img").count()) === 1 && e1.length === 0, { e1 });
    await p1.ctx.close();
    const p2 = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(A)}` });
    const e2: string[] = []; p2.page.on("pageerror", (e: any) => e2.push(String(e).slice(0, 200)));
    await p2.page.route("**/ui/js/image-annotate.js", (route: any) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
    await p2.page.goto(`${fx.base}/ui/chat/${encodeURIComponent(A)}`); await p2.page.locator("#msgIn").waitFor({ timeout: 20000 });
    await openViewer(p2.page, false);
    await p2.page.locator("dialog.lb .lb-annotate").click();
    await p2.page.waitForTimeout(1200);
    const toastText = await p2.page.locator(".toast").allInnerTexts().catch(() => []);
    check("skew:missingEditor", (await p2.page.locator("dialog.lb .lb-img").count()) === 1 && toastText.join(" ").includes("could not be loaded") && e2.length === 0, { toastText, e2 });
    await p2.page.screenshot({ path: join(OUT, "skew-missing-editor.png") });
    await p2.ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  writeFileSync(join(OUT, "result.json"), JSON.stringify(r, null, 1));
  for (const f of fail) console.log(`FAIL ${f}: ${JSON.stringify((r[f] as any)?.FAIL ?? r.error ?? "").slice(0, 600)}`);
  console.log(fail.length ? `#3727 smoke FAILED (${fail.length}) — ${OUT}` : `#3727 smoke passed (${Object.keys(r).length - 1} checks) — ${OUT}`);
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}

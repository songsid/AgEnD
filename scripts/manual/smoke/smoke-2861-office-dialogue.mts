// #2861 (hxhsandy): the Office's dialogue box. On the shared fixture (web server only: no fleet, no CLI), signed in,
// Fleet → Org chart → Office. Chat messages are published as the fleet publishes them (FleetManager.emitSseEvent
// "message": a person's role "user", the agent's reply role "agent"); "working" is set in the page's store for the shot.
// Cases: a pack with portraits and a dialogBox (uploaded to the scratch host), and Cozy (no portraits: avatars/initials),
// desk and phone, light and dark, en and zh-TW. Checks per case:
// - off by default: the Dialogue box unticked and, with a message published, none of its words drawn;
// - on: the person's name and words drawn (typed out) in the bottom fifth of the stage, then the agent's reply;
// - the screen-reader line says them; a click on the box opens the agent's card;
// - reduced motion (one case): the words whole at once;
// - no page errors, no horizontal overflow.
// SKEW (both ways): a tab opened before this landed — the shell's assets (app.js, app-shell.js, app-stream.js, app.css,
// instance-nav.js, app-i18n.js) from SKEW, the release tip — loading the new Office: the box works; and the new host
// with the old Office modules (/ui/js/fleet-office*.js and office-share-page.js from SKEW): the Office renders, no errors.
// Pictures: <case>-<style>-heard, -working, -answered; desk-light-en-reduced; skew-old-shell, skew-old-office.
//   PW_DIR=… REPO=<checkout> OUT=<dir> SKEW=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2861-office-dialogue.mts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { bootFixture, caseName, labelOf, matrix, mounted, shotPath, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2861-office-dialogue";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48961), classic: false, instances: 6 });
const fm = fx.fm as any;
const names = fx.instances.map((i: any) => i.name) as string[];
const AGENT = names[0]!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── A pack with portraits: the clinic sample, plus three half-body pictures and a frame ──
const REPO = process.env.REPO!;
const CLINIC = join(REPO, "tests", "fixtures", "office-skin-clinic");
function png(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(paint(x, y), y * (w * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** A pixel-art bust (64×96): a head and shoulders in `body`, a face in `skin`, hair in `hair`; transparent around. */
const bust = (body: number[], hair: number[], skin = [246, 214, 182]) => png(64, 96, (x, y) => {
  const head = (x - 32) ** 2 / 15 ** 2 + (y - 30) ** 2 / 18 ** 2 <= 1, hairOn = head && y < 24, shoulders = y >= 52 && Math.abs(x - 32) <= 10 + (y - 52) * 0.7;
  const eye = (y === 32 || y === 33) && (x === 26 || x === 27 || x === 37 || x === 38);
  if (eye) return [40, 30, 30, 255];
  if (hairOn) return [...hair, 255] as any;
  if (head) return [...skin, 255] as any;
  if (shoulders) return [...body, 255] as any;
  return [0, 0, 0, 0];
});
const frame = png(24, 24, (x, y) => {
  const edge = x < 3 || y < 3 || x > 20 || y > 20, inner = x < 5 || y < 5 || x > 18 || y > 18;
  return edge ? [120, 78, 40, 255] : inner ? [200, 160, 100, 255] : [43, 29, 20, 235];
});
const manifest = { ...JSON.parse(readFileSync(join(CLINIC, "manifest.json"), "utf8")), id: "dialogue-demo",
  portraits: { default: "p/agent.png", byInstance: { [AGENT]: { idle: "p/lead.png", working: "p/lead-busy.png" } }, byUser: { "discord:42": "p/han.png" } },
  dialogBox: { frame: "ui/box.png", slice: 6, text: "#f6ead7", name: "#ffd27a", border: "#c8a165" } };
const b64 = (b: Buffer) => b.toString("base64");
const up = fm.officeSkins.add({ name: "Dialogue demo", manifest, files: {
  "office_bg.png": b64(readFileSync(join(CLINIC, "office_bg.png"))), "fox_idle.png": b64(readFileSync(join(CLINIC, "fox_idle.png"))),
  "p/agent.png": b64(bust([90, 110, 160], [60, 40, 30])), "p/lead.png": b64(bust([150, 60, 70], [30, 30, 40])), "p/lead-busy.png": b64(bust([150, 60, 70], [30, 30, 40], [255, 205, 170])),
  "p/han.png": b64(bust([60, 130, 90], [200, 160, 60])), "ui/box.png": b64(frame) } }, "smoke");
if (!up.ok) throw new Error(`the demo pack was refused: ${JSON.stringify(up)}`);
fm.emitSseEvent("office_skins", { rev: up.rev });

const results: Array<Record<string, unknown>> = [];
let failed = 0;
function record(name: string, c: Record<string, boolean>, extra: Record<string, unknown> = {}) {
  const bad = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) failed++;
  results.push({ name, ok: !bad.length, checks: c, ...extra });
  console.log(`${bad.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""} ${JSON.stringify(extra).slice(0, 500)}`);
}
// Every fillText on the Office canvas, with its device-px y (plain JS: no tsx helpers in the page).
const RECORD = `(() => { const w = window; w.__texts = []; const orig = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (s, x, y) { if (this.canvas && this.canvas.classList && this.canvas.classList.contains("oo-canvas")) { const m = this.getTransform(); w.__texts.push({ s: String(s), y: m.d * y + m.f, at: performance.now() }); } return orig.apply(this, arguments); }; })();`;
const drawn = (page: any, since = 0) => page.evaluate((t: number) => ((window as any).__texts as any[]).filter((x) => x.at >= t), since);
const msg = (role: "user" | "agent", text: string, extra: Record<string, unknown> = {}) =>
  fm.emitSseEvent("message", { instance: AGENT, role, sender: role === "user" ? "Han" : AGENT, text, ts: new Date().toISOString(), ...(role === "user" ? { from: "discord:42", channel: true } : {}), ...extra });

async function openOffice(c: MatrixCase, style: string, opts: { reduced?: boolean; dialogue?: boolean; routes?: Array<[string, string, string]> } = {}) {
  const storage: Record<string, string> = { agend_org_mode: "office", ...(opts.dialogue === false ? {} : {}) };
  const { ctx, page } = await fx.page(c, { storage });
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e)));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
  if (opts.reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [glob, body, type] of opts.routes ?? []) await page.route(glob, (r: any) => r.fulfill({ status: 200, contentType: type, body }));
  await page.addInitScript({ content: RECORD });
  await page.goto(`${fx.base}/ui/fleet/org`);
  if (!(await mounted(page, 30000))) throw new Error("the app did not mount");
  await page.waitForSelector(".oo-canvas", { timeout: 15000 });
  const picker = page.locator(".oo-bar select").nth(1);
  if ((await picker.inputValue()) !== style) await picker.selectOption(style);
  await page.waitForTimeout(2500);
  return { ctx, page, errors };
}
const tick = (page: any) => page.locator(".oo-dialogue input").check();
const setWorking = (page: any, on: boolean) => page.evaluate(async ([n, w]: [string, boolean]) => {
  const m = await import("/assets/app-store.js"); m.appStore.set((s: any) => ({ ...s, exec: { ...s.exec, [n]: w ? "working" : "idle" } }));
}, [AGENT, on]);
const stageBox = (page: any) => page.locator(".oo-stage").boundingBox();

const WORDS = { en: "Could you check the release notes for beta.10 before lunch?", "zh-TW": "可以在午餐前幫我看一下 beta.10 的發行說明嗎？" };
const REPLY = { en: "Checked — two typos fixed, the rest reads well.", "zh-TW": "看過了，修了兩個錯字，其他都沒問題。" };
for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-dark-zh-TW,phone-light-en")) {
  for (const style of ["dialogue-demo", "cozy"]) {
    const { ctx, page, errors } = await openOffice(c, style);
    const label = await page.locator(".oo-dialogue").textContent();
    const off = !(await page.locator(".oo-dialogue input").isChecked());
    msg("user", `${WORDS[c.lang]} (off)`);
    await wait(1500);
    const offDrawn = (await drawn(page)).some((x: any) => x.s.includes("(off)") || (x.s.length > 4 && WORDS[c.lang].startsWith(x.s)));
    await tick(page); await wait(300);
    const t0 = await page.evaluate(() => performance.now());
    msg("user", WORDS[c.lang]);
    await wait(4500);
    await page.screenshot({ path: shotPath(SMOKE, c, `${style}-heard`) });
    const sb = await stageBox(page), dpr = Number(process.env.PW_DPR ?? 1);
    const heard = await drawn(page, t0);
    const live1 = await page.locator(".oo-dialogue-live").textContent();
    await setWorking(page, true); await wait(1500);
    await page.screenshot({ path: shotPath(SMOKE, c, `${style}-working`) });
    const working = (await drawn(page, t0)).some((x: any) => /Working…|處理中…/.test(x.s));
    const t1 = await page.evaluate(() => performance.now());
    msg("agent", REPLY[c.lang]);
    await wait(3500);
    await page.screenshot({ path: shotPath(SMOKE, c, `${style}-answered`) });
    const answered = await drawn(page, t1);
    const live2 = await page.locator(".oo-dialogue-live").textContent();
    // The box's own words, in the bottom part of the stage (device px from the canvas's top).
    const low = (xs: any[]) => xs.filter((x) => sb && x.y / dpr > sb.height * 0.6);
    const said = (xs: any[], words: string) => low(xs).map((x) => x.s).join("").replace(/\s/g, "").includes(words.replace(/\s/g, "").slice(0, 12));
    // Two at once: the newest shows, "+1" for the other.
    const t2 = await page.evaluate(() => performance.now());
    fm.emitSseEvent("message", { instance: names[1], role: "user", sender: "Mei", text: "one more thing", ts: new Date().toISOString() });
    await wait(2500);
    await page.screenshot({ path: shotPath(SMOKE, c, `${style}-queue`) });
    const queued = (await drawn(page, t2)).some((x: any) => x.s === "+1");
    fm.emitSseEvent("message", { instance: names[1], role: "agent", sender: names[1], text: "ok", ts: new Date().toISOString() });
    await wait(1500);
    await page.mouse.click(sb!.x + sb!.width / 2, sb!.y + sb!.height - 30);
    await wait(800);
    const card = await page.locator(".oo-card").count();
    record(`${caseName(c)} ${style}`, {
      "the toggle, in the case's language": label?.trim() === labelOf(c, { en: "Dialogue", zh: "對話框" }),
      "off by default": off,
      "off: none of a message's words drawn": !offDrawn,
      "heard: the person's name drawn": low(heard).some((x: any) => x.s === "Han"),
      "heard: their words drawn, low on the stage": said(heard, WORDS[c.lang]),
      "working: the status line": working,
      "answered: the reply drawn": said(answered, REPLY[c.lang]),
      "read out (live region)": !!live1?.includes("Han") && !!live2?.includes(REPLY[c.lang].slice(0, 6)),
      "two at once: +1 on the box": queued,
      "a click on the box opens the card": card === 1,
      "no horizontal overflow": await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "no page errors": errors.length === 0,
    }, { live1, live2, errors: errors.slice(0, 3) });
    await setWorking(page, false);
    await ctx.close();
  }
}
// Reduced motion: the words whole at once.
{
  const c = matrix("desk-light-en")[0]!;
  const { ctx, page, errors } = await openOffice(c, "dialogue-demo", { reduced: true });
  await tick(page); await wait(300);
  const t0 = await page.evaluate(() => performance.now());
  msg("user", "All at once, please.");
  await wait(600);
  await page.screenshot({ path: shotPath(SMOKE, c, "reduced") });
  const xs = await drawn(page, t0);
  record(`${caseName(c)} reduced motion`, { "the words whole at once": xs.some((x: any) => x.s === "All at once, please."), "no page errors": errors.length === 0 });
  await ctx.close();
}
// SKEW, both ways (SKEW=<dir>: the release tip's files, as a tab opened before this landed has them).
if (process.env.SKEW && existsSync(process.env.SKEW)) {
  const S = process.env.SKEW;
  const c = matrix("desk-light-en")[0]!;
  const file = (f: string) => readFileSync(join(S, f), "utf8");
  const type = (f: string) => (f.endsWith(".css") ? "text/css" : "text/javascript");
  // 1. An old shell (its startup assets) loading the new Office lazily.
  {
    const shell = ["app.js", "app-shell.js", "app-stream.js", "app.css", "instance-nav.js", "app-i18n.js"].filter((f) => existsSync(join(S, f)));
    const { ctx, page, errors } = await openOffice(c, "dialogue-demo", { routes: shell.map((f) => [`**/assets/${f}*`, file(f), type(f)] as [string, string, string]) });
    await tick(page); await wait(300);
    const t0 = await page.evaluate(() => performance.now());
    msg("user", "Hello from an old tab.");
    await wait(4000);
    await page.screenshot({ path: shotPath(SMOKE, c, "skew-old-shell") });
    const xs = await drawn(page, t0);
    record("SKEW old shell + new Office", { "the box says the words": xs.map((x: any) => x.s).join("").includes("Hello from an old tab."), "no page errors": errors.length === 0 }, { shell });
    await ctx.close();
  }
  // 2. The new host with the old Office modules (they know nothing of the box; the host's new reads must not break them).
  {
    const mods = ["fleet-office.js", "fleet-office-pack.js", "fleet-office-skin.js", "fleet-office-store.js", "office-share-page.js"].filter((f) => existsSync(join(S, f)));
    const { ctx, page, errors } = await openOffice(c, "cozy", { routes: mods.map((f) => [`**/ui/js/${f}*`, file(f), "text/javascript"] as [string, string, string]) });
    msg("user", "the old Office ignores this");
    await wait(2500);
    await page.screenshot({ path: shotPath(SMOKE, c, "skew-old-office") });
    const people = await page.locator(".oo-desk").count();
    record("SKEW new host + old Office", { "the Office draws its people": people > 0, "no Dialogue box (old)": (await page.locator(".oo-dialogue").count()) === 0, "no page errors": errors.length === 0 }, { mods, people });
    await ctx.close();
  }
}
writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, "result.json"), JSON.stringify({ failed, results }, null, 2));
await fx.close();
process.exit(failed ? 1 : 0);

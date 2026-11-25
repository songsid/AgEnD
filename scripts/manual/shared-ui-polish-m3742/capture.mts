/**
 * M-3742 real-app captures (owned web fixture; no Fleet/CLI starts, accounts or external services), for one checkout (REPO):
 * run it on the release tip for "before" and on the branch for "after". Prism's #4462 triage, on the task card page:
 *  - a running HTML preview: its notice's "I understand" (a real flat button — a border, not the page's own background, no
 *    shadow — and on a phone a 44 px box), and the frame's border (at least 3:1 against what is behind it, in light and dark);
 *  - kept as regression checks (Prism withdrew both as defects): the card page's Back and Previous / Next are 44 px on a phone,
 *    and the title has no border or outline at rest, a ring when focused from the keyboard (the heading row's ring after a card
 *    opens is its accessible focus target, .tc-head[tabindex=-1], kept as it is);
 *  - zh-TW: 優先級 (never 優先度) and 「Agent」 in the preview notice.
 * Desk 1366 and phone 390 × light / dark × en / zh-TW. A card with a one-file HTML prototype attached (as #4462's smoke).
 *   CHROME=<chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/shared-ui-polish-m3742/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [], measured: {} };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const shot = async (page: any, name: string) => {
  await page.waitForTimeout(400);
  const path = `m3742-${name}.png`;
  await page.screenshot({ path: join(OUT, path) });
  receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
};

const roster = ["planner", "dev", "lead"].map((name) => ({ name, backend: "claude-code" as const, displayName: name }));
const fx = await bootFixture({ port: 0, instances: 3, roster, classic: false });
const { SchedulerDb } = await import(REPO + "/src/scheduler/db.ts");
const db = new SchedulerDb(join(fx.dir, "scheduler.db"));
fx.fm.scheduler = { db };
fx.fm.attachTaskBoard(db);
const PERSON = { kind: "person" as const, name: "admin" };
const as = (name: string) => ({ kind: "instance" as const, name });
const GAME_HTML = "<!doctype html><meta charset=utf-8><title>Prototype</title><style>html,body{margin:0;height:100%;background:#111;color:#eee;font:16px sans-serif}canvas{display:block;width:100%;height:100%}</style><canvas id=c width=640 height=400></canvas><script>const x=document.getElementById('c').getContext('2d');x.fillStyle='#2a6';x.fillRect(40,40,120,80);x.fillStyle='#eee';x.fillText('Example prototype',60,160);</script>";
const { stageFile } = await import(REPO + "/src/task-attach-client.ts");
const { boardToolAction } = await import(REPO + "/src/task-board-tool.ts");
const staged = async (who: string, name: string, bytes: Buffer): Promise<string> => {
  const got = await stageFile(name, bytes, async (call: any) => { try { return { result: boardToolAction(db, who, call) }; } catch (e) { return { error: (e as Error).message }; } });
  if ("error" in got) throw new Error(got.error);
  return got.upload;
};
db.board.createProject(PERSON, { name: "Example project" });
const main = db.board.createCards(PERSON, { project: "Example project", cards: [{ title: "Build an example prototype", assignee: "lead", priority: "high", dispatcher: { kind: "person" } }] }).cards[0]!.code;
const subs = db.board.createCards(PERSON, { cards: [
  { parent: main, title: "Write the design", assignee: "planner", priority: "high" },
  { parent: main, title: "Make the HTML prototype", assignee: "dev", priority: "high" },
  { parent: main, title: "Check it", assignee: "lead", priority: "normal" },
] }).cards.map((c: any) => c.code);
const DEV = subs[1];
db.board.moveCard(as("dev"), DEV, "claimed", {});
db.board.moveCard(as("dev"), DEV, "done", { result: "A one-file HTML prototype.", comment: "Prototype attached.", attach: [await staged("dev", "prototype.html", Buffer.from(GAME_HTML))] });

// In the page, as strings (tsx would wrap named helpers in __name(), which the page does not have).
// In the page: rgb()/rgba() in 0–255, or color(srgb r g b [/ a]) in 0–1 (what Chromium reports for a color-mix()); a colour
// with alpha is laid over what is behind it first (rgba(…, 0.45) is not its own rgb).
const CONTRAST = `const parse = (c) => { const n = (c.match(/[\\d.]+/g) || []).map(Number), srgb = /^color\\(srgb/.test(c);
    return { rgb: n.slice(0, 3).map((v) => (srgb ? v * 255 : v)), a: n.length > 3 ? n[3] : 1 }; };
  const lum = (c) => { const m = parse(c).rgb; const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  const over = (c, under) => { const top = parse(c), u = parse(under).rgb;
    return "rgb(" + [0, 1, 2].map((i) => Math.round(top.rgb[i] * top.a + u[i] * (1 - top.a))).join(", ") + ")"; };
  const ratio = (a, b) => { const x = lum(over(a, b)), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const behind = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const bg = getComputedStyle(p).backgroundColor, a = parse(bg).a; if (bg !== "transparent" && a > 0.9) return bg; } return getComputedStyle(document.body).backgroundColor; };`;
const PREVIEW = `(() => { ${CONTRAST}
  const ack = document.querySelector(".tp-files .pv-ack"), frame = document.querySelector(".tp-files .preview-frame"), banner = document.querySelector(".tp-files .pv-banner");
  const a = ack && getComputedStyle(ack), f = frame && getComputedStyle(frame), r = ack && ack.getBoundingClientRect();
  return {
    ack: ack ? { h: Math.round(r.height), w: Math.round(r.width), bg: a.backgroundColor, border: a.borderTopColor, bw: a.borderTopWidth, shadow: a.boxShadow, bannerBg: getComputedStyle(banner).backgroundColor,
      borderVsBanner: Math.round(ratio(a.borderTopColor, getComputedStyle(banner).backgroundColor) * 100) / 100 } : null,
    frame: frame ? { border: f.borderTopColor, bw: f.borderTopWidth, style: f.borderTopStyle, shadow: f.boxShadow, behind: behind(frame), ratio: Math.round(ratio(f.borderTopColor, behind(frame)) * 100) / 100 } : null,
    bannerText: banner ? banner.innerText : null };
})()`;
const CARD = `(() => {
  const box = (s) => [...document.querySelectorAll(s)].filter((e) => e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return { s, w: Math.round(r.width), h: Math.round(r.height) }; });
  const title = document.querySelector(".tp .tc-title"), t = title && getComputedStyle(title);
  return { taps: [...box(".tp-bar .tp-back"), ...box(".tp-bar .tc-steps .icon-btn")],
    title: title ? { tag: title.tagName, focused: document.activeElement === title, border: t.borderTopColor, bw: t.borderTopWidth, outline: t.outlineStyle + " " + t.outlineWidth, shadow: t.boxShadow } : null,
    text: document.querySelector(".tp")?.innerText || "" };
})()`;
const transparent = (c: string) => c === "rgba(0, 0, 0, 0)" || c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);
try {
  for (const c of matrix()) {
    const tag = caseName(c), zh = c.lang === "zh-TW";
    const { page, ctx } = await fx.page(c, { path: `/ui/fleet?card=${DEV}`, prefs: { "preview.optIn": true } });
    try {
      await page.waitForSelector(".tp-files", { timeout: 20000 });
      await page.waitForTimeout(600);
      const m1 = await page.evaluate(CARD) as any;
      receipt.measured[`${tag}-card`] = { taps: m1.taps, title: m1.title };
      if (c.device === "phone") check(`${tag}: Back and Previous / Next are 44 px boxes`, m1.taps.length >= 3 && m1.taps.every((x: any) => x.h >= 44 && (x.s.includes("tp-back") || x.w >= 44)), m1.taps);
      check(`${tag}: the title has no border, outline or ring at rest`, !!m1.title && (transparent(m1.title.border) || m1.title.bw === "0px") && m1.title.outline.startsWith("none") && m1.title.shadow === "none", m1.title);
      if (zh) check(`${tag}: 優先級, never 優先度`, m1.text.includes("優先級") && !m1.text.includes("優先度"), m1.text.match(/優先./g));
      await shot(page, `${tag}-1-card`);
      await page.click(".tp-files .tf-html .btn-primary");
      await page.waitForSelector(".tp-files iframe", { timeout: 15000 });
      await page.waitForTimeout(900);
      await page.evaluate(`document.querySelector(".tp-files .pv-banner")?.scrollIntoView({ block: "center" })`);
      const m2 = await page.evaluate(PREVIEW) as any;
      receipt.measured[`${tag}-preview`] = m2;
      check(`${tag}: "I understand" is a flat button: a visible border, its own background, no shadow`, !!m2.ack && parseFloat(m2.ack.bw) >= 1 && !transparent(m2.ack.border) && !transparent(m2.ack.bg) && m2.ack.shadow === "none", m2.ack);
      if (c.device === "phone") check(`${tag}: "I understand" is a 44 px box`, !!m2.ack && m2.ack.h >= 44, m2.ack);
      check(`${tag}: the preview frame's border is at least 3:1 against what is behind it, flat`, !!m2.frame && m2.frame.ratio >= 3 && m2.frame.style === "solid" && m2.frame.shadow === "none", m2.frame);
      if (zh) check(`${tag}: the notice says Agent`, !!m2.bannerText && m2.bannerText.includes("Agent") && !/\bagent\b/.test(m2.bannerText), m2.bannerText);
      await shot(page, `${tag}-2-preview`);
      // The title focused from the keyboard: a ring then (and only then).
      await page.evaluate(`window.scrollTo(0, 0); document.querySelector(".tp")?.scrollIntoView({ block: "start" })`);
      await page.focus(".tp .tc-title"); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
      const ring = await page.evaluate(`(() => { const t = document.querySelector(".tp .tc-title"); const s = getComputedStyle(t); return { focused: document.activeElement === t, outline: s.outlineStyle + " " + s.outlineWidth, shadow: s.boxShadow, border: s.borderTopColor }; })()`) as any;
      check(`${tag}: focused from the keyboard, the title shows a ring`, ring.focused && (!ring.outline.startsWith("none") || ring.shadow !== "none"), ring);
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

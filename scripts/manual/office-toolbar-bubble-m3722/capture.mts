/**
 * M-3722 real-app captures (owned web fixture; no Fleet/CLI starts, accounts or external services), for one checkout
 * (REPO): run it on the release tip for "before" and on the branch for "after".
 *  (a) Fleet on a phone (390 px): Tasks, Org chart (Office) and Host health, en and zh-TW, light and dark — every tab inside
 *      the screen, each a 44 px touch target, no sideways scroll, the header naming the page.
 *  (b) The Office with one agent calling (a held contact request to "worker"), desk, every zoned style, en and zh-TW.
 *  (c) Desk frames of the same Fleet pages (canvas org chart, reduced motion), for the desk-unchanged pixel comparison.
 *   CHROME=<linux chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/office-toolbar-bubble-m3722/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, mounted } from "../smoke-fixture/index.mts";
import { withDisplay } from "../smoke-fixture/office-display.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const shot = async (page: any, name: string) => {
  await page.waitForTimeout(400);
  const path = `m3722-${name}.png`;
  await page.screenshot({ path: join(OUT, path) });
  receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
};
const fx = await bootFixture({ port: 0, host: true, classic: false, roster: [
  { name: "general", backend: "claude-code", general: true, displayName: "General" },
  { name: "lead", backend: "claude-code", displayName: "Example lead", description: "Synthetic demonstration agent" },
  { name: "worker", backend: "codex", displayName: "Example worker", description: "Synthetic demonstration agent" },
] });
try {
  const fm = fx.fm;
  // A scratch task board with a few made-up cards (Tasks shows a board, not "couldn't be read").
  const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, "m3722-example.db"), () => {}, DEFAULT_SCHEDULER_CONFIG, () => true);
  fm.attachTaskBoard?.(fm.scheduler.db);
  const board = fm.scheduler.db.board, person = { kind: "person", name: "Example owner" } as const;
  const project = board.createProject(person, { name: "Example project" });
  for (const [title, who, to] of [["Draft the release notes · 起草發行說明", "lead", "claimed"], ["Check the phone layout · 檢查手機版面", "worker", "open"], ["Review the help desk · 檢查求救區", "worker", "done"]] as const) {
    const card = board.createCards(person, { cards: [{ title, assignee: who, project: project.id }] }).cards[0];
    if (to !== "open") board.moveCard(person, card.code, to, to === "done" ? { result: "Done." } : {});
  }
  fm.scheduleDeliveryOutboxPump = () => {};
  fm.ensureDeliveryOutbox();
  fm.deliveryOutbox.contactAuthorizations.hold({ operationId: "fake-op", source: "lead", target: "worker", sourceGeneration: fm.contactGeneration("lead"),
    targetGeneration: fm.contactGeneration("worker"), verb: "send_to_instance", origin: { kind: "unknown", people: [], receiptIds: [], chain: ["lead"] },
    message: "Please run the release checklist.", correlationId: "fake-correlation", resultRecipient: "lead", payload: { content: "synthetic" } });
  const PAGES = [["tasks", "/ui/fleet/tasks", { en: "Tasks", zh: "任務" }], ["org", "/ui/fleet/org", { en: "Org chart", zh: "組織圖" }], ["host-health", "/ui/fleet/host-health", { en: "Host health", zh: "主機狀態" }]] as const;
  // (a) phones
  for (const c of matrix("phone-light-en,phone-dark-en,phone-light-zh-TW,phone-dark-zh-TW")) for (const [key, path, name] of PAGES) {
    const tag = `${caseName(c)}-${key}`;
    const { page, ctx } = await fx.page(c, { host: true, storage: { agend_org_mode: "office" } });
    try {
      await page.goto(fx.base + path); check(`${tag}: mounted`, await mounted(page, 30000));
      await page.waitForSelector(".fleet-phone-tabs .seg-item", { timeout: 15000 }); await page.waitForTimeout(1500);
      const m = await page.evaluate(() => {
        const W = innerWidth, tabs = [...document.querySelectorAll(".fleet-phone-tabs .seg-item")].map((a: any) => { const r = a.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, h: r.height, name: a.textContent.trim() }; });
        return { W, scroll: document.documentElement.scrollWidth, tabs, title: (document.querySelector(".p-fleet > .panel-head .panel-title h1") as HTMLElement | null)?.innerText ?? "",
          titleShown: !!(document.querySelector(".p-fleet > .panel-head .panel-title h1") as HTMLElement | null)?.offsetWidth };
      });
      receipt[`phone-${tag}`] = m;
      // #4453 capture check: icons only, so each tab its own icon and its own accessible name; the tab you are on 3:1 or more.
      // A string, not a function: tsx would wrap named helpers in __name(), which the page does not have.
      const look = await page.evaluate(`(() => {
        const rgb = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 4).map(Number);
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        const lum = (c) => 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
        const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length >= 3 && (c[3] === undefined || c[3] > 0)) return c; } return [255, 255, 255]; };
        const tabs = [...document.querySelectorAll(".fleet-phone-tabs .seg-item")], on = document.querySelector(".fleet-phone-tabs .seg-item.active");
        const L1 = lum(rgb(getComputedStyle(on).color)), L2 = lum(bgOf(document.querySelector(".p-fleet > .panel-head")));
        return { icons: tabs.map((t) => (t.querySelector("svg") || {}).innerHTML || ""), names: tabs.map((t) => (t.textContent || "").trim()),
          contrast: (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05), underline: getComputedStyle(on).boxShadow,
          border: getComputedStyle(on).borderBottomWidth + " " + getComputedStyle(on).borderBottomStyle + " " + getComputedStyle(on).borderBottomColor,
          tint: getComputedStyle(on).backgroundColor, headBg: getComputedStyle(document.querySelector(".p-fleet > .panel-head")).backgroundColor };
      })()`) as any;
      receipt[`look-${tag}`] = { names: look.names, contrast: Math.round(look.contrast * 100) / 100, underline: look.underline, border: look.border, tint: look.tint };
      check(`${tag}: each tab its own icon`, look.icons.every((x: string) => x) && new Set(look.icons).size === look.icons.length, look.names);
      check(`${tag}: each tab its own accessible name`, look.names.every((x: string) => x) && new Set(look.names).size === look.names.length, look.names);
      // #4453 (the user: the line read as a raised key): flat — a tinted pill and the accent icon, no line, shadow or border.
      check(`${tag}: the tab you are on stands out flat (accent icon ≥ 3:1, a tinted pill, no line, shadow or border)`,
        look.contrast >= 3 && look.underline === "none" && /^0px|none/.test(look.border) && /^(rgb|color\()/.test(look.tint) && look.tint !== "rgba(0, 0, 0, 0)",
        { contrast: look.contrast, underline: look.underline, border: look.border, tint: look.tint });
      check(`${tag}: every tab inside the screen`, m.tabs.length >= 8 && m.tabs.every((t: any) => t.l >= 0 && t.r <= m.W + 0.5), m.tabs.map((t: any) => [t.name, Math.round(t.l), Math.round(t.r)]));
      check(`${tag}: each tab a 44px touch target`, m.tabs.every((t: any) => t.w >= 44 && t.h >= 44), m.tabs.map((t: any) => [t.name, Math.round(t.w), Math.round(t.h)]));
      check(`${tag}: no sideways scroll`, m.scroll <= m.W, m.scroll);
      if (key === "tasks") check(`${tag}: the board shows its project`, /Example project/.test(await page.locator(".p-fleet").innerText()), "no project");
      check(`${tag}: the header names the page`, m.titleShown && m.title.trim() === (c.lang === "zh-TW" ? name.zh : name.en), m.title);
      await shot(page, `${tag}`);
    } finally { await ctx.close(); }
  }
  // (a2) #4453 review: narrower phones (375, 360, 320 px), en and zh-TW — every tab still a 44 × 44 target, inside the
  // screen, none overlapping another, no sideways scroll.
  for (const c of matrix("phone-light-en,phone-dark-zh-TW")) for (const width of [375, 360, 320]) {
    const tag = `${caseName(c)}-${width}-org`;
    const { page, ctx } = await fx.page(c, { host: true, storage: { agend_org_mode: "office" } });
    try {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${fx.base}/ui/fleet/org`); check(`${tag}: mounted`, await mounted(page, 30000));
      await page.waitForSelector(".fleet-phone-tabs .seg-item", { timeout: 15000 }); await page.waitForTimeout(1500);
      const m = await page.evaluate(() => ({ W: innerWidth, scroll: document.documentElement.scrollWidth,
        tabs: [...document.querySelectorAll(".fleet-phone-tabs .seg-item")].map((a: any) => { const r = a.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, name: a.textContent.trim() }; }) }));
      receipt[`narrow-${tag}`] = m;
      const apart = m.tabs.every((x: any, i: number) => m.tabs.every((y: any, j: number) => i === j || x.r <= y.l + 0.5 || y.r <= x.l + 0.5 || x.b <= y.t + 0.5 || y.b <= x.t + 0.5));
      check(`${tag}: every tab inside the screen`, m.tabs.length >= 8 && m.tabs.every((t: any) => t.l >= -0.5 && t.r <= m.W + 0.5), m.tabs.map((t: any) => [t.name, Math.round(t.l), Math.round(t.r)]));
      check(`${tag}: each tab a 44 × 44 target`, m.tabs.every((t: any) => t.w >= 44 && t.h >= 44), m.tabs.map((t: any) => [t.name, Math.round(t.w * 10) / 10, Math.round(t.h)]));
      check(`${tag}: no two tabs overlap`, apart);
      check(`${tag}: no sideways scroll`, m.scroll <= m.W, m.scroll);
      await shot(page, tag);
    } finally { await ctx.close(); }
  }
  // (b) one caller, every zoned style
  for (const c of matrix("desk-light-en,desk-dark-zh-TW")) for (const style of ["studio", "cozy", "guild", "school"]) {
    const tag = `${caseName(c)}-office-${style}`;
    const { page, ctx } = await fx.page(c, { host: true, storage: { agend_org_mode: "office" } });
    try {
      await page.goto(`${fx.base}/ui/fleet/org`); check(`${tag}: mounted`, await mounted(page, 30000));
      await page.waitForSelector(".oo-canvas", { timeout: 15000 });
      const picker = page.locator("select.oo-style");
      await withDisplay(page, async () => { if ((await picker.inputValue()) !== style) await picker.selectOption(style); });
      await page.waitForTimeout(3500);
      await shot(page, tag);
    } finally { await ctx.close(); }
  }
  // (c) desk, for the unchanged-desk comparison
  for (const c of matrix("desk-light-en,desk-dark-zh-TW")) for (const [key, path] of PAGES) {
    const tag = `${caseName(c)}-${key}`;
    const { page, ctx } = await fx.page(c, { host: true, storage: { agend_org_mode: "canvas" } });
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(fx.base + path); check(`${tag}: mounted`, await mounted(page, 30000));
      await page.waitForTimeout(2500);
      await shot(page, `${tag}`);
    } finally { await ctx.close(); }
  }
} finally {
  try { fx.fm.scheduler?.db.close(); } catch { /* closed */ }
  clearInterval(fx.fm.replyObligationTimer);
  fx.fm.deliveryOutbox?.close();
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}

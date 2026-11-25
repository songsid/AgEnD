/**
 * M-3727 real-app captures (owned web fixture; no Fleet/CLI starts, accounts or external services), for one checkout (REPO):
 * run it on the release tip for "before" and on the branch for "after".
 *  Phone 320 / 360 / 375 px, light and dark, en and zh-TW: the Office's bar (Find, Canvas / List / Office, ⋯) — every control
 *  whole on screen, none overlapping — and its area pills: all whole, or a scrolling row that says so (its fade) and brings
 *  the last one whole into view. No sideways scroll of the page. One agent calls (a held request) and one works, so the pills
 *  are Whole office, the work area, the lounge and the Help desk.
 *  Desk (1366 px), light en and dark zh-TW: the same page, for the unchanged-desk comparison.
 *   CHROME=<linux chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/office-toolbar-narrow-m3727/capture.mts
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
  await page.waitForTimeout(400);
  const path = `m3727-${name}.png`;
  await page.screenshot({ path: join(OUT, path) });
  receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
};
const fx = await bootFixture({ port: 0, host: true, classic: false, roster: [
  { name: "general", backend: "claude-code", general: true, displayName: "General" },
  { name: "lead", backend: "claude-code", displayName: "Example lead", description: "Synthetic demonstration agent" },
  { name: "worker", backend: "codex", displayName: "Example worker", description: "Synthetic demonstration agent" },
] });
// In the page, as a string (tsx would wrap named helpers in __name(), which the page does not have).
const MEASURE = `(() => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  const W = innerWidth, bar = [...document.querySelectorAll(".oc-tools .oc-find, .oc-tools .seg-inline > *, .oc-tools .oo-more-btn")].filter((e) => e.getBoundingClientRect().width > 0);
  const items = bar.map((e) => ({ name: (e.getAttribute("aria-label") || e.textContent || e.className).trim().slice(0, 24), ...box(e) }));
  const pills = document.querySelector(".oo-zone-pills");
  let pill = null;
  if (pills) {
    const btns = [...pills.querySelectorAll(".btn")], cs = getComputedStyle(pills), over = pills.scrollWidth > pills.clientWidth + 1;
    const fade = pills.hasAttribute("data-more-right");
    pills.scrollLeft = pills.scrollWidth; pills.dispatchEvent(new Event("scroll"));
    const pr = pills.getBoundingClientRect(), last = btns.length ? btns[btns.length - 1].getBoundingClientRect() : null;
    pill = { names: btns.map((b) => (b.textContent || "").trim()), overflowX: cs.overflowX, over, fade,
      allWhole: btns.every((b) => { const r = b.getBoundingClientRect(); return r.left >= -0.5 && r.right <= W + 0.5; }),
      lastWholeAfterScroll: !!last && last.left >= pr.left - 0.5 && last.right <= pr.right + 0.5 && last.right <= W + 0.5 };
    pills.scrollLeft = 0; pills.dispatchEvent(new Event("scroll"));
  }
  return { W, scroll: document.documentElement.scrollWidth, items, pill };
})()`;
try {
  const fm = fx.fm;
  fm.scheduleDeliveryOutboxPump = () => {};
  fm.ensureDeliveryOutbox();
  fm.deliveryOutbox.contactAuthorizations.hold({ operationId: "fake-op", source: "lead", target: "worker", sourceGeneration: fm.contactGeneration("lead"),
    targetGeneration: fm.contactGeneration("worker"), verb: "send_to_instance", origin: { kind: "unknown", people: [], receiptIds: [], chain: ["lead"] },
    message: "Please run the release checklist.", correlationId: "fake-correlation", resultRecipient: "lead", payload: { content: "synthetic" } });
  const open = async (c: any, width?: number) => {
    const { page, ctx } = await fx.page(c, { host: true, storage: { agend_org_mode: "office" } });
    if (width) await page.setViewportSize({ width, height: 800 });
    await page.goto(`${fx.base}/ui/fleet/org`);
    const ok = await mounted(page, 30000);
    await page.waitForSelector(".oo-canvas", { timeout: 15000 });
    // One agent at work (its pose, its area's pill), as the status stream would say it.
    await page.evaluate(`import("/assets/app-store.js").then((m) => m.appStore.set((s) => ({ ...s, exec: { ...s.exec, lead: "working" } })))`);
    await page.waitForTimeout(2500);
    return { page, ctx, ok };
  };
  for (const width of [320, 360, 375]) for (const c of matrix("phone-light-en,phone-dark-en,phone-light-zh-TW,phone-dark-zh-TW")) {
    const tag = `${caseName(c)}-${width}`;
    const { page, ctx, ok } = await open(c, width);
    try {
      check(`${tag}: mounted`, ok);
      const m = await page.evaluate(MEASURE) as any;
      receipt.measured[tag] = m;
      const named = (re: RegExp) => m.items.find((i: any) => re.test(i.name));
      const more = named(/More actions|更多動作/);
      check(`${tag}: ⋯ is whole on screen, 44 px`, !!more && more.l >= -0.5 && more.r <= m.W + 0.5 && more.w >= 44 && more.h >= 44, more);
      check(`${tag}: every bar control whole on screen`, m.items.length >= 5 && m.items.every((i: any) => i.l >= -0.5 && i.r <= m.W + 0.5), m.items.map((i: any) => [i.name, Math.round(i.l), Math.round(i.r)]));
      const apart = m.items.every((x: any, i: number) => m.items.every((y: any, j: number) => i === j || x.r <= y.l + 0.5 || y.r <= x.l + 0.5 || x.b <= y.t + 0.5 || y.b <= x.t + 0.5));
      check(`${tag}: no two bar controls overlap`, apart);
      check(`${tag}: the area pills are there (Whole office, the work area, the lounge, the Help desk)`, !!m.pill && m.pill.names.length >= 4, m.pill?.names);
      check(`${tag}: every pill reachable — all whole, or a scrolling row with its fade and the last one whole once scrolled`,
        !!m.pill && (m.pill.allWhole || (m.pill.over && /auto|scroll/.test(m.pill.overflowX) && m.pill.fade && m.pill.lastWholeAfterScroll)), m.pill);
      check(`${tag}: no sideways scroll`, m.scroll <= m.W, m.scroll);
      await shot(page, tag);
    } finally { await ctx.close(); }
  }
  for (const c of matrix("desk-light-en,desk-dark-zh-TW")) {
    const tag = `${caseName(c)}`;
    const { page, ctx, ok } = await open(c);
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      check(`${tag}: mounted`, ok);
      await shot(page, tag);
    } finally { await ctx.close(); }
  }
} finally {
  clearInterval(fx.fm.replyObligationTimer);
  fx.fm.deliveryOutbox?.close();
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}

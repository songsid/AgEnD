// M-3167 (the user's desktop chat at ~920 px): the header's chips ('Claude Code', the model, the effort) drew under the
// agent's 聊天/檢視/紀錄/設定 tabs. A real Chrome on the shared fixture (in-process FleetManager, scratch home, loopback only),
// an agent's chat, swept from a phone's width to a wide desk (the sidebar open on a desk, as the user had it). At every width,
// in light/dark × en/zh-TW, no two of the header's visible parts may overlap — the name, the status, each chip, the tabs, the
// tools — and none may run past the header's edge. The name keeps at least a few characters. Where the chips no longer fit,
// they are not drawn (the composer has the model picker); on a wide desk they all stay. Pictures at 920 and 1440.
// Run it on the base too (REPO=<base checkout> SMOKE_NAME=…-before): the middle widths FAIL there.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] scripts/manual/smoke/run.sh smoke-chat-header-overlap-m3167.mts
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-chat-header-overlap-m3167";
const WIDTHS = [360, 390, 480, 600, 720, 820, 900, 920, 1000, 1100, 1200, 1280, 1366, 1440, 1600, 1920];
const SHOTS = new Set([390, 920, 1440]);
const fx = await bootFixture({ port: Number(process.env.HP ?? 48800), instances: 3 });
const name = fx.instances[1]!.name;
const cases = matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,desk-light-zh-TW,desk-dark-en").filter((c) => c.device === "desk");
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
try {
  for (const c of cases) {
    const failed: string[] = [];
    const { page, ctx } = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(name)}` }) as any;
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.waitForSelector("#msgIn", { timeout: 20000 });
    await page.evaluate("window.__name = (f) => f");   // tsx names the helpers below; the page has no such function
    // The context figure is drawn from 50%: this agent is at 56%, as the user's was, on the model the user had. Set once,
    // at the first (phone) width.
    await page.setViewportSize({ width: WIDTHS[0]!, height: 800 });
    await page.evaluate(async (n: string) => {
      const m = await import("/assets/app-store.js");
      m.appStore.set((s: any) => ({ ...s, instances: (s.instances || []).map((i: any) => i.name === n ? { ...i, context_pct: 56, model: "claude-opus-5-5" } : i) }));
    }, name);
    await page.waitForTimeout(400);
    let wideChips = -1;
    for (const w of WIDTHS) {
      // Only the window changes (as the user resized it): nothing else redraws the page between widths.
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(250);
      const m = await page.evaluate(() => {
        const head = document.querySelector(".p-chat .panel-head") as HTMLElement | null;
        if (!head) return null;
        const shown = (el: Element) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
        const parts: Array<{ what: string; r: DOMRect }> = [];
        // What shows: a part of the status line is cut at the line's own edge (it clips), so only that much counts.
        const add = (what: string, el: Element | null, clip?: DOMRect) => {
          if (!el || !shown(el)) return;
          const r = el.getBoundingClientRect();
          const v = clip ? new DOMRect(Math.max(r.left, clip.left), r.top, Math.min(r.right, clip.right) - Math.max(r.left, clip.left), r.height) : r;
          if (v.width > 0.5) parts.push({ what, r: v });
        };
        add("name", head.querySelector(".panel-title h1"));
        const sub = head.querySelector(".panel-sub");
        const clipped = sub && getComputedStyle(sub).overflowX !== "visible" ? sub.getBoundingClientRect() : undefined;
        if (sub) for (const k of [...sub.children]) add(k.classList.contains("status") ? "status" : `chip:${(k.textContent || "").trim().slice(0, 16)}`, k, clipped);
        add("tabs", head.querySelector(".inst-switch"));
        add("tools", head.querySelector(".panel-actions"));
        for (const b of head.querySelectorAll(":scope > .icon-btn")) add(`btn:${b.className.split(" ").find((x) => x.startsWith("sb-")) ?? "?"}`, b);
        const hr = head.getBoundingClientRect(), bad: string[] = [];
        for (let i = 0; i < parts.length; i++) {
          const a = parts[i]!.r;
          if (a.right > hr.right + 0.5 || a.left < hr.left - 0.5) bad.push(`${parts[i]!.what} past the header's edge`);
          for (let j = i + 1; j < parts.length; j++) {
            const b = parts[j]!.r, x = Math.min(a.right, b.right) - Math.max(a.left, b.left), y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (x > 0.5 && y > 0.5) bad.push(`${parts[i]!.what} × ${parts[j]!.what} (${Math.round(x)}px)`);
          }
        }
        const h1 = head.querySelector(".panel-title h1") as HTMLElement | null;
        // The composer: where its ring and model chip are drawn they are styled (no browser-default grey box), and the
        // model is in exactly one place — the header's chip or the composer's.
        const pick = document.querySelector(".composer-pick") as HTMLElement | null, ring = document.querySelector(".ctx-ring") as HTMLElement | null;
        const bg = (el: Element | null) => el ? getComputedStyle(el).backgroundColor : null;
        const flat = (c: string | null) => c !== null && c !== "rgba(0, 0, 0, 0)" && c !== "transparent";
        const headModel = [...head.querySelectorAll(".panel-sub .chat-model-entry")].some(shown);
        const composerModel = !!pick && shown(pick);
        if (flat(bg(pick))) bad.push(`the composer's model chip is a filled block (${bg(pick)})`);
        if (flat(bg(ring))) bad.push(`the context figure is a filled block (${bg(ring)})`);
        if (ring && getComputedStyle(ring.querySelector(".ctx-dial") ?? ring).backgroundImage.indexOf("conic-gradient") < 0) bad.push("the context figure is not a ring");
        if (headModel === composerModel) bad.push(`the model is ${headModel ? "in both the header and the composer" : "in neither the header nor the composer"}`);
        return { bad, chips: parts.filter((p) => p.what.startsWith("chip:")).length, nameW: h1 ? Math.round(h1.getBoundingClientRect().width) : 0,
          pickText: pick ? (pick.querySelector("b")?.textContent ?? "") : null };
      });
      if (!m) { failed.push(`${w}: no chat header`); continue; }
      if (m.bad.length) failed.push(`${w}: ${m.bad.join(", ")}`);
      if (m.nameW < 30) failed.push(`${w}: the name is ${m.nameW}px wide`);
      if (w >= 900 && w < 1440 && m.pickText !== null && /\(|claude-/.test(m.pickText)) failed.push(`${w}: the composer's model chip is the long name (${m.pickText})`);
      if (w === 1920) wideChips = m.chips;
      if (SHOTS.has(w)) {
        await page.locator(".p-chat .panel-head").screenshot({ path: shotPath(SMOKE, caseName(c), `w${w}-header`) });
        await page.locator(".p-chat .dock").screenshot({ path: shotPath(SMOKE, caseName(c), `w${w}-composer`) });
      }
    }
    if (wideChips < 1) failed.push(`1920: the chips are not drawn on a wide desk (${wideChips})`);
    if (errs.length) failed.push(`page errors: ${errs.join(" | ")}`);
    results.push({ name: caseName(c), ok: failed.length === 0, failed });
    await ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length === cases.length && results.every((r) => r.ok) ? 0 : 1);

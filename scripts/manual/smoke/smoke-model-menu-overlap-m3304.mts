// M-3304 (the user, 2026-11-18, beta.11 desktop dark zh-TW): the header's model menu "goes through the UI" — with a long list
// (the aliases plus the account's models) it opened above its button, over the chat header, ~130 px left of the button, and the
// header drew over its 「模型」 head and first row. A real Chrome on the shared fixture (in-process FleetManager, scratch home,
// loopback only, fake agents); /ui/command answers /model with a long Claude list (the shape the fleet sends). Judged:
//   desk (1920×1080 and 1440×900, the header's model button) — the menu opens UNDER its button (its top below the button's
//         bottom), its left at the button's left (within the viewport), its bottom inside the viewport (it scrolls within
//         it: scrollHeight > clientHeight when the list is longer), and nothing draws over it: the point at its head and at
//         its first row is the menu's own (elementFromPoint);
//   phone — the bottom sheet: inside the viewport, its list scrolls, its title and first row are its own.
// Everywhere: no page error. Pictures: <case>-menu.png (and -menu-scrolled.png on a desk). Run on the base too (SMOKE_NAME=…-before).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] scripts/manual/smoke/run.sh smoke-model-menu-overlap-m3304.mts
import { bootFixture, caseName, freshPage, matrix, mounted, seedChat, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-model-menu-overlap-m3304";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48990), instances: 4 });
const name = fx.instances[1]!.name;
await seedChat(fx as never, [name], 10);
const effort = { levels: ["low", "medium", "high", "xhigh", "max"], current: "high" };
// What a Claude agent's /model lists: the aliases (with their lines) and the account's models (id + display name).
const CHOICES = { ok: true, choices: { step: "model", current: "claude-opus-5-5", actions: ["refresh", "more"], options: [
  { id: "default", label: "default — account default" }, { id: "sonnet", label: "sonnet" }, { id: "opus", label: "opus" }, { id: "haiku", label: "haiku" },
  { id: "opusplan", label: "opusplan — opus plans, sonnet executes" }, { id: "Fable", label: "Fable — Claude Fable 5" },
  { id: "claude-opus-5-5", label: "✓ claude-opus-5-5 — Claude Opus 5.5", effort },
  { id: "claude-opus-5-5[1m]", label: "claude-opus-5-5[1m] — Claude Opus 5.5 (1M)", effort },
  { id: "claude-sonnet-5-5", label: "claude-sonnet-5-5 — Claude Sonnet 5.5", effort },
  { id: "claude-sonnet-5-5[1m]", label: "claude-sonnet-5-5[1m] — Claude Sonnet 5.5 (1M)", effort },
  { id: "claude-haiku-5-5", label: "claude-haiku-5-5 — Claude Haiku 5.5" },
  { id: "claude-fable-5-2", label: "claude-fable-5-2 — Claude Fable 5.2", effort },
  { id: "claude-opus-5-1", label: "claude-opus-5-1 — Claude Opus 5.1" }, { id: "claude-sonnet-5", label: "claude-sonnet-5 — Claude Sonnet 5" }] } };
const results: Array<{ name: string; ok: boolean; failed: string[]; m?: unknown }> = [];
const CASES = process.env.MATRIX ?? "desk-dark-zh-TW,desk-light-en,phone-dark-zh-TW,phone-light-en";
try {
  for (const c of matrix(CASES)) {
    for (const size of c.device === "desk" ? [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }] : [null]) {
      const tag = `${caseName(c as any)}${size ? `-${size.width}` : ""}`, failed: string[] = [];
      const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
      const p = await freshPage(fx, c as any, { account: "operator", path: `/ui/chat/${encodeURIComponent(name)}`, beforeNavigate: async (ctx: any, page: any) => {
        await ctx.addInitScript({ content: "window.__name = (f) => f" });
        if (size) await page.setViewportSize(size);
        await ctx.route("**/ui/command", async (r: any) => {
          const body = JSON.parse(r.request().postData() || "{}");
          return body.command === "model" && !body.args ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CHOICES) }) : r.continue();
        });
      } });
      const page = p.page;
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      await mounted(page, 30000); await page.waitForSelector("#msgIn", { timeout: 20000 });
      await page.evaluate(async (n: string) => { const m = await import("/assets/app-store.js");
        m.appStore.set((s: any) => ({ ...s, instances: (s.instances || []).map((i: any) => i.name === n ? { ...i, backend: "claude-code", model: "claude-opus-5-5", effort: "high" } : i) })); }, name);
      await page.waitForTimeout(600);
      let chip: any = null;
      if (c.device === "desk") {
        // The header's model button (as in the user's picture), else the composer's chip at a width that has no header one.
        const head = page.locator(".p-chat .panel-head .chat-model-entry").nth(1);
        const control = (await head.isVisible().catch(() => false)) ? head : page.locator(".p-chat .composer-pick");
        chip = await control.boundingBox(); await control.click();
      } else {
        const control = (await page.locator(".chat-meta-model").count()) ? page.locator(".chat-meta-model") : page.locator(".p-chat .composer-pick");
        await control.tap();
      }
      await page.waitForSelector(".model-menu", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
      const m = await page.evaluate(() => {
        const menu = document.querySelector(".model-menu") as HTMLElement | null;
        if (!menu) return null;
        const pop = (menu.closest(".model-menu-pop") || menu.closest("dialog.model-menu-sheet")) as HTMLElement | null;
        const scroller = (menu.closest(".model-menu-pop") || menu.closest(".dlg-box") || menu) as HTMLElement;
        const head = (menu.querySelector(".model-menu-head") || pop?.querySelector(".dlg-head, h2")) as HTMLElement | null;
        const row = menu.querySelector(".model-menu-row") as HTMLElement | null;
        const own = (el: HTMLElement | null) => { if (!el) return null; const r = el.getBoundingClientRect(); const x = r.left + Math.min(24, r.width / 2), y = r.top + r.height / 2;
          const at = document.elementFromPoint(x, y); return !!at && (el.contains(at) || at === el); };
        return { pop: pop ? pop.getBoundingClientRect().toJSON() : null, vw: innerWidth, vh: innerHeight, rows: menu.querySelectorAll(".model-menu-row").length,
          scrolls: scroller.scrollHeight > scroller.clientHeight + 1, headOwn: own(head), rowOwn: own(row), sheet: !!menu.closest("dialog.model-menu-sheet") };
      });
      need(m && m.pop, "the menu opened");
      if (m && m.pop) {
        need(m.rows === CHOICES.choices.options.length, `every model a row (${m.rows})`);
        need(m.pop.top >= 0 && m.pop.bottom <= m.vh + 0.5 && m.pop.left >= 0 && m.pop.right <= m.vw + 0.5, `inside the viewport (${JSON.stringify(m.pop)} in ${m.vw}×${m.vh})`);
        need(m.headOwn && m.rowOwn, `nothing draws over its head or first row (head ${m.headOwn}, row ${m.rowOwn})`);
        if (c.device === "desk") {
          need(chip && m.pop.top >= chip.y + chip.height - 0.5, `under its button (menu top ${Math.round(m.pop.top)}, button bottom ${Math.round(chip.y + chip.height)})`);
          need(chip && Math.abs(m.pop.left - Math.min(chip.x, m.vw - m.pop.width - 8)) <= 1.5, `its left at the button's (menu ${Math.round(m.pop.left)}, button ${Math.round(chip.x)})`);
          need(m.scrolls, "the long list scrolls within the menu");
        } else need(m.sheet, "a bottom sheet");
      }
      await page.screenshot({ path: shotPath(SMOKE, tag as any, "menu") });
      if (c.device === "desk" && m?.pop) {
        await page.evaluate(() => { const s = document.querySelector(".model-menu-pop") as HTMLElement | null; if (s) s.scrollTop = s.scrollHeight; });
        await page.waitForTimeout(200); await page.screenshot({ path: shotPath(SMOKE, tag as any, "menu-scrolled") });
      }
      need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
      results.push({ name: tag, ok: failed.length === 0, failed, m: m && { pop: m.pop, chip } });
      await p.ctx.close();
    }
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);

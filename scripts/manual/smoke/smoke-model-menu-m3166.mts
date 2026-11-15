// M-3166 PR 3 (the user's OK of round 2): /model as a menu, not a card above the box. A real Chrome on the shared fixture
// (in-process FleetManager, scratch home, loopback only, fake agents); /ui/command answers /model with a Claude agent's list
// (the shape the fleet sends: options with efforts, Refresh and More). Light/dark × en/zh-TW, on a desk and a phone. Judged:
//   desk  — the model control (the composer's chip under 1440 px, M-3167; the header's wider) opens a menu by it — above
//           the composer's, under the header's; its left near the control's —, no card;
//           one row per model (its short name, one line, ✓ on the current one), the effort row (the set one pressed),
//           More and Refresh; Escape closes it
//   phone — its model control opens the menu as a bottom sheet (the dialog), the same rows and effort, every control ≥ 44 px
// Everywhere: no page error. Pictures: <case>-menu.png. Run it on the base too (SMOKE_NAME=…-before): it FAILs (the card).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] scripts/manual/smoke/run.sh smoke-model-menu-m3166.mts
import { bootFixture, caseName, freshPage, matrix, mounted, seedChat, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-model-menu-m3166";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48980), instances: 4 });
const name = fx.instances[1]!.name;
await seedChat(fx as never, [name], 10);
const CHOICES = { ok: true, choices: { step: "model", current: "claude-opus-5-5", actions: ["refresh", "more"], options: [
  { id: "claude-opus-5-5", label: "✓ Opus 5.5 (claude-opus-5-5)", effort: { levels: ["low", "medium", "high", "max"], current: "high" } },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5 (claude-sonnet-5-5)", effort: { levels: ["low", "medium", "high", "max"], current: null } },
  { id: "claude-haiku-5-5", label: "Haiku 5.5 (claude-haiku-5-5)" }] } };
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-zh-TW,phone-dark-en")) {
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    const p = await freshPage(fx, c as any, { account: "operator", path: `/ui/chat/${encodeURIComponent(name)}`, beforeNavigate: async (ctx: any, page: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f" });
      if (c.device === "phone") { const s = await ctx.newCDPSession(page); await s.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } }); }
      await ctx.route("**/ui/command", async (r: any) => {
        const body = JSON.parse(r.request().postData() || "{}");
        return body.command === "model" && !body.args ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CHOICES) }) : r.continue();
      });
    } });
    const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await mounted(page, 30000); await page.waitForSelector("#msgIn", { timeout: 20000 });
    await page.evaluate(async (n: string) => { const m = await import("/assets/app-store.js");
      m.appStore.set((s: any) => ({ ...s, instances: (s.instances || []).map((i: any) => i.name === n ? { ...i, model: "claude-opus-5-5", effort: "high" } : i) })); }, name);
    await page.waitForTimeout(600);
    let chip: any = null;
    if (c.device === "desk") {
      // The model control a desk shows at this width: the header's chip (1440 px and wider) or the composer's (M-3167).
      const control = (await page.locator(".p-chat .composer-pick").isVisible().catch(() => false)) ? page.locator(".p-chat .composer-pick") : page.locator(".p-chat .panel-head .chat-model-entry").nth(1);
      chip = await control.boundingBox();
      await control.click();
    } else {   // a phone's Return is a new line: its model control (the meta line's, PR 1; else the composer's chip)
      const control = (await page.locator(".chat-meta-model").count()) ? page.locator(".chat-meta-model") : page.locator(".p-chat .composer-pick");
      await control.tap();
    }
    await page.waitForSelector(".model-menu", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => {
      const menu = document.querySelector(".model-menu") as HTMLElement | null;
      if (!menu) return null;
      const rows = [...menu.querySelectorAll(".model-menu-row")].map((r) => [(r.querySelector("b")?.textContent || "").trim(), (r.querySelector("small")?.textContent || "").trim(), r.getAttribute("aria-checked")]);
      const seg = [...menu.querySelectorAll(".model-menu-seg button")].map((b) => [(b.textContent || "").trim(), b.getAttribute("aria-pressed")]);
      const pop = menu.closest(".model-menu-pop") as HTMLElement | null, sheet = menu.closest("dialog.model-menu-sheet");
      const small = [...menu.querySelectorAll("button")].filter((b) => (b as HTMLElement).getBoundingClientRect().height < 44).length;
      return { rows, seg, more: !!menu.querySelector('[data-model-action="more"]'), refresh: !!document.querySelector('[data-model-action="refresh"]'),
        pop: pop ? pop.getBoundingClientRect().toJSON() : null, sheet: !!sheet, card: !!document.querySelector(".cmd-card"), small };
    });
    need(m && !m.card, `a menu, not the card (${JSON.stringify(m && { card: m.card })})`);
    if (m) {
      need(m.rows.map((r: any) => r[0]).join() === "Opus 5.5,Sonnet 5.5,Haiku 5.5" && m.rows.every((r: any) => r[1]) && m.rows[0][2] === "true",
        `one row per model, a line each, ✓ on Opus 5.5 (${JSON.stringify(m.rows)})`);
      need(m.seg.length === 4 && m.seg.filter((s: any) => s[1] === "true").length === 1, `the effort row, one pressed (${JSON.stringify(m.seg)})`);
      need(m.more && m.refresh, "More and Refresh");
      if (c.device === "desk") need(m.pop && chip && (m.pop.top >= chip.y + chip.height - 1 || m.pop.bottom <= chip.y + 1) && m.pop.right >= chip.x && m.pop.left <= chip.x + chip.width, `by the control (${JSON.stringify({ pop: m.pop, chip })})`);
      else need(m.sheet && m.small === 0, `a bottom sheet, every control ≥ 44 px (${m.sheet}, ${m.small} small)`);
    }
    await page.screenshot({ path: shotPath(SMOKE, caseName(c as any), "menu") });
    if (c.device === "desk") { await page.keyboard.press("Escape"); await page.waitForTimeout(300); need(!(await page.locator(".model-menu").count()), "Escape closes it"); }
    need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    results.push({ name: caseName(c as any), ok: failed.length === 0, failed });
    await p.ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);

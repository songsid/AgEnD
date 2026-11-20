// ui-gate: {"name": "Fleet authorization layout and typography", "hp": 19809}
// Real app + synthetic roster/contact DTOs. Headless only; never starts a Fleet or a vendor CLI.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture } from "../smoke-fixture/index.mts";
const OUT = join(process.env.OUT || ".artifacts/m3409", "authorizations-layout-m3409");
mkdirSync(OUT, { recursive: true });
const roster = [
  { name: "general", displayName: "General", backend: "codex", general: true },
  { name: "example-room", displayName: "Example room", backend: "codex" },
  { name: "release-helper", displayName: "Release helper", backend: "claude-code" },
  { name: "report-helper", displayName: "Report helper", backend: "codex" },
] as any;
const fx = await bootFixture({ port: Number(process.env.HP || 19809), roster, classic: false });
const person = { platform: "host", adapterId: "host", userId: "operator", label: "Example owner" };
const pending = { id: "R11111111-2222-4333-8444-555555555555", revision: 1, scope: "peer.dispatch", state: "pending", source: "example-room", target: "release-helper", sourceGeneration: "one", targetGeneration: "two", verb: "request_information",
  origin: { kind: "mixed", people: [person], receiptIds: [], chain: ["example-room", "report-helper"] },
  message: "Please summarize the release checklist and explain which checks are still pending.\n請整理發佈檢查清單，並說明還有哪些項目需要確認。",
  createdAt: "2026-11-19T08:00:00Z", expiresAt: "2026-11-26T08:00:00Z", canDecide: true };
const decided = { ...pending, id: "R22222222-2222-4333-8444-555555555555", state: "delivered", canDecide: false, decidedAt: "2026-11-19T09:00:00Z", decidedBy: person };
const results: any[] = [];
const cases = [
  { name: "desktop-en-sidebar-open", device: "desk", theme: "light", lang: "en" },
  { name: "desktop-zh-sidebar-open", device: "desk", theme: "dark", lang: "zh-TW" },
  { name: "desktop-zh-sidebar-collapsed", device: "desk", theme: "dark", lang: "zh-TW", collapsed: true },
  { name: "desktop-zh-large", device: "desk", theme: "dark", lang: "zh-TW", collapsed: true, large: true },
  { name: "phone-zh", device: "phone", theme: "dark", lang: "zh-TW" },
  { name: "phone-en", device: "phone", theme: "light", lang: "en" },
  { name: "desktop-zh-empty", device: "desk", theme: "dark", lang: "zh-TW", empty: true },
  { name: "phone-zh-empty", device: "phone", theme: "dark", lang: "zh-TW", empty: true },
];
try {
  for (const c of cases) {
    const { ctx, page, csp } = await fx.page(c as any, { storage: { agend_sidebar: c.collapsed ? "hidden" : "shown", agend_text_size: c.large ? "l" : "m" } });
    const errors: string[] = []; page.on("pageerror", (e: any) => errors.push(String(e)));
    await ctx.route("**/ui/api/contact-authorizations**", (route: any) => {
      const u = new URL(route.request().url());
      const data = u.pathname.endsWith("/" + pending.id) ? pending : { items: c.empty ? [] : u.searchParams.get("status") === "pending" ? [pending] : [pending, decided], nextCursor: null };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto(fx.base + "/ui/fleet/authorizations");
    await page.locator(c.empty ? ".contact-auth-page .empty" : ".contact-ticket").waitFor();
    if (!c.empty) { await page.locator(".contact-filters .seg-inline button").nth(1).click(); await page.locator('[data-state="delivered"]').waitFor(); }
    await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(250);
    const metrics = await page.evaluate(`(() => {
      const root = document.querySelector(".contact-auth-page"), card = root.querySelector(".contact-ticket"), msg = root.querySelector(".contact-ticket-message"), foot = root.querySelector(".contact-ticket-times");
      const cs = (e) => e ? getComputedStyle(e) : null;
      const sample = document.createElement("button"); sample.className = "seg-item"; sample.textContent = "Sample"; root.appendChild(sample);
      const segmentReset = cs(sample).borderTopWidth === "0px" && cs(sample).backgroundColor === "rgba(0, 0, 0, 0)";
      sample.classList.add("active");
      const segmentActive = cs(sample).backgroundColor !== "rgba(0, 0, 0, 0)";
      sample.remove();
      const buttons = [...root.querySelectorAll(".contact-filters .btn")];
      const filters = root.querySelector(".contact-filters").getBoundingClientRect();
      const agent = root.querySelector(".contact-agent-filter").getBoundingClientRect();
      return { segmentReset, segmentActive, wide: !!document.querySelector(".p-fleet .col-wide"), overflow: document.documentElement.scrollWidth > innerWidth,
        oneRow: agent.top < filters.top + agent.height, reset: buttons.every(b => cs(b).borderTopStyle !== "outset"),
        recessed: !msg || cs(msg).backgroundColor !== cs(card).backgroundColor,
        hierarchy: !msg || parseFloat(cs(foot).fontSize) < parseFloat(cs(msg).fontSize),
        cards: root.querySelectorAll(".contact-ticket").length, hiddenIds: !root.textContent.includes("example-room") && !root.textContent.includes("release-helper"),
        noPrivateIds: !/-t\d{6,}/.test(document.body.innerText), emptyHint: !!root.querySelector(".empty-hint"),
        tap: innerWidth >= 900 || buttons.every(b => b.getBoundingClientRect().height >= 44),
        large: document.documentElement.dataset.textSize === "l" };
    })()`);
    if (!metrics.segmentReset || !metrics.segmentActive || !metrics.wide || metrics.overflow || !metrics.reset || !metrics.recessed || !metrics.hierarchy || !metrics.noPrivateIds || !metrics.tap || (!c.empty && !metrics.hiddenIds) || (c.device === "desk" && !metrics.oneRow) || (c.large && !metrics.large) || (c.empty && !metrics.emptyHint) || errors.length || (await csp()).length) throw Error(JSON.stringify({ case: c.name, metrics, errors, csp: await csp() }));
    await page.screenshot({ path: join(OUT, c.name + ".png") });
    if (!c.empty && c.device === "phone") {
      await page.locator('[data-state="delivered"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(OUT, c.name + "-decided.png") });
    }
    if (c.empty) { await page.locator(".empty button").click(); await page.waitForFunction(() => !document.querySelector(".empty button")); }
    else {
      await page.goto(fx.base + "/ui/fleet/authorizations?ticket=" + pending.id);
      await page.locator(".contact-ticket.focus").waitFor();
      const focus = await page.locator(".contact-ticket.focus").evaluate((e: Element) => ({ border: getComputedStyle(e).borderTopStyle, shadow: getComputedStyle(e).boxShadow }));
      if (focus.border !== "solid" || focus.shadow === "none") throw Error("Focus border missing");
    }
    results.push({ case: c.name, ...metrics, errors: 0, csp: 0 });
    await ctx.close();
  }
  writeFileSync(join(OUT, "result.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`Authorization layout: ${results.length} real-app views passed`);
} finally { await fx.close(); }

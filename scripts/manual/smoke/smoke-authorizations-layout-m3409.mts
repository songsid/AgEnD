// ui-gate: {"name": "Fleet authorization layout and typography", "hp": 19809}
// Real app + synthetic roster/contact DTOs. Headless only; never starts a Fleet or a vendor CLI.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture } from "../smoke-fixture/index.mts";
const BEFORE = process.env.BEFORE === "1";
const OUT = join(process.env.OUT || ".artifacts/m3409", "authorizations-layout-m3409");
mkdirSync(OUT, { recursive: true });
const roster = [
  { name: "general", displayName: "General", backend: "codex", general: true },
  { name: "example-room", displayName: "Example room", backend: "codex" },
  { name: "release-helper", displayName: "Release helper", backend: "claude-code" },
  { name: "report-helper", displayName: "Report helper", backend: "codex" },
] as any;
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP || 19809), roster, classic: false });
const person = { platform: "host", adapterId: "host", userId: "operator", label: "Example owner" };
const pending = { id: "R11111111-2222-4333-8444-555555555555", revision: 1, scope: "peer.dispatch", state: "pending", source: "example-room", target: "release-helper", sourceGeneration: "one", targetGeneration: "two", verb: "request_information",
  // One known person opens the explicit scoped grant dialog; multi-person selection has its own controls.
  origin: { kind: "human", people: [person], receiptIds: [], chain: ["example-room", "report-helper"] },
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
  { name: "desktop-en-medium", device: "desk", theme: "light", lang: "en", width: 1024 },
  { name: "desktop-zh-narrow", device: "desk", theme: "dark", lang: "zh-TW", width: 900 },
  { name: "phone-zh-long", device: "phone", theme: "dark", lang: "zh-TW", long: true },
];
try {
  for (const c of cases) {
    const { ctx, page, csp } = await fx.page(c as any, { storage: { agend_sidebar: c.collapsed ? "hidden" : "shown", agend_text_size: c.large ? "l" : "m" } });
    if (c.width) await page.setViewportSize({ width: c.width, height: 900 });
    const errors: string[] = []; page.on("pageerror", (e: any) => errors.push(String(e)));
    await ctx.route("**/ui/api/contact-authorizations**", (route: any) => {
      const u = new URL(route.request().url());
      const origin = c.long ? { ...pending.origin, people: [{ ...person, label: "Example owner with a deliberately long name for authorization review and another long phrase" }] } : pending.origin;
      const currentPending = { ...pending, origin }, currentDecided = { ...decided, origin, decidedBy: origin.people[0] };
      const data = u.pathname.endsWith("/" + pending.id) ? currentPending : { items: c.empty ? [] : u.searchParams.get("status") === "pending" ? [currentPending] : [currentPending, currentDecided], nextCursor: null };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto(fx.base + "/ui/fleet/authorizations");
    await page.locator(c.empty ? ".contact-auth-page .empty" : ".contact-ticket").waitFor();
    if (!c.empty) { await page.locator(".contact-filters [role=group] button").nth(1).click(); await page.locator('[data-state="delivered"]').waitFor(); }
    if (c.long) await page.evaluate(async () => {
      const m: any = await import("/assets/app-store.js");
      m.appStore.set({ instances: m.appStore.get().instances.map((i: any) => ({ ...i, display_name: "Example release planning and verification helper with a deliberately long display name · " + (i.display_name || "Example") })) });
    });
    await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(250);
    if (!BEFORE && !c.empty) {
      await page.locator('[data-state="pending"]').first().getByRole("button", { name: c.lang === "en" ? "Allow this person to contact this agent…" : "允許這個人聯絡此 Agent…", exact: true }).click();
      const grant = page.locator("dialog.contact-grant-dialog[open]"); await grant.waitFor();
      const fields = await grant.locator('input:not([type=checkbox]), select, .check').evaluateAll((els: Element[]) => els.map(e => ({ field: e.matches("input, select"), font: parseFloat(getComputedStyle(e).fontSize), h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width })));
      if (c.device === "phone" && fields.some((f: any) => f.field && f.font < 16 || f.h < 44 || f.w < 44)) throw Error("Phone grant fields are too small: " + JSON.stringify(fields));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      const grantOverflow = await grant.evaluate((el: Element) => el.scrollWidth > el.clientWidth);
      if (overflow || grantOverflow) throw Error("Grant dialog overflows");
      await grant.getByRole("button", { name: c.lang === "en" ? "Cancel" : "取消", exact: true }).click();
      await grant.waitFor({ state: "detached" });
      await page.locator('.contact-ticket-origin .link-btn').first().click();
      const clear = page.locator('.contact-person-filter .chip-x'); await clear.waitFor();
      const chip = await clear.boundingBox();
      if (c.device === "phone" && (!chip || chip.width < 44 || chip.height < 44)) throw Error("Person filter clear target is too small");
      await clear.click(); await page.waitForFunction(() => !document.querySelector('.contact-person-filter'));
    }
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
        tap: innerWidth >= 900 || [...root.querySelectorAll("button:not(:disabled), select")].every(b => { const r = b.getBoundingClientRect(); return r.height >= 44 && r.width >= 44; }),
        inputSize: innerWidth >= 900 || parseFloat(cs(root.querySelector("select")).fontSize) >= 16,
        sharedCard: !card || cs(card).borderTopStyle === "none",
        sharedStatus: !card || !!card.querySelector(".tag.contact-ticket-state"),
        straightBar: !card || (card.classList.contains("lbar") && getComputedStyle(card, "::before").width === "3px" && getComputedStyle(card, "::before").borderTopLeftRadius === "0px"),
        large: document.documentElement.dataset.textSize === "l" };
    })()`);
    if (!metrics.noPrivateIds || errors.length || (await csp()).length) throw Error("Page errors, CSP or private identifier in fixture view");
    if (!BEFORE && (!metrics.segmentReset || !metrics.segmentActive || !metrics.wide || metrics.overflow || !metrics.reset || !metrics.recessed || !metrics.hierarchy || !metrics.noPrivateIds || !metrics.tap || !metrics.inputSize || !metrics.sharedCard || !metrics.sharedStatus || !metrics.straightBar || (!c.empty && !metrics.hiddenIds) || (c.device === "desk" && !metrics.oneRow) || (c.large && !metrics.large) || (c.empty && !metrics.emptyHint) || errors.length || (await csp()).length)) throw Error(JSON.stringify({ case: c.name, metrics, errors, csp: await csp() }));
    await page.screenshot({ path: join(OUT, c.name + ".png") });
    if (!c.empty && c.device === "phone") {
      await page.locator('[data-state="delivered"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(OUT, c.name + "-decided.png") });
    }
    if (BEFORE) { /* Baseline evidence only: expected style violations are measured, not accepted. */ }
    else if (c.empty) { await page.locator(".empty button").click(); await page.waitForFunction(() => !document.querySelector(".empty button")); }
    else {
      await page.goto(fx.base + "/ui/fleet/authorizations?ticket=" + pending.id);
      await page.locator(".contact-ticket.focus").waitFor();
      const focus = await page.locator(".contact-ticket.focus").evaluate((e: Element) => ({ outline: getComputedStyle(e).outlineStyle, bar: getComputedStyle(e, "::before").width }));
      if (focus.outline !== "solid" || focus.bar !== "3px") throw Error("Focus border missing");
    }
    results.push({ case: c.name, ...metrics, errors: errors.length, csp: (await csp()).length });
    await ctx.close();
  }
  writeFileSync(join(OUT, "result.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`Authorization layout: ${results.length} real-app views: ${BEFORE ? "baseline captured" : "PASS"}`);
} finally { await fx.close(); }

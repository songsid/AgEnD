// M-3443 (the user, 11-20): the one info icon (src/ui/shared/info-tip.js; ui-style-guide rule 14) in the real app — a
// Settings field's ⓘ (Agent defaults) and the usage dialog's "No agents on this profile" ⓘ, opened by a tap, on a desk and
// a phone. The shared fixture (in-process FleetManager, scratch home, loopback only, fake agents); /api/ai-usage scripted.
// Per case: the ⓘ is a button; a tap opens its bubble (role=tooltip, inside the window) and keeps it; Esc closes it; on a
// phone the button's box is the --tap size (44px); the usage row's ⓘ in a compact row is no control. No page error or CSP
// report; no chat-id shape on a capture.
//   PW_DIR=<playwright-core dir> REPO=<checkout> OUT=<dir> [MATRIX=…] npx tsx scripts/manual/smoke/smoke-info-tip-m3443.mts
// ui-gate: {"name": "Info icon: Settings and usage, tap opens, Esc closes (M-3443)", "hp": 48443}
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";
import { fixtureInstances } from "../smoke-fixture/data.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-info-tip-m3443";
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
mkdirSync(OUT, { recursive: true });
const CHAT_ID = /-t\d{6,}/;
const roster = fixtureInstances().filter((i) => ["general", "docs-site-builder"].includes(i.name));
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 48443), roster, classic: false });
fx.fm.getActiveUsageProviderIds = () => null;
const pct = (label: string, used: number) => ({ type: "percent", label, used, windowMs: 168 * 3_600_000 });
const PROVIDERS = [
  { id: "codex", name: "Codex", status: "ok", metrics: [pct("Weekly", 86)] },
  { id: "codex:wii", name: "Codex (wii)", profile: "wii", noAgents: true, status: "ok", metrics: [pct("Weekly", 45)] },
];
const r: Record<string, unknown> = {};
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const started = Date.now();
try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,phone-dark-zh-TW,desk-dark-zh-TW,phone-light-en")) {
    const cn = caseName(c), phone = c.device === "phone";
    const { ctx, page, csp } = await fx.page(c, { path: "/settings/agent-defaults", storage: { agend_usage_rail: "1" } });
    await page.addInitScript({ content: "window.__name = (f) => f;" });
    await ctx.route(/\/api\/ai-usage(\?.*)?$/, (rt: any) => rt.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ fetchedAt: new Date().toISOString(), providers: PROVIDERS }) }));
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const leaks: string[] = [];
    const shoot = async (name: string) => {
      const m = ((await page.evaluate(() => document.body.innerText)) as string).match(new RegExp(CHAT_ID.source, "g"));
      if (m) { leaks.push(name); return; }
      await page.screenshot({ path: shotPath(SMOKE, cn, name) });
    };
    /** The open bubble: its words, inside the window; the button's box. */
    const state = (btnSel: string) => page.evaluate((sel: string) => {
      const b = document.querySelector(sel) as HTMLElement | null; if (!b) return null;
      const body = document.getElementById(b.getAttribute("aria-describedby") || "") as HTMLElement | null;
      const br = b.getBoundingClientRect(), r = body && !body.hidden ? body.getBoundingClientRect() : null;
      const ir = (b.querySelector("svg") || b).getBoundingClientRect();
      return { tag: b.tagName, expanded: b.getAttribute("aria-expanded"), box: [Math.round(br.width), Math.round(br.height)],
        open: !!r, inside: !!r && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, text: body?.textContent || "",
        // By its ⓘ: just under or over it, and overlapping it sideways (its containing block may not be the window).
        near: !!r && ((r.top >= ir.bottom && r.top - ir.bottom <= 12) || (r.bottom <= ir.top && ir.top - r.bottom <= 12)) && r.left <= ir.right && r.right >= ir.left - 8 };
    }, btnSel);
    // 1. A Settings field's ⓘ.
    await page.waitForSelector(".s-lab .info-tip-btn", { timeout: 20000 }); await page.waitForTimeout(500);
    const sBtn = ".s-lab .info-tip-btn";
    await page.locator(sBtn).first().scrollIntoViewIfNeeded();
    await page.locator(sBtn).first().click(); await page.waitForTimeout(300);
    const s1 = await state(sBtn);
    check(`${cn}:settings-tap`, !!s1 && s1.tag === "BUTTON" && s1.expanded === "true" && s1.open && s1.inside && s1.near && s1.text.length > 10, s1);
    check(`${cn}:settings-tap-box`, !!s1 && (phone ? s1.box[0] >= 44 && s1.box[1] >= 44 : s1.box[0] === 18), s1?.box);
    await shoot("1-settings-info-open");
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
    check(`${cn}:settings-esc`, (await state(sBtn))?.open === false);
    if (!phone) {
      // #4274 review: a hover covers the ⓘ and its bubble (the pointer may cross into it); leaving both closes it.
      // (The click above left the pointer on the ⓘ: away first, so the hover is a new one.)
      await page.mouse.move(2, 2); await page.waitForTimeout(250);
      const b = page.locator(sBtn).first(); await b.hover(); await page.waitForTimeout(200);
      const bb = await page.evaluate((sel: string) => { const x = document.getElementById(document.querySelector(sel)!.getAttribute("aria-describedby")!)!.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; }, sBtn);
      await page.mouse.move(bb.x, bb.y, { steps: 4 }); await page.waitForTimeout(350);
      check(`${cn}:settings-hover-into-bubble`, (await state(sBtn))?.open === true);
      await page.mouse.move(2, 2); await page.waitForTimeout(350);
      check(`${cn}:settings-hover-leave`, (await state(sBtn))?.open === false);
      // #4274 review: pinned by a click, then the keyboard focus leaves: it closes (a later Esc is not taken).
      await b.click(); await page.waitForTimeout(150); await page.keyboard.press("Tab"); await page.waitForTimeout(200);
      check(`${cn}:settings-pinned-blur`, (await state(sBtn))?.open === false);
    }
    // 2. The usage dialog (desk: the rail; phone: the header's usage button), the full card's ⓘ.
    await page.goto(`${fx.base}/ui/chat/${encodeURIComponent("general")}`); await page.waitForTimeout(1500);
    // A phone opens usage from the header's ⋯ sheet (M-3166); a desk shows it in the rail.
    if (phone) {
      await page.click(".chat-sheet-more"); await page.waitForTimeout(500);
      await page.locator(".chat-sheet-tile").filter({ hasText: /^(Usage|用量)$/ }).click(); await page.waitForTimeout(1200);
    }
    const scope = phone ? "dialog[open]" : ".u-rail";
    const uBtn = `${scope} .u-na-tip .info-tip-btn`;
    await page.waitForSelector(uBtn, { timeout: 15000 });
    await page.locator(uBtn).first().scrollIntoViewIfNeeded();
    await page.locator(uBtn).first().click(); await page.waitForTimeout(300);
    const u1 = await state(uBtn);
    check(`${cn}:usage-tap`, !!u1 && u1.open && u1.inside && u1.near && /No agents on this profile|此帳號目前沒有 Agent/.test(u1.text), u1);
    await shoot("2-usage-info-open");
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
    check(`${cn}:usage-esc-keeps-dialog`, (await state(uBtn))?.open === false && (phone ? await page.locator("dialog[open]").count() === 1 : true));
    check(`${cn}:no-page-error`, errs.length === 0 && (await csp()).length === 0, errs);
    check(`${cn}:no-chat-id-shape`, leaks.length === 0, leaks);
    await ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  r.seconds = Math.round((Date.now() - started) / 1000);
  const json = JSON.stringify(r, null, 1);
  writeFileSync(join(OUT, "result.json"), CHAT_ID.test(json) ? JSON.stringify({ withheld: "chat-id shape" }) : json);
  for (const f of fail.slice(0, 30)) console.log(`FAIL ${f}: ${JSON.stringify((r[f] as any)?.FAIL ?? r.error ?? "").slice(0, 600)}`);
  console.log(fail.length ? `M-3443 smoke FAILED (${fail.length}) in ${r.seconds}s — ${OUT}` : `M-3443 smoke passed in ${r.seconds}s (${Object.keys(r).length - 1} checks)`);
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}

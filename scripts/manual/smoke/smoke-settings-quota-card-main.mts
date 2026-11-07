// alpha.6 feedback (#3), main twin of #3320: Settings → Notifications' quota card on main, in a real browser on the shared
// fixture (the product's own web server from an in-process FleetManager, a scratch home, no fleet start).
// Full matrix (desk/phone × light/dark × en/zh-TW):
//   - the quota card is a Settings card like main's others: filled like them, its title an h3 (not a page-size h2 on the
//     page background), its fields in the grid on a desk, nothing past the column;
//   - every main Settings section with a long option in every select (a long model or agent name): nothing past the column;
//   - no page error, no CSP report, no horizontal scroll.
// SKEW: the old settings-quota-notice.js with this shell, and this module with the OLD app.css: both draw, no error.
// LABEL=base: the before pictures only.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [LABEL=base|branch] [OLD_REF=songsid/main] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-settings-quota-card-main.mts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-settings-quota-card-main";
const REPO = process.env.REPO!, LABEL = process.env.LABEL ?? "branch", BASE = LABEL === "base";
const OLD = process.env.OLD_REF ?? "songsid/main";
const r: Record<string, unknown> = { label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const { SETTINGS_SECTIONS } = await import(REPO + "/src/ui/shared/app-route.js");
const LONG = "claude-opus-5-5-20261101-extended-context-preview-with-a-very-long-model-identifier [1m] (agent DESKTOP-ABCDEFGHIJ)";
const OVER = `(() => { const col = document.querySelector(".p-settings .panel-body > .col"); if (!col) return { missing: true }; const cb = col.getBoundingClientRect(); const over = [];
  for (const el of col.querySelectorAll("*")) { const s = getComputedStyle(el), b = el.getBoundingClientRect(); if (s.display === "none" || s.visibility === "hidden" || !b.width || el.closest("[hidden]")) continue;
    let clipped = false; for (let a = el.parentElement; a && a !== col; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o !== "visible") { clipped = a.getBoundingClientRect().right <= cb.right + 1; break; } }
    if (!clipped && b.right > cb.right + 1) over.push(el.tagName.toLowerCase() + "." + String(el.className).split(" ")[0] + "#" + el.id + " +" + Math.round(b.right - cb.right)); }
  return { over: over.slice(0, 8), n: over.length, pageX: document.documentElement.scrollWidth - innerWidth }; })()`;
const CARD = `(() => { const c = document.querySelector("#quota-notices"); if (!c) return null; const s = getComputedStyle(c), body = getComputedStyle(document.body);
  const ref = [...document.querySelectorAll(".p-settings .card")].find((x) => x !== c);
  const f = document.querySelector("#qn-target")?.closest(".field")?.getBoundingClientRect(), g = document.querySelector("#qn-scope")?.closest(".field")?.getBoundingClientRect();
  return { cls: c.className, h2: !!c.querySelector("h2"), h3: c.querySelector("h3")?.textContent ?? "", bg: s.backgroundColor, pageBg: body.backgroundColor, refBg: ref ? getComputedStyle(ref).backgroundColor : null,
    radius: s.borderTopLeftRadius, sideBySide: !!f && !!g && Math.abs(f.top - g.top) < 2 && g.left > f.right }; })()`;
const fx = await bootFixture({ port: 47430, instances: 8 });
try {
  for (const c of matrix()) {
    const cn = caseName(c);
    const { ctx, page, csp } = await fx.page(c, { path: "/settings/notifications" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.waitForSelector("#quota-notices", { timeout: 15000 }); await page.waitForTimeout(700);
    const card = await page.evaluate(CARD) as any;
    const extra = await page.evaluate(`(() => { const b = document.querySelector(".p-settings .panel-body"); return b ? b.scrollHeight - b.clientHeight : 0; })()`) as number;
    if (extra > 0) { await page.setViewportSize({ width: VIEWPORTS[c.device].width, height: Math.min(VIEWPORTS[c.device].height + extra + 40, 6000) }); await page.waitForTimeout(250); }
    await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-notifications`) });
    await page.setViewportSize(VIEWPORTS[c.device]);
    if (BASE) { r[cn] = { card }; await ctx.close(); continue; }
    const longs: Record<string, unknown> = {};
    for (const section of SETTINGS_SECTIONS as string[]) {
      await page.goto(`${fx.base}/settings/${section}`); await page.waitForSelector(".p-settings .panel-body > .col", { timeout: 15000 }); await page.waitForTimeout(700);
      await page.evaluate(`(() => { document.querySelectorAll(".p-settings details").forEach((d) => { d.open = true; }); document.querySelectorAll(".p-settings .panel-body select").forEach((s) => { const o = document.createElement("option"); o.textContent = ${JSON.stringify(LONG)}; s.appendChild(o); }); })()`);
      await page.waitForTimeout(250);
      const m = await page.evaluate(OVER) as any;
      if (m.missing || m.n || m.pageX > 0) { longs[section] = m; await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-long-${section}`) }); }
    }
    const cspNow = await csp();
    check(cn, !!card && card.cls === "card" && !card.h2 && card.h3.length > 0 && card.bg !== card.pageBg && (card.refBg === null || card.bg === card.refBg)
      && (c.device === "phone" || card.sideBySide) && Object.keys(longs).length === 0 && errs.length === 0 && cspNow.length === 0, { card, longs, errs, csp: cspNow });
    await ctx.close();
  }
  if (!BASE) {
    const old = (f: string) => execFileSync("git", ["-C", REPO, "show", `${OLD}:src/ui/${f}`], { encoding: "utf8", maxBuffer: 64 << 20 });
    for (const [way, re, file] of [["old-module", /\/ui\/js\/settings-quota-notice\.js(\?.*)?$/, "settings-quota-notice.js"], ["old-css", /\/assets\/app\.css(\?.*)?$/, "shared/app.css"]] as const) {
      const c = matrix("desk-dark-zh-TW")[0]!;
      const { ctx, page } = await fx.page(c, { path: "/settings/agents" });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      let served = 0;
      await page.route(re, (route: any) => { served++; return route.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body: old(file) }); });
      await page.goto(`${fx.base}/settings/notifications`); await page.waitForSelector("#quota-notices", { timeout: 15000 }); await page.waitForTimeout(700);
      await page.screenshot({ path: shotPath(SMOKE, `skew-${way}`, `${LABEL}-notifications`) });
      const fields = await page.evaluate(`["qn-target", "qn-scope", "qn-enabled", "qn-thresholds", "qn-periods"].every((id) => !!document.getElementById(id))`);
      check(`skew-${way}`, served > 0 && fields === true && errs.length === 0, { served, fields, errs });
      await ctx.close();
    }
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : BASE ? "RECORDED" : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}

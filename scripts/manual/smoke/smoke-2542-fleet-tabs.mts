// M-2542: Fleet's tabs (Tasks · Schedules · Teams · Org chart · Cache · Usage) share the title row on a desktop — the title,
// the tabs, then the header's tools (docs, text size, the usage rail toggle) — saving a line. Under 900 px they stay the
// row under the header they were (.seg, chosen by the panel, following resizes); at 360 px nothing scrolls sideways.
// Per case: all six tabs present with the open one visible; on a desk they are in the header, on the title's centre
// line, the header one row (also at 900 px); on a phone under the header; resizing moves them across and back; the
// page never overflows sideways (also at 360 px for a phone case); no page errors.
// SKEW=<dir with the previous release's app.css>: the new panel with that cached stylesheet — no sideways overflow, the
// tabs still usable (in the header they are not .seg, whose older rule is a full-width row; on a phone they are the
// old markup).
//   PW_DIR=… REPO=<checkout> OUT=<dir> [SKEW=<dir>] [BEFORE=1] FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-2542-fleet-tabs.mts
// BEFORE=1 on a checkout without this change: the same screenshots, the old layout (tabs under the header), no assertions.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.BEFORE ? "smoke-2542-fleet-tabs-before" : "smoke-2542-fleet-tabs";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48925), classic: false });
fx.fm.getInstanceStatus = () => "running";
const results: Array<{ name: string; failed: string[]; info?: unknown }> = [];
const record = (name: string, failed: string[], info?: unknown) => { results.push({ name, failed, info }); console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? ` [${failed.join(", ")}]` : ""}${info ? " " + JSON.stringify(info).slice(0, 400) : ""}`); };

const READ = `(() => {
  const head = document.querySelector(".p-fleet .panel-head");
  const nav = document.querySelector(".p-fleet nav[data-trust='panel-navigation']");
  const h1 = head && head.querySelector("h1");
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height }; };
  const items = nav ? [...nav.querySelectorAll("a.seg-item")] : [];
  const active = nav && nav.querySelector("a.seg-item.active");
  const ar = active && active.getBoundingClientRect();
  return { inHeader: !!(head && nav && head.contains(nav)), tabs: items.length, head: head && r(head), h1: h1 && r(h1), nav: nav && r(nav),
    activeVisible: !!(ar && ar.width > 0 && ar.left >= 0 && ar.right <= innerWidth), scrollW: document.documentElement.scrollWidth, innerW: innerWidth,
    tools: head ? head.querySelectorAll(".panel-actions > *").length : 0 };
})()`;

async function open(c: { device: "desk" | "phone"; theme: "light" | "dark"; lang: "en" | "zh-TW" }, css?: string) {
  const p = await freshPage(fx, c);
  const errors: string[] = [];
  p.page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
  if (css) await p.page.route("**/assets/app.css*", (r: any) => r.fulfill({ status: 200, contentType: "text/css", body: css }));
  await mounted(p.page, 30000);
  await p.page.goto(new URL("/ui/fleet", p.page.url()).href);
  await p.page.locator(".p-fleet").waitFor({ timeout: 15000 });
  await p.page.waitForTimeout(800);
  return { ...p, errors };
}

const CASES = [
  { device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "en" },
  { device: "desk", theme: "light", lang: "zh-TW" }, { device: "desk", theme: "dark", lang: "zh-TW" },
  { device: "phone", theme: "light", lang: "zh-TW" }, { device: "phone", theme: "dark", lang: "zh-TW" },
] as const;
for (const c of CASES) {
  const name = `${c.device}-${c.theme}-${c.lang}`, failed: string[] = [];
  const ok = (k: string, v: boolean) => { if (!v) failed.push(k); };
  const p = await open(c);
  await p.page.screenshot({ path: shotPath(SMOKE, c as any, "fleet"), clip: { x: 0, y: 0, width: p.page.viewportSize().width, height: Math.min(260, p.page.viewportSize().height) } });
  const v = await p.page.evaluate(READ) as any;
  let narrow: any = null;
  if (c.device === "phone") {
    await p.page.setViewportSize({ width: 360, height: 740 });
    await p.page.waitForTimeout(400);
    narrow = await p.page.evaluate(READ);
    await p.page.screenshot({ path: shotPath(SMOKE, c as any, "fleet-360"), clip: { x: 0, y: 0, width: 360, height: 260 } });
  }
  if (!process.env.BEFORE) {
    ok("six tabs", v.tabs === 6);
    ok("the open tab visible", v.activeVisible);
    ok("header tools kept", v.tools >= 2);
    ok("no sideways overflow", v.scrollW <= v.innerW);
    if (c.device === "desk") {
      ok("tabs in the header", v.inHeader);
      const mid = (v.nav.top + v.nav.bottom) / 2;
      ok("tabs on the title's row", mid > v.h1.top - 4 && mid < v.h1.bottom + 4);
      ok("the header is one row", v.head.h <= 64);
      await p.page.setViewportSize({ width: 900, height: 740 }); await p.page.waitForTimeout(400);
      const w9 = await p.page.evaluate(READ) as any;
      ok("900 px: in the header, one row, no overflow", w9.inHeader && w9.head.h <= 64 && w9.scrollW <= w9.innerW && w9.activeVisible);
      await p.page.setViewportSize({ width: 800, height: 740 }); await p.page.waitForTimeout(400);
      const w8 = await p.page.evaluate(READ) as any;
      ok("resized under 900 px: the row under the header", !w8.inHeader && w8.tabs === 6 && w8.nav.top >= w8.h1.bottom - 2);
    } else {
      ok("tabs under the header", !v.inHeader);
      ok("tabs on their own row under the title", v.nav.top >= v.h1.bottom - 2);
      ok("360 px: no sideways overflow", narrow.scrollW <= narrow.innerW);
      ok("360 px: the open tab visible", narrow.activeVisible);
    }
    ok("no page errors", p.errors.length === 0);
  }
  record(name, failed, { head: Math.round(v.head?.h ?? 0), inHeader: v.inHeader, scrollW: v.scrollW, innerW: v.innerW, narrow: narrow && { scrollW: narrow.scrollW, innerW: narrow.innerW }, errors: p.errors.slice(0, 2) });
  await p.ctx.close();
}

const S = process.env.SKEW;
if (S && existsSync(join(S, "app.css")) && !process.env.BEFORE) {
  const old = readFileSync(join(S, "app.css"), "utf8");
  for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
    const failed: string[] = [];
    const p = await open(c, old);
    const v = await p.page.evaluate(READ) as any;
    if (v.inHeader !== (c.device === "desk") || v.tabs !== 6) failed.push("tabs present");
    if (v.scrollW > v.innerW) failed.push("no sideways overflow");
    if (c.device === "phone") {
      await p.page.setViewportSize({ width: 360, height: 740 }); await p.page.waitForTimeout(400);
      const n = await p.page.evaluate(READ) as any;
      if (n.scrollW > n.innerW) failed.push("360 px: no sideways overflow");
    }
    if (p.errors.length) failed.push("no page errors");
    await p.page.screenshot({ path: shotPath(SMOKE, c as any, "skew-old-css"), clip: { x: 0, y: 0, width: p.page.viewportSize().width, height: 260 } });
    record(`SKEW old app.css ${c.device}-${c.theme}-${c.lang}`, failed, { scrollW: v.scrollW, innerW: v.innerW });
    await p.ctx.close();
  }
}
const out = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
try { writeFileSync(join(out, "result.json"), JSON.stringify(results, null, 2)); } catch { /* best effort */ }
await fx.close();
process.exit(results.some((r) => r.failed.length) ? 1 : 0);

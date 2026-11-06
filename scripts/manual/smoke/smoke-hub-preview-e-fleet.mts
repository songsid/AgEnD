// Hub E (issue #3226): the fleet's HTML side panel moves to src/ui/shared/ (served under /assets/ to the fleet and the
// Hub), and the fleet's /ui/js/preview-panel.js registers the two pieces only the fleet shows (Files & changes, a page's
// Share). Nothing on the fleet's pages may change: this smoke records the DOM of the panel — an HTML page opened from
// its card and running at the real preview listener (its bar: Share page, Point at it, Reply about this page), then the
// chat's ⋯ → Files & changes — on the realistic fixture (never `fleet start`), desk light/en and phone dark/zh-TW, so a
// run on the base and a run on the branch can be compared byte for byte (dom-<label>.json), plus screenshots.
// SKEW (branch only, OLD_REF set): a tab opened before the move — its panel-chat.js (importing ./preview-panel.js and
// ./preview-panel-actions.js, now the fleet's wrapper and a re-export) with today's server.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> LABEL=base|branch [OLD_REF=songsid/release/2.3.5-alpha] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-hub-preview-e-fleet.mts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-hub-preview-e-fleet";
const REPO = process.env.REPO!, LABEL = process.env.LABEL ?? "branch", OLD_REF = process.env.OLD_REF ?? "";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48740), instances: 2 });
const fm = fx.fm as any;
const name = fx.instances.find((i: any) => !i.general)!.name;
const at = (h: number) => new Date(Date.UTC(2026, 10, 6, h, 0, 0)).toISOString();
const PAGE = "<!doctype html><title>Q3 report</title><style>body{font:16px system-ui;padding:16px}</style><h1 id=h>Q3 report</h1><p>North 18.2 M · South 23.8 M</p>";
fm.emitSseEvent("message", { instance: name, sender: "web-user", role: "user", text: "Make the Q3 page, please.", ts: at(1) });
fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", ts: at(2), text: "Here it is.\n\n```html\n" + PAGE + "\n```" });

const r: Record<string, unknown> = { browser: fx.browser.version(), label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const CASES = [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const;
const WS = { en: "Files & changes", "zh-TW": "檔案與變更" } as const;
// The panel's DOM as the user's browser has it (per-run keys and times dropped; the frame's src is the fixed /frame).
const DOM = `(() => {
  const e = document.querySelector(".pv-panel");
  return e ? e.outerHTML.replace(/ data-v="[^"]*"/g, "").replace(/ data-key="[^"]*"/g, "").replace(/ title="[^"]*\\d{1,2}:\\d{2}[^"]*"/g, ' title="TIME"')
    .replace(/\\d{1,2}:\\d{2}( [AP]M)?/g, "HH:MM").replace(/[0-9a-f]{32}/g, "ID").replace(/:\\d{4,5}\\//g, ":PORT/") : null;
})()`;
const dom: Record<string, unknown> = {};

async function chat(c: (typeof CASES)[number], route?: (page: any) => Promise<void>) {
  const { ctx, page, csp } = await fx.page(c as any, { path: `/ui/chat/${encodeURIComponent(name)}`, storage: { agend_html_preview: "on", agend_usage_rail: "0" } });
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  if (route) { await route(page); await page.reload(); }
  const ready = await page.waitForSelector(".msg.agent .pv-open", { timeout: 15000 }).then(() => true, () => false);
  return { ctx, page, csp, errs, ready };
}
async function panel(o: Awaited<ReturnType<typeof chat>>, c: (typeof CASES)[number], tag: string) {
  await o.page.click(".msg.agent .pv-open");
  const running = await o.page.waitForFunction(() => {
    const f = document.querySelector(".pv-panel iframe") as HTMLIFrameElement | null;
    return !!f && !!document.querySelector(".pv-panel .pv-fb-pick");
  }, null, { timeout: 15000 }).then(() => true, () => false);
  await o.page.waitForTimeout(800);
  const html = await o.page.evaluate(DOM);
  const bar = await o.page.evaluate(`[...document.querySelectorAll(".pv-panel .pv-panel-bar button, .pv-panel .pv-fb button, .pv-panel button[class*=pv-fb]")].map((b) => b.className.split(" ").filter((x) => x.startsWith("pv-fb")).join(".")).filter(Boolean)`);
  await o.page.screenshot({ path: shotPath(SMOKE, `${LABEL}-${tag}`, "1-page-panel") });
  // The chat's ⋯ → Files & changes (the fleet's registered view).
  await o.page.evaluate(`(() => { const b = [...document.querySelectorAll(".p-chat .panel-head button")].find((x) => x.getAttribute("aria-label") === "More actions" || x.getAttribute("aria-label") === "更多動作"); if (b) b.click(); })()`);
  await o.page.waitForTimeout(400);
  const wsFound = await o.page.evaluate(`(() => { const i = [...document.querySelectorAll(".menu-item")].find((x) => x.textContent.trim() === ${JSON.stringify(WS[c.lang])}); if (i) { i.click(); return true; } return false; })()`);
  const ws = await o.page.waitForSelector(".ws-panel", { timeout: 15000 }).then(() => true, () => false);
  await o.page.waitForTimeout(800);
  const wsHtml = await o.page.evaluate(`(() => { const e = document.querySelector(".ws-panel"); return e ? e.outerHTML.replace(/[0-9a-f]{32}/g, "ID") : null; })()`);
  await o.page.screenshot({ path: shotPath(SMOKE, `${LABEL}-${tag}`, "2-files-and-changes") });
  return { running, html, bar, wsFound, ws, wsHtml };
}

try {
  for (const c of CASES) {
    const tag = `${c.device}-${c.theme}-${c.lang}`;
    const o = await chat(c);
    const p = await panel(o, c, tag);
    dom[tag] = { page: p.html, bar: p.bar, files: p.wsHtml };
    check(tag, o.ready && p.running && !!p.html && p.bar.includes("pv-fb-share") && p.bar.includes("pv-fb-pick") && p.wsFound && p.ws && o.errs.length === 0 && (await o.csp()).length === 0,
      { ready: o.ready, running: p.running, bar: p.bar, wsFound: p.wsFound, ws: p.ws, errs: o.errs, csp: await o.csp() });
    await o.ctx.close();
  }

  if (OLD_REF) {
    const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };
    const serveOld = (files: string[]) => async (page: any) => page.route((u: URL) => files.some((f) => u.pathname === `/ui/js/${f}`), (route: any) => {
      const f = new URL(route.request().url()).pathname.replace(/^\/ui\/js\//, "");
      const body = old(f);
      return body === null ? route.continue() : route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body });
    });
    const o = await chat(CASES[0], serveOld(["panel-chat.js"]));
    const p = await panel(o, CASES[0], "skew-old-panel-chat");
    check("skew-old-panel-chat", o.ready && p.running && p.bar.includes("pv-fb-share") && p.ws && o.errs.length === 0, { ready: o.ready, running: p.running, bar: p.bar, ws: p.ws, errs: o.errs });
    await o.ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  const out = shotPath(SMOKE, "dom", LABEL).replace(/\.png$/, ".json");
  writeFileSync(out, JSON.stringify(dom, null, 1)); r.dom = out;
  writeFileSync(shotPath(SMOKE, "result", LABEL).replace(/\.png$/, ".json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}

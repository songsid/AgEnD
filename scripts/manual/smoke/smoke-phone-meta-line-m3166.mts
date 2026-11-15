// M-3166 PR 1 (Argon 0–1, the user's OK of round 2): a phone's meta line above the box, and the box as 📎 · the text ·
// Send. A real Chrome on the shared fixture (in-process FleetManager, scratch home, loopback only, fake agents), a phone with
// an iPhone's safe area (390×844, touch; CDP Emulation.setSafeAreaInsetsOverride 47/34), light/dark × en/zh-TW; and a desk.
// Per phone case, judged and pictured:
//   1-idle         the meta line: 26 px, the small type; its model button ≥ 32 px tall, "<model> · <effort> · <n>%"; no
//                  working bar, no line under the box; the box is 📎 · the text · Send (no tools in it)
//   2-working      "Working …· n%" / 「處理中 …· n%」 with its dot; Send is Stop while nothing is typed
//   3-not-verified Not verified · Authorize at the meta line's right end, once
//   4-file-multi   a file in one strip at the top of the box; the text across the whole box
//   6-files-working  the file alone, the agent working: Send stays Send, the meta line's Stop is there (M-3198)
//   5-long         at most five lines, then the box scrolls
// The desk: the working bar and the line under the box as before, no meta line. Everywhere: no horizontal overflow, no page error.
// Run it on the base too (REPO=<base checkout> SMOKE_NAME=…-before): every phone case FAILs there (no meta line).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] scripts/manual/smoke/run.sh smoke-phone-meta-line-m3166.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, freshPage, matrix, mounted, seedChat, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-phone-meta-line-m3166";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48940), instances: 4 });
const name = fx.instances[1]!.name;
await seedChat(fx as never, [name], 20);
const png = join(fx.dir, "IMG_7018.png");
writeFileSync(png, await (fx as any).picture({ w: 1170, h: 2532, hue: 30, label: "IMG_7018", mime: "image/png", seed: 7 }));
const LONG = "第一點：輸入框下面還有一條黑色的帶子。第二點：模型名字太長，一行只能打八個字。第三點：附檔加上多行文字時，輸入框變得非常高，把對話都擋住了。第四點：希望文字可以用整個寬度，按鈕放到下面一排。第五點：鍵盤收起來的時候也要檢查。第六點：這一行應該要捲動。";
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];

async function open(c: any, auth: "verified" | "none") {
  return freshPage(fx, c, { account: "operator", path: `/ui/chat/${encodeURIComponent(name)}`, beforeNavigate: async (ctx: any, page: any) => {
    await ctx.addInitScript({ content: "window.__name = (f) => f" });
    if (c.device === "phone") { const s = await ctx.newCDPSession(page); await s.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } }); }
    await ctx.route("**/ui/authorization", (r: any) => r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(auth === "verified" ? { state: "verified", until: Date.now() + 3_600_000 } : { state: "none", reason: "not_authorized" }) }) : r.continue());
  } });
}
const setState = (page: any, working: boolean) => page.evaluate(async ([n, w]: [string, boolean]) => {
  const m = await import("/assets/app-store.js");
  m.appStore.set((s: any) => ({ ...s, instances: (s.instances || []).map((i: any) => i.name === n ? { ...i, context_pct: 56, model: "claude-opus-5-5", effort: "high" } : i),
    exec: { ...s.exec, [n]: w ? "working" : "idle" } }));
}, [name, working]);
const blur = (page: any) => page.evaluate(() => (document.activeElement as HTMLElement)?.blur());

try {
  for (const c of matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW,phone-dark-en,phone-light-zh-TW")) {
    if (c.device !== "phone") continue;
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    const zh = c.lang === "zh-TW";
    let p = await open(c, "verified");
    let page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await mounted(page, 30000); await page.waitForSelector("#msgIn", { timeout: 20000 });
    await setState(page, false); await page.waitForTimeout(900);
    const look = () => page.evaluate(() => {
      const meta = document.querySelector(".chat-meta") as HTMLElement | null, left = document.querySelector(".chat-meta-left") as HTMLElement | null;
      const row = document.querySelector(".p-chat .composer") as HTMLElement;
      return { meta: meta ? Math.round(meta.getBoundingClientRect().height) : 0, font: meta ? getComputedStyle(meta).fontSize : null,
        leftH: left ? Math.round(left.getBoundingClientRect().height) : 0, leftText: (left?.textContent || "").replace(/\s+/g, " ").trim(),
        kids: [...row.children].filter((n) => n.tagName !== "INPUT").map((n) => (n as HTMLElement).id || (n.getAttribute("class") || "").split(" ")[0]),
        workBar: !!document.querySelector(".p-chat .work-bar"), under: !!document.querySelector(".p-chat .composer-row"),
        wide: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    let m = await look();
    need(m.meta === 26 && m.font === "12px", `idle: the meta line is 26 px, 12 px type (${m.meta}, ${m.font})`);
    need(m.leftH >= 32 && /^Opus 5\.5 · high · 56%/.test(m.leftText), `idle: the model button ≥ 32 px, "Opus 5.5 · high · 56%" (${m.leftH}, ${m.leftText})`);
    need(!m.workBar && !m.under, "idle: no working bar, no line under the box");
    need(JSON.stringify(m.kids) === JSON.stringify(["attachBtn", "composer-field", "sendBtn"]), `the box is 📎 · the text · Send (${m.kids.join(",")})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "1-idle") });
    await setState(page, true); await page.waitForTimeout(1500);
    m = await look();
    const stop = await page.evaluate(() => (document.querySelector("#sendBtn") as HTMLElement)?.className.includes("is-stop"));
    need(new RegExp(`^${zh ? "處理中" : "Working"}.* · 56%$`).test(m.leftText) && stop, `working: "${zh ? "處理中" : "Working"} … · 56%", Send is Stop (${m.leftText}, ${stop})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "2-working") });
    await setState(page, false); await page.waitForTimeout(400);
    const box = page.locator("#msgIn");
    const file = page.locator('.p-chat input[type="file"]').first();
    if (await file.count()) await file.setInputFiles(png);
    await box.fill("有好一點點 但好的不多，然後多了模型 我一行能打的字更少了 然後輸入框變好大"); await blur(page); await page.waitForTimeout(400);
    const strip = await page.evaluate(() => { const f = document.querySelector(".composer-box .pending-files") as HTMLElement | null, box = document.querySelector(".composer-box") as HTMLElement;
      return f ? [Math.round(f.getBoundingClientRect().top - box.getBoundingClientRect().top), getComputedStyle(f).flexWrap] : null; });
    need(strip && strip[0]! < 12 && strip[1] === "nowrap", `a file: one strip at the top of the box (${JSON.stringify(strip)})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "4-file-multi") });
    // M-3198: the file alone (no text) while the agent works: Send is Send (the file can go), so Stop is the meta line's —
    // there is always a Stop to tap.
    await box.fill(""); await blur(page); await setState(page, true); await page.waitForTimeout(1200);
    const files = await page.evaluate(() => {
      const shown = (e: Element | null) => !!e && (e as HTMLElement).getBoundingClientRect().width > 0 && getComputedStyle(e as HTMLElement).display !== "none";
      return { file: shown(document.querySelector(".composer-box .pending-files")), metaStop: shown(document.querySelector(".chat-meta-stop")),
        sendIsStop: !!(document.querySelector("#sendBtn") as HTMLElement)?.className.includes("is-stop") };
    });
    need(files.file && files.metaStop && !files.sendIsStop, `a file only, working: Send stays Send and the meta line's Stop is there (${JSON.stringify(files)})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "6-files-working") });
    await setState(page, false); await page.waitForTimeout(400);
    await box.fill(LONG); await blur(page); await page.waitForTimeout(400);
    const lines = await page.evaluate(() => { const t = document.querySelector("#msgIn") as HTMLTextAreaElement, lh = parseFloat(getComputedStyle(t).lineHeight);
      return [Math.round(t.clientHeight / lh * 10) / 10, t.scrollHeight > t.clientHeight]; });
    need((lines[0] as number) <= 5.6 && lines[1] === true, `long text: at most five lines, then it scrolls (${JSON.stringify(lines)})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "5-long") });
    need(!m.wide, "no horizontal overflow");
    await p.ctx.close();
    // Not verified.
    p = await open(c, "none"); page = p.page;
    await mounted(page, 30000); await page.waitForSelector("#msgIn", { timeout: 20000 }); await setState(page, false); await page.waitForTimeout(1200);
    const auth = await page.evaluate(() => [document.querySelectorAll(".chat-meta-right .webauth-row").length, document.querySelectorAll(".webauth-row").length,
      (document.querySelector(".chat-meta-right .webauth-ask")?.getBoundingClientRect().height ?? 0) >= 32]);
    need(auth[0] === 1 && auth[1] === 1 && auth[2], `not verified: Authorize once, at the meta line's right end, ≥ 32 px (${JSON.stringify(auth)})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "3-not-verified") });
    await p.ctx.close();
    need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    results.push({ name: caseName(c), ok: failed.length === 0, failed });
  }
  // A desk: as before.
  for (const theme of ["light", "dark"] as const) {
    const c = { device: "desk", theme, lang: "en" } as any;
    const p = await open(c, "verified"); const page = p.page;
    await mounted(page, 30000); await page.waitForSelector("#msgIn", { timeout: 20000 }); await setState(page, true); await page.waitForTimeout(1200);
    const d = await page.evaluate(() => [!!document.querySelector(".chat-meta"), !!document.querySelector(".p-chat .work-bar"), !!document.querySelector(".p-chat .composer-row")]);
    results.push({ name: `desk-${theme}`, ok: JSON.stringify(d) === "[false,true,true]", failed: JSON.stringify(d) === "[false,true,true]" ? [] : [`desk: no meta line, the working bar and the line under the box (${JSON.stringify(d)})`] });
    await page.screenshot({ path: shotPath(SMOKE, `desk-${theme}`, "working") });
    await p.ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);

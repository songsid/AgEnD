// M-2448: a Markdown file in the web chat's side panel, on the realistic fixture (never `fleet start`). An agent attaches
// notes.md (headings, a list, a table, code, a link, plus raw <script> and <img onerror> that must stay text) and a
// csv (no panel action).
// - desk light (en) and phone dark (zh-TW): the card's "Open in panel" → the panel (a split on the desk, a full-screen
//   sheet on the phone) with the file rendered; Source; Formatted again; Close. No script or image from the file, no page
//   error, no CSP report, no horizontal page scroll.
// - the stale-tab skew (rule 3): the old shell (every long-lived /assets file from OLD_REF) with this branch's chat
//   modules — the panel still opens and renders; this shell with the old chat modules (panel-chat, chat-thread,
//   preview-panel from OLD_REF) — no panel action on the Markdown card, the card itself still works.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [OLD_REF=origin/main] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-md-side-preview-2448.mts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-md-side-preview-2448";
const REPO = process.env.REPO!, OLD_REF = process.env.OLD_REF ?? "origin/main";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48640), instances: 2 });
const fm = fx.fm as any;
const name = fx.instances.find((i: any) => !i.general)!.name;
const { publicAttachment } = await import(REPO + "/src/web-upload.ts");
const MD = [
  "# Release notes", "", "Short **summary** with `code` and a [link](https://example.com).", "",
  "## Changes", "", "- Faster start", "- Fewer restarts", "  - nested item", "", "| Area | Status |", "| --- | --- |", "| Web | done |", "| CLI | next |", "",
  "```js", "const answer = 42;", "```", "", "<script>window.__pwned = 1</script>", "", "<img src=x onerror=\"window.__pwned = 2\">", "",
  ...Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: the panel scrolls inside itself, never the page.`),
].join("\n");
const mdPath = join(fx.dir, "notes.md"); writeFileSync(mdPath, MD);
const csvPath = join(fx.dir, "data.csv"); writeFileSync(csvPath, "a,b\n1,2\n");
const served = [
  fm.webFiles.registerServed({ path: mdPath, instance: name, name: "notes.md", mime: "text/markdown", kind: "document" }),
  fm.webFiles.registerServed({ path: csvPath, instance: name, name: "data.csv", mime: "text/csv", kind: "document" }),
];
fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: "The notes.", ts: new Date().toISOString(), attachments: served.map(publicAttachment) });

const r: Record<string, unknown> = { browser: fx.browser.version(), oldRef: OLD_REF };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };
const PROBE = `(() => {
  const q = (s) => document.querySelector(s), p = q(".pv-md-panel"), b = p ? p.getBoundingClientRect() : null;
  return { panel: !!p, title: q(".pv-md-panel .pv-panel-title strong")?.textContent ?? null,
    h: [...document.querySelectorAll(".pv-md :is(h1,h2,h3,h4)")].map((e) => e.textContent),
    li: document.querySelectorAll(".pv-md li").length, table: !!q(".pv-md table"), code: q(".pv-md pre code")?.textContent ?? null,
    script: !!q(".pv-md script"), img: !!q(".pv-md img"), pwned: window.__pwned ?? null, links: [...document.querySelectorAll(".pv-md a")].map((a) => a.getAttribute("href")),
    source: q(".pv-md-panel pre.pv-code code")?.textContent?.slice(0, 15) ?? null,
    rect: b ? { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) } : null, vw: innerWidth, vh: innerHeight,
    overflowX: document.documentElement.scrollWidth - innerWidth, actions: [...document.querySelectorAll(".text-card")].map((c) => !!c.querySelector(".tc-panel")) };
})()`;
const CASES = [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const;
async function open(c: (typeof CASES)[number], route?: (page: any) => Promise<void>) {
  const { ctx, page, csp } = await fx.page(c as any, { path: `/ui/chat/${encodeURIComponent(name)}` });
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  if (route) { await route(page); await page.reload(); }
  await page.waitForSelector(".text-card[data-att]", { timeout: 15000 });
  return { ctx, page, csp, errs };
}

try {
  for (const c of CASES) {
    const tag = `${c.device}-${c.theme}-${c.lang}`;
    const o = await open(c);
    await o.page.evaluate(`document.querySelector(".text-card .tc-panel").click()`);
    await o.page.waitForSelector(".pv-md-panel .pv-md :is(h1,h2,h3,h4)", { timeout: 10000 });
    await o.page.waitForTimeout(400);
    const a = await o.page.evaluate(PROBE);
    await o.page.screenshot({ path: shotPath(SMOKE, tag, "1-formatted") });
    await o.page.evaluate(`document.querySelectorAll(".pv-md-panel .seg-inline button")[1].click()`); await o.page.waitForTimeout(300);
    const s = await o.page.evaluate(PROBE);
    await o.page.screenshot({ path: shotPath(SMOKE, tag, "2-source") });
    await o.page.evaluate(`document.querySelectorAll(".pv-md-panel .seg-inline button")[0].click()`); await o.page.waitForTimeout(300);
    const back = await o.page.evaluate(PROBE);
    await o.page.evaluate(`[...document.querySelectorAll(".pv-md-panel .pv-panel-close")].find((b) => b.offsetParent !== null).click()`); await o.page.waitForTimeout(300);
    const closed = await o.page.evaluate(PROBE);
    const sheet = c.device === "phone" ? a.rect && a.rect.x === 0 && a.rect.w === a.vw : a.rect && a.rect.w < a.vw;
    const got = { a, source: s.source, back: back.h, closed: closed.panel, errs: o.errs, csp: await o.csp() };
    check(tag, a.panel && a.title === "notes.md" && a.h.includes("Release notes") && a.li >= 3 && a.table && a.code === "const answer = 42;"
      && !a.script && !a.img && a.pwned === null && JSON.stringify(a.links) === JSON.stringify(["https://example.com"]) && JSON.stringify(a.actions) === "[true,false]"
      && s.source === "# Release notes" && back.h.includes("Release notes") && !closed.panel && !!sheet && a.overflowX <= 0
      && o.errs.length === 0 && (got.csp as string[]).length === 0, got);
    await o.ctx.close();
  }

  // ── the stale-tab skew ──
  // The old shell: every long-lived /assets file from OLD_REF; the chat modules under /ui/js/ stay new.
  const oldShell = async (page: any) => page.route("**/assets/**", (route: any) => {
    const file = new URL(route.request().url()).pathname.replace(/^\/assets\//, "");
    const body = old(`shared/${file}`);
    return body === null ? route.continue() : route.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body });
  });
  {
    const o = await open(CASES[0], oldShell);
    await o.page.evaluate(`document.querySelector(".text-card .tc-panel").click()`);
    const ok = await o.page.waitForSelector(".pv-md-panel .pv-md :is(h1,h2,h3,h4)", { timeout: 10000 }).then(() => true, () => false);
    await o.page.screenshot({ path: shotPath(SMOKE, "skew", "old-shell-new-chat") });
    check("skew-old-shell-new-chat", ok && o.errs.length === 0, { ok, errs: o.errs });
    await o.ctx.close();
  }
  {
    // This shell with the old chat modules: no panel action on a Markdown card (they know none); the card still shows.
    const LAZY = ["panel-chat.js", "chat-thread.js", "preview-panel.js", "chat-strings.js"];
    const o = await open(CASES[0], async (page: any) => page.route(/\/ui\/js\/(panel-chat|chat-thread|preview-panel|chat-strings)\.js(\?.*)?$/, (route: any) => {
      const file = LAZY.find((f) => route.request().url().includes(`/ui/js/${f}`))!;
      return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: old(file) ?? "" });
    }));
    const before = await o.page.evaluate(PROBE);
    await o.page.evaluate(`document.querySelector(".text-card .tc-show").click()`);
    const shown = await o.page.waitForSelector(".text-card .tc-body .md :is(h1,h2,h3,h4)", { timeout: 10000 }).then(() => true, () => false);
    await o.page.screenshot({ path: shotPath(SMOKE, "skew", "new-shell-old-chat") });
    check("skew-new-shell-old-chat", JSON.stringify(before.actions) === "[false,false]" && shown && o.errs.length === 0, { before: before.actions, shown, errs: o.errs });
    await o.ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  writeFileSync(shotPath(SMOKE, "result", "json").replace(/\.png$/, ".json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}

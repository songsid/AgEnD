// #2330: before/after shots of the eight left-edge accents, drawn by the checkout's own tokens.css + app.css.
// The markup of each place is copied from its component (panel-chat reply bar and command card, chat-thread quote,
// panel-log rows, fleet-org nodes, fleet-usage notes, fleet-tasks tiles), so the shots compare the CSS alone: the
// same markup under the old and the new sheet. No fleet, no account, no network.
// Per place it also measures where the first line of content starts inside the box (the text must not move) and what
// draws the edge (a border, or a ::before bar).
//   PW_DIR=… CSS_DIR=<dir with tokens.css + app.css> TAG=before|after OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//     npx tsx scripts/manual/smoke/smoke-2330-left-bars.mts
//   COMPOSE=1 OUT=<dir>: after both runs, one before/after sheet per place (<OUT>/compare-<place>.png).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.PW_DIR ?? ".", "package.json"));
const { chromium } = require("playwright-core");
const OUT = process.env.OUT ?? "/tmp/smoke-2330";
mkdirSync(OUT, { recursive: true });

const ICON = `<svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`;
const X = `<svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
const head = (label: string, extra = "") => `<div class="log-head"><span class="log-icon">${ICON}</span><span class="log-label">${label}</span>${extra}<span class="grow"></span><span class="log-time">14:02</span></div>`;
const node = (state: string, name: string, desc: string) => `<li class="org-node st-${state}"><div class="org-node-head"><span class="dot" aria-hidden="true"></span>
  <span class="org-names"><strong class="org-name mono">${name}</strong></span><span class="org-state st-${state}">${state}</span></div>
  <p class="org-desc">${desc}</p><div class="org-meta"><span class="org-chip">claude-code</span><span class="org-model mono">opus</span></div></li>`;
const tile = (st: string, id: string, title: string, who: string) => `<div class="tb-tile st-${st}" data-tile="${id}"><div class="tb-tile-top"><span class="tb-code">${id}</span><span class="tb-grow"></span></div>
  <button type="button" class="tb-tile-title">${title}</button>
  ${st === "blocked" ? `<div class="tb-tile-note st-blocked"><span>Waiting on the release key</span></div>` : ""}
  <div class="tb-tile-foot"><span class="tb-who">${who}</span><span class="tb-tile-stats"></span></div></div>`;

/** Each place: its markup, inside the containers its selectors need. `probe` = the boxes measured. */
const PLACES: Record<string, { html: string; probe: string; width?: number }> = {
  "1-reply-bar": { probe: ".reply-bar", html: `<div class="composer-box"><div class="reply-bar" role="status"><span class="reply-mark">${ICON}</span><span class="reply-label">Replying to demo-agent</span>
    <span class="reply-text">Shall I deploy the demo build to staging?</span><button type="button" class="icon-btn reply-cancel">${X}</button></div></div>` },
  "2-msg-quote": { probe: ".msg-quote", html: `<div class="thread-col" style-x><div class="msg user"><div class="meta"><span class="sender">you</span></div>
    <button type="button" class="msg-quote"><span class="quote-mark">${ICON}</span> <span class="quote-sender">demo-agent</span> <span class="quote-text">Shall I deploy the demo build to staging?</span></button>
    <div class="body"><div class="md"><p>Yes, go ahead</p></div></div></div></div>` },
  "3-log-error": { probe: ".log-item", html: `<div class="p-log"><ol class="log-list">
    <li class="log-item k-assistant">${head("Assistant")}<div class="log-text">Running the build now.</div></li>
    <li class="log-item k-error">${head("Error (429)")}<div class="log-text">Request failed: rate limited, retrying in 30 s.</div></li>
    <li class="log-item k-tool s-failed">${head(`<span class="log-cat">Shell</span> <span class="log-subject mono">npm test</span>`, `<span class="log-status failed">failed · exit 1</span>`)}</li></ol></div>` },
  "4-org-node": { probe: ".org-node", html: `<ul class="org-nodes">${node("working", "builder", "Builds and ships the web bundle")}${node("needs", "reviewer", "Waits for your answer")}
    ${node("crashed", "codex-1", "Crashed three times in five minutes")}${node("idle", "docs", "Idle")}</ul>` },
  "5-us-basis": { probe: ".us-basis", html: `<p class="us-basis" role="note">API-equivalent at list price (checked 2026-10-01). Subscriptions are billed differently.</p>` },
  "6-us-partial": { probe: ".us-partial", html: `<p class="us-partial" role="status">Daily figures cover only the last 14 days; older days were not collected.</p>` },
  "7-cmd-card": { probe: ".cmd-card", html: `<div class="cmd-card" role="status"><div class="cmd-head"><span class="cmd-name mono">/model</span><button type="button" class="icon-btn">${X}</button></div><pre class="cmd-text">Model: opus</pre></div>
    <div class="cmd-card bad" role="alert"><div class="cmd-head"><span class="cmd-name mono">/compact</span><button type="button" class="icon-btn">${X}</button></div><p class="cmd-text">The instance is busy. Try again when it is idle.</p></div>` },
  "8-tb-tile": { probe: ".tb-tile", width: 300, html: `<div class="tb-col"><div style-x>${tile("open", "T-12", "Write the release notes", "—")}${tile("claimed", "T-13", "Replace rounded accents", "dev-claude2")}
    ${tile("blocked", "T-14", "Publish 2.3.0", "leader")}${tile("review", "T-15", "Review #2328", "fable")}${tile("done", "T-16", "Fix the warning text", "dev-claude2")}</div></div>` },
};

const CASES = [
  { device: "desk", width: 1366, theme: "light" }, { device: "desk", width: 1366, theme: "dark" },
  { device: "phone", width: 390, theme: "light" }, { device: "phone", width: 390, theme: "dark" },
] as const;

const browser = await chromium.launch({ env: { FONTCONFIG_FILE: process.env.FONTCONFIG_FILE ?? "" } });
try {
  if (process.env.COMPOSE) {
    // One sheet per place: a row per case, before | after.
    for (const place of Object.keys(PLACES)) {
      const img = (tag: string, c: (typeof CASES)[number]) => {
        const f = join(OUT, tag, `${place}-${c.device}-${c.theme}.png`);
        return existsSync(f) ? `<img src="data:image/png;base64,${readFileSync(f).toString("base64")}">` : "missing";
      };
      const rows = CASES.map((c) => `<tr><th>${c.device} ${c.width}<br>${c.theme}</th><td>${img("before", c)}</td><td>${img("after", c)}</td></tr>`).join("");
      const page = await browser.newPage({ viewport: { width: 1500, height: 400 }, deviceScaleFactor: 1 });
      await page.setContent(`<style>body{font:14px system-ui;margin:12px;background:#888}th{text-align:left;padding:6px;vertical-align:top;color:#fff}
        td{padding:6px;vertical-align:top}img{display:block;max-width:640px}h1{font-size:16px;color:#fff;margin:0 0 8px}</style>
        <h1>#2330 ${place}: before | after</h1><table>${rows}</table>`);
      await page.screenshot({ path: join(OUT, `compare-${place}.png`), fullPage: true });
      await page.close();
    }
    console.log("composed");
  } else {
    const TAG = process.env.TAG ?? "after";
    const dir = join(OUT, TAG); mkdirSync(dir, { recursive: true });
    const css = ["tokens.css", "app.css"].map((f) => readFileSync(join(process.env.CSS_DIR!, f), "utf8")).join("\n");
    const result: Record<string, unknown> = {};
    for (const c of CASES) {
      const page = await browser.newPage({ viewport: { width: c.width, height: 900 }, deviceScaleFactor: 2, colorScheme: c.theme });
      for (const [place, p] of Object.entries(PLACES)) {
        const w = Math.min(p.width ?? 640, c.width - 32);
        await page.setContent(`<!doctype html><html data-theme="${c.theme}"><head><meta name="viewport" content="width=device-width"><style>${css}</style>
          <style>#stage{padding:16px;width:${w}px;display:flex;flex-direction:column;gap:8px;background:var(--bg)} [style-x]{display:flex;flex-direction:column;gap:8px}</style></head>
          <body><div id="stage">${p.html}</div></body></html>`);
        await page.evaluate("document.fonts.ready");
        await page.locator("#stage").screenshot({ path: join(dir, `${place}-${c.device}-${c.theme}.png`) });
        // Where the first content starts inside each box, and what draws its left edge.
        result[`${place}/${c.device}-${c.theme}`] = await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(p.probe)})].map((el) => {
          const box = el.getBoundingClientRect(), cs = getComputedStyle(el), bar = getComputedStyle(el, "::before");
          return { cls: el.className, contentLeft: (() => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let t; while ((t = w.nextNode()) && !t.data.trim()); const r = document.createRange(); if (t) r.selectNodeContents(t);
            const lefts = [t ? r.getBoundingClientRect().left : Infinity, el.firstElementChild ? el.firstElementChild.getBoundingClientRect().left : Infinity];
            return Math.round((Math.min(...lefts) - box.left) * 100) / 100; })(), borderLeft: cs.borderLeftWidth + " " + cs.borderLeftColor,
            bar: bar.content !== "none" && bar.content !== "normal" ? { width: bar.width, top: bar.top, bottom: bar.bottom, color: bar.backgroundColor } : null };
        })`);
      }
      await page.close();
    }
    writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 1));
    console.log(`${TAG}: ${Object.keys(result).length} place×case shots in ${dir}`);
  }
} finally {
  await browser.close();
}

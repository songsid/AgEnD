// The user's tofu boxes (Discord hmsg-49fbf692) from defaults (fleet decision a78ebdc5): an agent's message with emoji
// in web chat — "報告老闆！CW 特效已全面重構優化並設定完畢！" and four emoji — under an unthemed chat and two agent themes
// (font "mono" and "system"), in Chromium and WebKit, light and dark. Each case is a fresh profile with nothing seeded,
// signed in through the visible /signin, opening the chat through the sidebar.
// - Every font stack the message is drawn with ends with the colour emoji fonts (computed style, both engines).
// - A Discord server emoji whose picture does not load, and one the page does not know, read `:name:` — never an
//   empty box, never the raw `<:name:id>`.
// - With EMOJI_FONT=<dir with NotoColorEmoji.ttf> the browsers get a private fontconfig that has a colour emoji font
//   (this host has none, so without it every emoji is a box whatever the CSS says).
// What is not real: the message is handed to the page's stream (FleetManager.emitSseEvent) instead of coming from an
// agent; the server emoji list is one demo emoji whose picture route answers nothing (as when the CDN fetch fails).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [EMOJI_FONT=<dir>] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-emoji-tofu.mts
// WebKit (decision a78ebdc5): the whole smoke inside Playwright's image (its WebKit and libraries; Noto Color Emoji;
// no networking between host and container), with the host's Node 22 (better-sqlite3) — dev-claude's #2124 recipe:
//   docker run -d --rm --name wk --memory 4g mcr.microsoft.com/playwright:v1.64.1-noble sleep 7200
//   git archive HEAD | tar -x -C $SC/stage; docker cp $SC/stage wk:/work/repo; docker cp -L <node_modules> wk:/work/repo/node_modules
//   docker cp ~/.cache/agend-smoke/pw wk:/work/pw; docker cp $(readlink -f $(which node)) wk:/work/node22
//   docker exec -e PW_DIR=/work/pw -e REPO=/work/repo -e OUT=/work/out -e PW_ENGINE=webkit -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
//     -w /work/repo wk /work/node22 node_modules/tsx/dist/cli.mjs scripts/manual/smoke/smoke-emoji-tofu.mts
//   docker cp wk:/work/out $SC/out-webkit; docker rm -f wk
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

if (process.env.EMOJI_FONT) {
  const dir = join(tmpdir(), "smoke-emoji-fc"); mkdirSync(dir, { recursive: true });
  const conf = join(dir, "fonts.conf");
  writeFileSync(conf, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>${process.env.EMOJI_FONT}</dir><cachedir>${dir}/cache</cachedir></fontconfig>`);
  process.env.FONTCONFIG_FILE = conf;
}
const SMOKE = `smoke-emoji-tofu${process.env.EMOJI_FONT ? "-font" : ""}`;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48460), classic: false });
const fm = fx.fm;
const CHATS = { plain: "observability-dashboards", mono: "billing-reconciliation", system: "search-indexer" } as const;
for (const name of Object.keys(fm.fleetConfig.instances)) if (!Object.values(CHATS).includes(name as never)) delete fm.fleetConfig.instances[name];
fx.seedTheme(CHATS.mono, { v: 1, font: "mono" });
fx.seedTheme(CHATS.system, { v: 1, font: "system" });
// One demo server emoji whose picture route answers nothing (a failed CDN fetch), and one id the page does not know.
const KNOWN = "111111111111111111", UNKNOWN = "222222222222222222";
fm.webEmojiList = async () => [{ id: KNOWN, name: "party", animated: false }];
fm.webEmoji = async () => null;
const TEXT = `報告老闆！CW 特效已全面重構優化並設定完畢！🤩✨🍿💥 <:party:${KNOWN}> <:nope:${UNKNOWN}>`;

const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
// WebKit's own noise (#2127): its internal sheet per <select>, the viewport key, access-control lines on a cancelled read.
const KNOWN_WEBKIT = /Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'|Viewport argument key "interactive-widget" not recognized|cannot load .* due to access control checks/;

async function openChat(p: FreshPage, name: string) {
  await mounted(p.page);
  const link = p.page.locator(`a[href="/ui/chat/${name}"]`);
  const end = Date.now() + 10000;
  for (let clicked = false; !clicked && Date.now() < end;) {
    for (let i = 0; i < await link.count(); i++) if (await link.nth(i).isVisible()) { await link.nth(i).click(); clicked = true; break; }
    if (!clicked) await p.page.waitForTimeout(150);
  }
  await p.page.waitForURL(`**/ui/chat/${name}`, { timeout: 10000 });
  await p.page.waitForTimeout(500);
}
const MEASURE = `(() => { const md = [...document.querySelectorAll(".msg .md")].pop(); if (!md) return null;
  return { text: md.textContent, family: getComputedStyle(md).fontFamily, imgs: md.querySelectorAll("img.emoji").length,
    names: [...md.querySelectorAll(".emoji-text")].map((s) => s.textContent), raw: md.textContent.includes("<:"),
    theme: [...document.querySelectorAll(".p-chat")].map((e) => [...e.classList].filter((c) => c.startsWith("th-font")).join(" ")).join(" ") }; })()`;

const results: Array<{ name: string; ok: boolean; [k: string]: unknown }> = [];
for (const theme of ["light", "dark"] as const) for (const [kind, chat] of Object.entries(CHATS)) {
  const name = `${ENGINE}-${theme}-${kind}`;
  const p = await freshPage(fx, { device: "desk", theme, lang: "zh-TW" });
  await openChat(p, chat);
  fm.emitSseEvent("message", { instance: chat, sender: chat, role: "agent", text: TEXT, ts: new Date().toISOString() });
  await p.page.waitForFunction(`[...document.querySelectorAll(".msg .md")].some((m) => m.textContent.includes("報告老闆"))`, null, { timeout: 10000 });
  await p.page.waitForTimeout(1500);                                                  // the emoji list read, the picture's failure
  const m = await p.page.evaluate(MEASURE) as any;
  const c: Record<string, boolean> = {
    themed: kind === "plain" ? !/th-font/.test(m.theme) : m.theme.includes(`th-font-${kind}`),
    emojiChain: ['"Apple Color Emoji"', '"Segoe UI Emoji"', '"Noto Color Emoji"', "emoji"].every((f) => m.family.replace(/'/g, '"').includes(f.replace(/'/g, '"'))),
    namesNotBoxes: m.imgs === 0 && JSON.stringify(m.names) === JSON.stringify([":party:", ":nope:"]),
    noRawMarkup: !m.raw,
    unicodeKept: ["🤩", "✨", "🍿", "💥"].every((e) => m.text.includes(e)),
  };
  const last = p.page.locator(".msg").last();
  await last.screenshot({ path: shotPath(SMOKE, name, "message") });
  // The failed picture is the case under test; WebKit's own noise is kept apart (#2127).
  const errors = p.errors.filter((e) => !/\/ui\/img\/emoji\//.test(e) && !(ENGINE === "webkit" && KNOWN_WEBKIT.test(e)));
  c.noErrors = errors.length === 0;
  const failed = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length, failed, family: m.family, names: m.names, errors });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify(m).slice(0, 400)} ${JSON.stringify(errors).slice(0, 300)}` : ""}`);
  await p.ctx.close();
}
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : `PASS (${ENGINE})`);
await fx.close();
process.exit(bad.length ? 1 : 0);

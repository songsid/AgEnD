/**
 * M-3796 real-app check on Windows: an agent's chat reply whose bullets start with 🆕, in the real web app (owned
 * fixture in WSL; inert agents, synthetic messages), drawn by Microsoft Edge on Windows — headless, no window on the
 * desktop — reached over CDP (WIN_CDP, e.g. the WSL → Windows relay on 127.0.0.1:9341). For each emoji and each text
 * line, Edge's own CSS.getPlatformFontsForNode says which installed font drew it. Cases: dark and light, the default
 * font, the system and mono agent-theme fonts, and zh-TW. Run once on the base and once on the fix to compare.
 *   WIN_CDP=http://127.0.0.1:9341 CHROME=<chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/emoji-colour-m3796/capture-windows.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!, WIN_CDP = process.env.WIN_CDP!, PW = process.env.PW_DIR!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [], fonts: {} };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };

const EMOJI = ["🆕", "🆗", "🆓", "🈶", "☕", "⚡", "♈", "✅", "⚠️", "👍", "🏳️‍🌈", "1️⃣"];
const TEXT = ["1 # * © ™ ★ ♥ → 中文 text", "Ready: 🆕︎ (text style)"];
const REPLY = ["Here is what changed:", "", "- 🆕 The update card in General's chat", "- 🆕 Pick a time on the web", "- ✅ Pre-flight words", "",
  ...EMOJI.map((e) => `- ${e}`), "", ...TEXT.map((t) => `- ${t}`), "", "`code: 🆕 ☕ 1 #`"].join("\n");

const fx = await bootFixture({ port: 0, classic: false, roster: [
  { name: "alpha", displayName: "Atlas", backend: "claude-code" },
  { name: "beta", displayName: "Beacon", backend: "claude-code" },
  { name: "gamma", displayName: "Comet", backend: "codex" },
] });
const fm: any = fx.fm;
fx.seedTheme("beta", { v: 1, font: "system" } as never);
fx.seedTheme("gamma", { v: 1, font: "mono" } as never);
const now = Date.now();
for (const a of ["alpha", "beta", "gamma"]) {
  fm.webChatHistory.record({ instance: a, sender: "you", role: "user", text: "What's new?", ts: new Date(now - 60_000).toISOString() });
  fm.webChatHistory.record({ instance: a, sender: a, role: "agent", text: REPLY, ts: new Date(now - 30_000).toISOString() });
}
const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
const code = () => { fm.initializeWebSessions(); return fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken) }).display; };
const pw = createRequire(PW + "/")("playwright-core");
const edge = await pw.chromium.connectOverCDP(WIN_CDP);
receipt.browser = edge.version();

const CASES = [
  { tag: "dark-default-en", theme: "dark", lang: "en", agent: "alpha" },
  { tag: "light-default-en", theme: "light", lang: "en", agent: "alpha" },
  { tag: "dark-system-en", theme: "dark", lang: "en", agent: "beta" },
  { tag: "dark-mono-en", theme: "dark", lang: "en", agent: "gamma" },
  { tag: "dark-default-zh-TW", theme: "dark", lang: "zh-TW", agent: "alpha" },
] as const;

try {
  for (const c of CASES) {
    fm.webPrefs.write("operator", new Map<string, unknown>([["theme", c.theme], ["lang", c.lang]]));
    const ctx = await edge.newContext({ viewport: { width: 1100, height: 1000 }, colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US" });
    await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done","1"); localStorage.setItem("agend_firstrun_dismissed","1"); localStorage.setItem("agend_usage_rail","0"); localStorage.setItem("agend_lang", ${JSON.stringify(c.lang)}); } catch {}` });
    const page = await ctx.newPage();
    try {
      await page.goto(`${fx.base}/signin`); await page.waitForSelector("#code", { timeout: 30000 });
      await page.locator("#code").evaluate((input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); input.form!.requestSubmit(); }, code());
      await page.waitForURL(`${fx.base}/ui`, { timeout: 30000 });
      await page.goto(`${fx.base}/ui/chat/${c.agent}`);
      await page.getByText("Here is what changed:").waitFor({ timeout: 30000 });
      await page.waitForTimeout(1200);
      const s = await ctx.newCDPSession(page);
      await s.send("DOM.enable"); await s.send("CSS.enable");
      const { root } = await s.send("DOM.getDocument", { depth: -1 });
      const { nodeIds } = await s.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".msg .md li, .msg .md code" });
      const rows: Record<string, string> = {};
      for (const id of nodeIds) {
        const { outerHTML } = await s.send("DOM.getOuterHTML", { nodeId: id });
        const txt = outerHTML.replace(/<[^>]+>/g, "").trim();
        const { fonts } = await s.send("CSS.getPlatformFontsForNode", { nodeId: id });
        rows[txt] = fonts.map((f: any) => `${f.familyName}(${f.glyphCount})`).join(", ");
      }
      receipt.fonts[c.tag] = rows;
      receipt.chatClass = { ...(receipt.chatClass || {}), [c.tag]: await page.evaluate(`[...(document.querySelector(".p-chat") || { classList: [] }).classList].join(" ")`) };
      if (c.agent !== "alpha") check(`${c.tag}: the agent's theme font is on the chat`, receipt.chatClass[c.tag].includes(`th-font-${c.agent === "beta" ? "system" : "mono"}`), receipt.chatClass[c.tag]);
      // A list item's fonts also count its surrounding whitespace (one or two glyphs in the text font): the emoji is
      // drawn by Segoe UI Emoji when that is the only other font listed.
      const emojiOnly = (f: string) => { const parts = f.split(", ").filter(Boolean);
        return parts.some((p) => /^Segoe UI Emoji\(\d+\)$/.test(p)) && parts.every((p) => /^Segoe UI Emoji\(\d+\)$/.test(p) || /\(([12])\)$/.test(p) && !/Noto|Symbol|JhengHei|YaHei|MingLiU|Gothic|Meiryo|Menlo/.test(p)); };
      for (const e of EMOJI) {
        const f = rows[e] ?? "";
        check(`${c.tag}: ${e} drawn by the colour emoji font (no other font draws it)`, emojiOnly(f), f);
      }
      const first = Object.keys(rows).find((k) => k.startsWith("🆕 The update card"));
      check(`${c.tag}: the bullet "🆕 The update card…": its 🆕 in Segoe UI Emoji`, !!first && rows[first].includes("Segoe UI Emoji(1)"), first && rows[first]);
      receipt.fonts[c.tag + ":text"] = TEXT.map((t) => `${t} → ${rows[t]}`);
      check(`${c.tag}: the text line uses no emoji font`, !!rows[TEXT[0]] && !/Segoe UI Emoji/.test(rows[TEXT[0]]), rows[TEXT[0]]);
      check(`${c.tag}: 🆕︎ (text style) keeps a text glyph`, !!rows[TEXT[1]] && !/Segoe UI Emoji/.test(rows[TEXT[1]]), rows[TEXT[1]]);
      const path = `m3796-win-edge-${c.tag}.png`;
      await page.locator(".msg .md").last().screenshot({ path: join(OUT, path) });
      receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
    } finally { await ctx.close(); }
  }
} finally {
  await edge.close().catch(() => {});
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}

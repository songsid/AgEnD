// #2050: the theme preview's card text, measured where it is drawn. previewSvg lays the tagline and bio out with an
// upper bound of each grapheme's advance and clips the column; this opens the real SVG in Chromium and checks, for
// wide Latin, CJK, emoji and mixed text, with and without a portrait, in each preview font (sans-serif, monospace):
//   - every card line's drawn box (getBBox, before the clip) ends inside the column — the layout, not the clip, fits it;
//   - every line is drawn (none hidden whole by the clip), and text that did not fit ends with "…".
// No fleet, no account, no network: previewSvg is called directly and the SVG is opened from a scratch file.
//   PW_DIR=<dir with playwright-core> CHROME_EXE=<chrome> FONTCONFIG_FILE=/etc/fonts/fonts.conf OUT=<scratch dir> \
//     npx tsx scripts/manual/preview-text-2050.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { previewSvg } from "../../src/web-appearance-view.ts";

const OUT = process.env.OUT ?? "/tmp/preview-text-2050";
mkdirSync(OUT, { recursive: true });
const pw = createRequire(join(process.env.PW_DIR ?? ".", "package.json"))("playwright-core");
const CJK = "部署前檢查清單：確認所有服務的健康檢查、資料庫遷移與回滾腳本都已在預備環境驗證完成並通知值班人員與相關團隊成員";
const TEXTS: Record<string, { tagline: string; bio: string }> = {
  wideLatin: { tagline: "W".repeat(60), bio: ("WMW@ " + "M".repeat(40) + " ").repeat(6) },
  latin: { tagline: "Release captain for the Android and iOS trains, weekly, signs off hotfixes", bio: "Keeps the nightly benchmarks honest.\n".repeat(4) + "x".repeat(200) },
  cjk: { tagline: CJK.slice(0, 60), bio: `${CJK}\n${CJK}${CJK}\n${CJK}` },
  emoji: { tagline: "👨‍👩‍👧 家庭 👍🏽🇹🇼🇹🇼🇹🇼 ship it 🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀", bio: "🎉".repeat(80) + "\n" + "👨‍👩‍👧‍👦".repeat(40) },
};
const browser = await pw.chromium.launch({ executablePath: process.env.CHROME_EXE, args: ["--no-sandbox"] });
const page = await browser.newPage();
const results: any[] = [];
let fails = 0;
for (const [kind, text] of Object.entries(TEXTS)) for (const font of ["inter", "mono"]) for (const portrait of [false, true]) {
  const svg = previewSvg({ entry: { name: "a", display_name: null } as any, theme: { font } as any,
    card: { tagline: { text: text.tagline, by: "human" }, bio: { text: text.bio, by: "human" }, ...(portrait ? { portrait: { by: "human" } } : {}) } as any,
    locked: false, agentEdit: false, limits: {} }, "dark", { avatar: null, portrait: portrait ? "portrait.jpg" : null, banner: null, background: null } as any);
  const file = join(OUT, `${kind}-${font}-${portrait ? "portrait" : "plain"}.svg`);
  writeFileSync(file, svg);
  await page.goto("file://" + file);
  const r = await page.evaluate(`(() => {
    const clip = document.querySelector("#card-text rect"), x0 = +clip.getAttribute("x"), right = x0 + +clip.getAttribute("width");
    const lines = [...document.querySelectorAll('g[clip-path="url(#card-text)"] text')].map(t => { const b = t.getBBox(); return { end: b.x + b.width, w: b.width, text: t.textContent }; });
    return { right, lines: lines.length, over: lines.filter(l => l.end > right + 0.5).map(l => Math.round(l.end - right) + "px «" + l.text.slice(0, 20) + "»"),
      empty: lines.filter(l => !(l.w > 0)).length, ellipsis: lines.some(l => l.text.endsWith("…")), fill: Math.round(100 * Math.max(...lines.map(l => l.w)) / (right - x0)) };
  })()`) as any;
  const ok = r.over.length === 0 && r.empty === 0 && r.lines > 0;
  if (!ok) fails++;
  results.push({ case: `${kind}/${font}/${portrait ? "portrait" : "plain"}`, ok, ...r });
}
await browser.close();
for (const r of results) console.log((r.ok ? "PASS " : "FAIL ") + r.case.padEnd(26), `lines ${r.lines}`, `widest ${r.fill}% of the column`, r.ellipsis ? "…" : "", r.over.join(" "), r.empty ? `empty ${r.empty}` : "");
writeFileSync(join(OUT, "result.json"), JSON.stringify(results, null, 2));
console.log(fails ? `${fails} FAIL` : `all ${results.length} PASS`);
process.exit(fails ? 1 : 0);

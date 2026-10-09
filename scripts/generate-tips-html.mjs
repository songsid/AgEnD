import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The root build compiles src/tips.ts before postbuild invokes this script.
// Importing the compiled module keeps src/tips.ts as the single source of truth
// without maintaining a second website-only copy of the tips.
const { TIPS } = await import(new URL("../dist/tips.js", import.meta.url));
// Render helpers are compiled alongside other src/ modules so both the
// generator and the test suite share exactly the same code.
const { renderPage, LEVELS } = await import(new URL("../dist/website-tips-renderer.js", import.meta.url));

function validateTips(tips) {
  const ids = new Set();
  for (const tip of tips) {
    if (!tip?.id || ids.has(tip.id)) throw new Error(`Invalid or duplicate tip id: ${tip?.id}`);
    if (!LEVELS.includes(tip.level)) throw new Error(`Unknown level for ${tip.id}: ${tip.level}`);
    if (!tip.text_en?.trim() || !tip.text_zh?.trim()) throw new Error(`Missing translation for ${tip.id}`);
    ids.add(tip.id);
  }
}

validateTips(TIPS);
const publicDir = fileURLToPath(new URL("../website/public/", import.meta.url));
mkdirSync(publicDir, { recursive: true });
writeFileSync(`${publicDir}/tips-en.html`, renderPage(TIPS, "en"), "utf8");
writeFileSync(`${publicDir}/tips-zh.html`, renderPage(TIPS, "zh"), "utf8");
console.log(`Generated website tips pages (${TIPS.length} tips × 2 locales)`);

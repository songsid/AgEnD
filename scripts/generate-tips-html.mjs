import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The root build compiles src/tips.ts before postbuild invokes this script.
// Importing the compiled module keeps src/tips.ts as the single source of truth
// without maintaining a second website-only copy of the 300 tips.
const { TIPS } = await import(new URL("../dist/tips.js", import.meta.url));

const LEVELS = ["beginner", "intermediate", "advanced"];
const COPY = {
  en: {
    lang: "en",
    description: "Practical AgEnD guidance, from first chat to fleet operations.",
    intro: "300 practical notes, grouped from everyday use to advanced fleet operations.",
    switchLabel: "繁體中文",
    switchHref: "./tips-zh.html",
    home: "Home",
    count: "tips",
    levels: {
      beginner: ["Beginner", "Everyday chat and core concepts"],
      intermediate: ["Intermediate", "Commands, Backends, and coordination"],
      advanced: ["Advanced", "Configuration, reliability, and troubleshooting"],
    },
  },
  zh: {
    lang: "zh-TW",
    description: "從第一次對話到 Fleet 維運的 AgEnD 實用提示。",
    intro: "300 條實用提示，從日常操作一路整理到進階 Fleet 維運。",
    switchLabel: "English",
    switchHref: "./tips-en.html",
    home: "首頁",
    count: "條提示",
    levels: {
      beginner: ["入門", "日常對話與核心概念"],
      intermediate: ["中階", "指令、Backend 與協作"],
      advanced: ["進階", "設定、可靠性與疑難排解"],
    },
  },
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function validateTips(tips) {
  const ids = new Set();
  for (const tip of tips) {
    if (!tip?.id || ids.has(tip.id)) throw new Error(`Invalid or duplicate tip id: ${tip?.id}`);
    if (!LEVELS.includes(tip.level)) throw new Error(`Unknown level for ${tip.id}: ${tip.level}`);
    if (!tip.text_en?.trim() || !tip.text_zh?.trim()) throw new Error(`Missing translation for ${tip.id}`);
    ids.add(tip.id);
  }
}

function renderTip(tip, locale) {
  const text = locale === "zh" ? tip.text_zh : tip.text_en;
  const tags = (tip.tags ?? []).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const tagRow = tags ? `\n            <div class="tags" aria-label="Backend tags">${tags}</div>` : "";
  return `<article class="tip-card" id="${escapeHtml(tip.id)}" data-tip-id="${escapeHtml(tip.id)}" data-level="${tip.level}">
            <a class="tip-id" href="#${escapeHtml(tip.id)}">${escapeHtml(tip.id)}</a>
            <p>${escapeHtml(text)}</p>${tagRow}
          </article>`;
}

function renderPage(tips, locale) {
  const copy = COPY[locale];
  const sections = LEVELS.map(level => {
    const levelTips = tips.filter(tip => tip.level === level);
    const [heading, subtitle] = copy.levels[level];
    return `<section class="tips-section" id="${level}">
      <div class="section-heading">
        <div>
          <span class="eyebrow">${escapeHtml(level)}</span>
          <h2>${escapeHtml(heading)}</h2>
          <p>${escapeHtml(subtitle)}</p>
        </div>
        <span class="level-count">${levelTips.length} ${escapeHtml(copy.count)}</span>
      </div>
      <div class="tips-grid">
        ${levelTips.map(tip => renderTip(tip, locale)).join("\n        ")}
      </div>
    </section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="${copy.lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgEnD Tips</title>
  <meta name="description" content="${escapeHtml(copy.description)}">
  <link rel="icon" type="image/svg+xml" href="./favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root { color-scheme: dark; --bg:#0d1117; --surface:#161b22; --raised:#1c2129; --border:#30363d; --text:#f0f6fc; --secondary:#8b949e; --muted:#6e7681; --accent:#2aabee; --accent-dim:rgba(42,171,238,.1); }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; scroll-padding-top: 5.5rem; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:Inter,"Noto Sans TC",system-ui,sans-serif; line-height:1.65; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.22; background-image:radial-gradient(circle,var(--border) 1px,transparent 1px); background-size:24px 24px; mask-image:linear-gradient(to bottom,black,transparent 42rem); }
    a { color:inherit; }
    nav { position:sticky; top:0; z-index:10; height:64px; border-bottom:1px solid rgba(48,54,61,.7); background:rgba(13,17,23,.86); backdrop-filter:blur(14px); }
    .nav-inner { max-width:1152px; height:100%; margin:auto; padding:0 24px; display:flex; align-items:center; justify-content:space-between; gap:20px; }
    .brand { color:var(--accent); font:700 18px/1 "JetBrains Mono",monospace; text-decoration:none; }
    .nav-actions { display:flex; align-items:center; gap:12px; font-size:14px; color:var(--secondary); }
    .nav-actions a { text-decoration:none; border:1px solid var(--border); border-radius:10px; padding:6px 11px; transition:.2s ease; }
    .nav-actions a:hover { color:var(--text); border-color:var(--secondary); }
    main { position:relative; max-width:1152px; margin:auto; padding:72px 24px 96px; }
    .hero { max-width:780px; margin-bottom:64px; }
    .hero .kicker,.eyebrow { color:var(--accent); font:600 12px/1.4 "JetBrains Mono",monospace; letter-spacing:.12em; text-transform:uppercase; }
    h1 { margin:13px 0 16px; font-size:clamp(42px,7vw,72px); line-height:1.02; letter-spacing:-.045em; }
    .hero p { color:var(--secondary); font-size:18px; margin:0; }
    .jump-links { display:flex; flex-wrap:wrap; gap:10px; margin-top:28px; }
    .jump-links a { text-decoration:none; color:var(--secondary); background:var(--surface); border:1px solid var(--border); border-radius:999px; padding:7px 13px; font-size:13px; }
    .jump-links a:hover { color:var(--accent); border-color:var(--accent); }
    .tips-section { margin-top:72px; }
    .section-heading { display:flex; justify-content:space-between; align-items:end; gap:24px; padding-bottom:20px; border-bottom:1px solid var(--border); margin-bottom:20px; }
    .section-heading h2 { margin:5px 0 2px; font-size:30px; letter-spacing:-.025em; }
    .section-heading p { margin:0; color:var(--secondary); }
    .level-count { white-space:nowrap; color:var(--muted); font:500 13px/1.4 "JetBrains Mono",monospace; }
    .tips-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .tip-card { position:relative; display:grid; grid-template-columns:64px 1fr; gap:14px; align-items:start; padding:18px; background:rgba(22,27,34,.94); border:1px solid var(--border); border-radius:14px; transition:transform .2s ease,border-color .2s ease; }
    .tip-card:hover { transform:translateY(-2px); border-color:var(--accent); }
    .tip-card:target { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-dim); }
    .tip-id { padding-top:2px; color:var(--accent); font:600 11px/1.5 "JetBrains Mono",monospace; text-decoration:none; }
    .tip-card p { margin:0; color:#d8dee4; font-size:14px; }
    .tags { grid-column:2; display:flex; flex-wrap:wrap; gap:6px; margin-top:2px; }
    .tag { color:var(--secondary); background:var(--raised); border:1px solid var(--border); border-radius:999px; padding:2px 8px; font:500 10px/1.5 "JetBrains Mono",monospace; }
    footer { border-top:1px solid var(--border); color:var(--muted); font-size:13px; }
    .footer-inner { max-width:1152px; margin:auto; padding:30px 24px; display:flex; justify-content:space-between; gap:16px; }
    @media (max-width:760px) { main { padding-top:48px; } .tips-grid { grid-template-columns:1fr; } .section-heading { align-items:start; flex-direction:column; gap:8px; } .tip-card { grid-template-columns:56px 1fr; } .footer-inner { flex-direction:column; } }
  </style>
</head>
<body>
  <nav><div class="nav-inner"><a class="brand" href="./">AgEnD</a><div class="nav-actions"><a href="./">${escapeHtml(copy.home)}</a><a href="${copy.switchHref}" hreflang="${locale === "zh" ? "en" : "zh-TW"}">${escapeHtml(copy.switchLabel)}</a></div></div></nav>
  <main>
    <header class="hero"><span class="kicker">Knowledge library</span><h1>AgEnD Tips</h1><p>${escapeHtml(copy.intro)}</p><div class="jump-links">${LEVELS.map(level => `<a href="#${level}">${escapeHtml(copy.levels[level][0])}</a>`).join("")}</div></header>
    ${sections}
  </main>
  <footer><div class="footer-inner"><span><strong>AgEnD</strong> · Multi-Agent, One Conversation</span><span>Generated from <code>src/tips.ts</code></span></div></footer>
</body>
</html>
`;
}

validateTips(TIPS);
const publicDir = fileURLToPath(new URL("../website/public/", import.meta.url));
mkdirSync(publicDir, { recursive: true });
writeFileSync(`${publicDir}/tips-en.html`, renderPage(TIPS, "en"), "utf8");
writeFileSync(`${publicDir}/tips-zh.html`, renderPage(TIPS, "zh"), "utf8");
console.log(`Generated website tips pages (${TIPS.length} tips × 2 locales)`);

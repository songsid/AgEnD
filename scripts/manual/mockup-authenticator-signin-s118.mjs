// S-118 proposal only: real signin.html/theme/tokens/signin.js, then a presentation-only DOM projection.
// No FleetManager, auth store, credentials or production source is changed. POSTs are refused.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const repo = process.cwd();
const require = createRequire(join(resolve(process.env.PW_DIR || repo), "package.json"));
const { chromium } = require("playwright-core");
const out = join(repo, "docs/screenshots/authenticator-signin-s118");
await mkdir(out, { recursive: true });
const files = {
  "/signin": ["src/ui/signin.html", "text/html; charset=utf-8"],
  "/assets/signin.js": ["src/ui/shared/signin.js", "text/javascript"],
  "/assets/theme.js": ["src/ui/shared/theme.js", "text/javascript"],
  "/assets/tokens.css": ["src/ui/shared/tokens.css", "text/css"],
  "/assets/loading.css": ["src/ui/shared/loading.css", "text/css"],
};
const proposalCss = `
#reach { margin-top: var(--s-4); border-top: 1px solid var(--border); padding-top: var(--s-2); }
#reach summary { min-height: var(--tap); display: flex; align-items: center; color: var(--text-2); }
#reach summary::before { content: "▸"; margin-right: var(--s-2); color: var(--text-3); }
#reach[open] summary::before { content: "▾"; }
#reach p { margin: 0 0 var(--s-2); }
#reach ul { padding-left: var(--s-5); margin: var(--s-2) 0; }
#reach li { margin: var(--s-2) 0; }
#fallbackHint { margin-top: var(--s-3); color: var(--text-3); font-size: var(--fs-xs); }
#fallbackAction { min-height: var(--tap); }
`;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (req.method !== "GET") { res.writeHead(405); res.end("Design projection: no authentication"); return; }
  if (path === "/auth/session") { res.writeHead(401, { "Content-Type": "application/json" }); res.end('{"error":"unauthorized"}'); return; }
  if (path === "/auth/device") { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"returning":false}'); return; }
  if (path === "/assets/s118-proposal.css") { res.writeHead(200, { "Content-Type": "text/css" }); res.end(proposalCss); return; }
  const file = files[path];
  if (!file) { res.writeHead(204); res.end(); return; }
  try {
    let bytes = await readFile(join(repo, file[0]));
    if (path === "/signin") bytes = Buffer.from(bytes.toString().replace("</head>", '<link rel="stylesheet" href="/assets/s118-proposal.css"></head>'));
    res.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-store" }); res.end(bytes);
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const captures = [];
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox", "--disable-background-networking"] });
  const words = {
    "zh-TW": {
      primary: "打開你的驗證器 App，輸入 AgEnD 的驗證碼。", label: "6 位數驗證碼（驗證器 App）",
      fallback: "改用裝置登入碼", fallbackHint: "還沒設定驗證器？也可以使用裝置登入碼。",
      reach: "如何在手機開啟 AgEnD？", reachLead: "先在手機瀏覽器開啟 AgEnD 的網址，再輸入驗證碼。",
      ways: ["同一個 Wi-Fi：使用 AgEnD 電腦的區網網址。localhost 只適用於那台電腦。", "Tailnet：兩台裝置先連上同一個 tailnet，再開啟該電腦的網址。", "外部入口：使用管理員已開啟的外部網址。這裡不會自動開啟公開連結。"],
      fallbackLead: "輸入你的 8 字元裝置登入碼。", fallbackLabel: "裝置登入碼", back: "改用驗證器登入",
      deviceHint: "在 General 傳 /web，按登入按鈕取得裝置登入碼。它只能使用一次。",
      wrong: "驗證碼不對或已用過。請確認手機時間正確，再輸入最新的驗證碼。",
    },
    en: {
      primary: "Open your authenticator app and enter your AgEnD code.", label: "6-digit authenticator code",
      fallback: "Use a device sign-in code", fallbackHint: "No authenticator set up? You can use a device sign-in code instead.",
      reach: "How does my phone reach AgEnD?", reachLead: "Open the AgEnD address in your phone's browser, then enter your code.",
      ways: ["Same Wi-Fi: use the AgEnD computer's LAN address. localhost works only on that computer.", "Tailnet: connect both devices to the same tailnet, then open the computer's address.", "Outside entry: use an outside address the admin has already opened. This page never opens a public link for you."],
      fallbackLead: "Enter your 8-character device sign-in code.", fallbackLabel: "Device sign-in code", back: "Use my authenticator",
      deviceHint: "Send /web in General, then press a sign-in button to get a code. It can be used only once.",
      wrong: "That code is wrong or was already used. Check your phone's clock and try the newest code.",
    },
  };
  for (const lang of ["zh-TW", "en"]) for (const screen of ["desk-light", "phone-dark"]) {
    const phone = screen.startsWith("phone");
    const context = await browser.newContext({ locale: lang, viewport: { width: phone ? 390 : 1366, height: phone ? 844 : 900 }, colorScheme: phone ? "dark" : "light" });
    await context.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    const page = await context.newPage();
    for (const state of ["primary", "reach", "fallback", "wrong"]) {
      if (lang === "en" && state !== "primary") continue;
      await page.goto(origin + "/signin");
      await page.waitForSelector("#form:not([hidden])");
      await page.evaluate(({ w, state }) => {
        const form = document.getElementById("form");
        form.querySelector("h1").textContent = document.documentElement.lang.startsWith("zh") ? "登入 AgEnD" : "Sign in to AgEnD";
        form.querySelector("p").textContent = state === "fallback" ? w.fallbackLead : w.primary;
        form.querySelector("label").textContent = state === "fallback" ? w.fallbackLabel : w.label;
        const code = document.getElementById("code");
        code.placeholder = state === "fallback" ? "XXXX-XXXX" : "123456";
        code.inputMode = state === "fallback" ? "text" : "numeric";
        code.maxLength = state === "fallback" ? 9 : 6;
        code.value = "";
        document.getElementById("resend").hidden = true;
        document.getElementById("another").hidden = true;
        form.querySelector(".hint").hidden = true;
        form.querySelectorAll("details").forEach(d => { d.hidden = true; });
        const msg = document.getElementById("msg");
        msg.textContent = state === "wrong" ? w.wrong : "";
        msg.hidden = state !== "wrong";
        const button = document.createElement("button");
        button.id = "fallbackAction"; button.type = "button"; button.className = "secondary";
        button.textContent = state === "fallback" ? w.back : w.fallback;
        document.getElementById("go").after(button);
        const hint = document.createElement("p"); hint.id = "fallbackHint";
        hint.textContent = state === "fallback" ? w.deviceHint : w.fallbackHint;
        button.after(hint);
        const reach = document.createElement("details"); reach.id = "reach"; reach.className = "help"; reach.open = state === "reach";
        const summary = document.createElement("summary"); summary.textContent = w.reach;
        const lead = document.createElement("p"); lead.textContent = w.reachLead;
        const ul = document.createElement("ul");
        for (const text of w.ways) { const li = document.createElement("li"); li.textContent = text; ul.append(li); }
        reach.append(summary, lead, ul); form.append(reach);
        code.blur();
      }, { w: words[lang], state });
      await page.evaluate(() => document.fonts.ready);
      const geometry = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth, top: document.querySelector("main").getBoundingClientRect().top, buttons: [...document.querySelectorAll("button:not([hidden]),#reach summary")].filter(n => n.getClientRects().length).map(n => ({ text: n.textContent, height: n.getBoundingClientRect().height })) }));
      if (geometry.scroll > geometry.width || geometry.top < 0 || geometry.buttons.some(b => b.height < 44)) throw new Error(JSON.stringify(geometry));
      const name = `${screen}-${lang}-${state}.png`;
      await page.screenshot({ path: join(out, name), fullPage: true });
      const bytes = await readFile(join(out, name));
      captures.push({ file: name, sha256: createHash("sha256").update(bytes).digest("hex"), geometry });
    }
    await context.close();
  }
  await writeFile(join(out, "receipt.json"), JSON.stringify({ base: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), browser: browser.version(), scope: "Presentation-only proposal in actual sign-in shell; auth POSTs refused. Per-admin LAN/chat sign-in is not supplied by #3503. No production source/auth core changed.", captures }, null, 2) + "\n");
  console.log(JSON.stringify({ captures: captures.length, out, browser: browser.version() }));
} finally {
  await browser?.close();
  await new Promise(r => server.close(r));
}

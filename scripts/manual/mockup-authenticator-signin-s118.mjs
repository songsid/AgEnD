// Code-only proposal: actual signin.html shell, presentation-only DOM projection.
// Decision a690be6b; no production/core change. All sign-in POSTs refused.
// The next-code state is visual only; its API answer shape awaits Junsion’s core PR.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const repo = process.cwd();
process.env.REPO = repo;
process.env.PW_DIR ||= repo;
const require = createRequire(join(resolve(process.env.PW_DIR), "package.json"));
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
body { align-items: flex-start; padding-top: 64px; }
@media (max-width: 600px) { body { padding-top: 32px; } }
.s118-term { white-space: nowrap; }
#reach { margin-top: var(--s-4); border-top: 1px solid var(--border); padding-top: var(--s-2); }
#reach summary { min-height: var(--tap); display: flex; align-items: center; color: var(--text-2); }
#reach summary::before { content: "▸"; margin-right: var(--s-2); color: var(--text-3); }
#reach[open] summary::before { content: "▾"; }
#reach p { margin: 0 0 var(--s-2); }
#reach ul { padding-left: var(--s-5); margin: var(--s-2) 0; }
#reach li { margin: var(--s-2) 0; }
#fallbackHint { margin-top: var(--s-3); color: var(--text-3); font-size: var(--fs-xs); }
#fallbackAction { min-height: var(--tap); }
#errorHint { margin: var(--s-2) 0 0; color: var(--text-2); font-size: var(--fs-sm); }
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
const words = {
  "zh-TW": {
    primary: "輸入驗證器 App 的 6 位數驗證碼。",
    label: "6 位數驗證碼（驗證器 App）", signIn: "登入",
    fallback: "改用 8 字元裝置登入碼", fallbackHint: "尚未設定驗證器 App？請使用 8 字元裝置登入碼。",
    reach: "如何在手機開啟 AgEnD？", reachLead: "在手機瀏覽器開啟 AgEnD 網址：",
    ways: ["同一個 Wi-Fi：使用電腦的區網網址。", "私人網路（如 Tailscale）：兩台裝置先連上同一個網路。", "外部連線：使用管理員提供的網址。"],
    fallbackLead: "輸入你的 8 字元裝置登入碼。", fallbackLabel: "8 字元裝置登入碼", back: "改用驗證器 App 登入",
    deviceHint: "在聊天平台的 General 傳送 /web，取得只能使用一次的 8 字元裝置登入碼。",
    wrong: "無法登入。請使用驗證器 App 最新的驗證碼，並確認驗證器所在裝置的時間正確。",
    wrongHint: "若驗證碼正確，登入可能暫時受限。請改用 8 字元裝置登入碼，或使用之前登入過的裝置。",
    paused: "登入已暫停，請等 5 分鐘後再試。", pausedButton: "暫時無法登入", pausedHint: "也可以改用 8 字元裝置登入碼，或使用之前登入過的裝置。",
    next: "請等待驗證器 App 顯示下一組驗證碼，再試一次。", nextButton: "等待下一組驗證碼",
  },
  en: {
    primary: "Enter the 6-digit code from your authenticator app.",
    label: "6-digit authenticator code", signIn: "Sign in",
    fallback: "Use an 8-character device sign-in code", fallbackHint: "No authenticator app set up? Use an 8-character device sign-in code.",
    reach: "How does my phone reach AgEnD?", reachLead: "Open this AgEnD's address in your phone's browser, then sign in.",
    ways: ["Same Wi-Fi: use the computer's local network address.", "Private network, such as Tailscale: connect both devices to that network first.", "Outside connection: use the address your admin provides."],
    fallbackLead: "Enter your 8-character device sign-in code.", fallbackLabel: "8-character device sign-in code", back: "Use my authenticator",
    deviceHint: "Send /web in General on your chat platform to get a single-use 8-character device sign-in code.",
    wrong: "Could not sign in. Use the newest code in your authenticator app and check the clock on your authenticator device.",
    wrongHint: "If you are sure the code is right, sign-in may be limited for a while: use the 8-character device sign-in code instead, or a device you have signed in from before.",
    paused: "Sign-in is paused. Please wait 5 minutes, then try again.", pausedButton: "Sign-in paused", pausedHint: "You can also use an 8-character device sign-in code, or use a device you have signed in from before.",
    next: "Wait for the next code to appear in your authenticator app, then try again.", nextButton: "Wait for the next code",
  },
};
let browser;
const captures = [];
let version;
const record = async (page, name) => {
  await page.evaluate(() => document.fonts.ready);
  const geometry = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth,
    top: document.querySelector("main").getBoundingClientRect().top,
    buttons: [...document.querySelectorAll("#form button:not([hidden]),#reach summary,input:not([hidden])")].filter(n => n.getClientRects().length).map(n => ({ text: n.textContent || n.id, height: n.getBoundingClientRect().height })),
    nameInputs: document.querySelectorAll('#account,[autocomplete="username"],#s118SigninName').length,
    codeEmpty: document.querySelector("#code").value === "", placeholder: document.querySelector("#code").placeholder,
    background: getComputedStyle(document.body).backgroundColor,
  }));
  if (geometry.scroll > geometry.width || geometry.top !== (name.startsWith("phone") ? 32 : 64) || geometry.buttons.some(b => b.height < 44) || geometry.nameInputs || !geometry.codeEmpty || (!name.includes("fallback") && geometry.placeholder)) throw new Error(JSON.stringify(geometry));
  await page.screenshot({ path: join(out, name), fullPage: true });
  captures.push({ file: name, kind: "signin", geometry });
};
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox", "--disable-background-networking"] });
  version = browser.version();
  for (const lang of ["zh-TW", "en"]) for (const screen of ["desk-light", "phone-dark"]) {
    const phone = screen.startsWith("phone");
    const context = await browser.newContext({ locale: lang, viewport: { width: phone ? 390 : 1366, height: phone ? 844 : 900 }, colorScheme: phone ? "dark" : "light" });
    await context.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    const page = await context.newPage();
    for (const state of ["primary", "reach", "fallback", "wrong", "paused", "next-code"]) {
      await page.goto(origin + "/signin"); await page.waitForSelector("#form:not([hidden])");
      await page.evaluate(({ w, state, lang }) => {
        const form = document.getElementById("form");
        form.addEventListener("submit", e => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
        form.querySelector("h1").textContent = lang === "zh-TW" ? "登入 AgEnD" : "Sign in to AgEnD";
        form.querySelector("p").textContent = state === "fallback" ? w.fallbackLead : w.primary;
        const codeLabel = form.querySelector('label[for="code"]'); codeLabel.textContent = state === "fallback" ? w.fallbackLabel : w.label;
        const code = document.getElementById("code");
        code.placeholder = state === "fallback" ? "XXXX-XXXX" : ""; code.inputMode = state === "fallback" ? "text" : "numeric"; code.autocomplete = "one-time-code"; code.maxLength = state === "fallback" ? 12 : 32; code.value = "";
        document.getElementById("resend").hidden = true; document.getElementById("another").hidden = true;
        form.querySelector(".hint").hidden = true; form.querySelectorAll("details").forEach(d => { d.hidden = true; });
        const go = document.getElementById("go"); go.textContent = state === "paused" ? w.pausedButton : state === "next-code" ? w.nextButton : w.signIn; go.disabled = ["paused", "next-code"].includes(state);
        const msg = document.getElementById("msg"); msg.textContent = state === "wrong" ? w.wrong : state === "paused" ? w.paused : state === "next-code" ? w.next : ""; msg.hidden = !["wrong", "paused", "next-code"].includes(state); msg.className = state === "wrong" ? "" : "ok"; msg.setAttribute("role", state === "wrong" ? "alert" : "status");
        if (state === "wrong" || state === "paused") { const hint = document.createElement("p"); hint.id = "errorHint"; hint.textContent = state === "wrong" ? w.wrongHint : w.pausedHint; msg.after(hint); }
        const button = document.createElement("button"); button.id = "fallbackAction"; button.type = "button"; button.className = "secondary"; button.textContent = state === "fallback" ? w.back : w.fallback;
        go.after(button);
        const hint = document.createElement("p"); hint.id = "fallbackHint"; hint.textContent = state === "fallback" ? w.deviceHint : w.fallbackHint; button.after(hint);
        const reach = document.createElement("details"); reach.id = "reach"; reach.className = "help"; reach.open = state === "reach";
        const summary = document.createElement("summary"); summary.textContent = w.reach;
        const lead = document.createElement("p"); lead.textContent = w.reachLead;
        const ul = document.createElement("ul"); for (const text of w.ways) { const li = document.createElement("li"); li.textContent = text; ul.append(li); }
        reach.append(summary, lead, ul); form.append(reach); code.blur();
        // Projection only: keep short Chinese UI terms intact, without disabling normal paragraph wrapping.
        if (lang === "zh-TW") {
          const terms = /8 字元裝置登入碼|使用之前登入過的裝置|同一個網路|驗證器 App|驗證器|下一組驗證碼|驗證碼|每組|立即|直接|核准/g;
          const texts = [], walk = document.createTreeWalker(form, NodeFilter.SHOW_TEXT);
          while (walk.nextNode()) texts.push(walk.currentNode);
          for (const text of texts) { const parts = text.textContent.split(terms), matches = text.textContent.match(terms); if (!matches) continue;
            const fragment = document.createDocumentFragment(); parts.forEach((part, i) => { fragment.append(part); if (matches[i]) { const term = document.createElement("span"); term.className = "s118-term"; term.textContent = matches[i]; fragment.append(term); } }); text.replaceWith(fragment);
          }
        }
      }, { w: words[lang], state, lang });
      await record(page, `${screen}-${lang}-${state}.png`);
    }
    await context.close();
  }
  await browser.close(); browser = null;
  const digest = async name => createHash("sha256").update(await readFile(join(out, name))).digest("hex");
  await writeFile(join(out, "SHA256SUMS"), (await Promise.all(captures.map(async c => `${await digest(c.file)}  ${c.file}\n`))).join(""));
  await writeFile(join(out, "receipt.json"), JSON.stringify({ base: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), contract: "Decision a690be6b code-only; shell #3548 d5e2a3c8; code-only/next-code core response pending", browser: version, scope: "Code-only design projection in actual signin.html. No name field or Settings name row. Static sign-in POSTs refused. Next-code is presentation only: its exact HTTP answer waits for Junsion core. No production/core/SKEW/live-auth acceptance.", captures }, null, 2) + "\n");
  console.log(JSON.stringify({ captures: captures.length, out, browser: version }));
} finally {
  await browser?.close(); await new Promise(r => server.close(r));
}

// Unified-code proposal: actual signin.html shell, presentation-only DOM projection.
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
#codeHint { margin: var(--s-2) 0 0; color: var(--text-3); font-size: var(--fs-xs); }
#go:disabled { color: var(--text-2); background: var(--surface-2); opacity: 1; cursor: default; }
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
    primary: "填入驗證器 App 的 6 位數驗證碼，即會自動登入。",
    label: "驗證碼或裝置登入碼", signIn: "登入", codeHint: "也可以貼上 8 字元裝置登入碼",
    reach: "如何在手機開啟 AgEnD？", reachLead: "在手機瀏覽器開啟 AgEnD 網址：",
    ways: ["同一個 Wi-Fi：使用電腦的區網網址。", "私人網路（如 Tailscale）：兩台裝置先連上同一個網路。", "外部連線：使用管理員提供的網址。"],
    wrong: "無法登入。請使用驗證器 App 最新的驗證碼，並確認驗證器所在裝置的時間正確。",
    wrongHint: "若驗證碼正確仍無法登入，請貼上 8 字元裝置登入碼，或使用先前登入過的裝置。",
    paused: "登入已暫停，請等 5 分鐘後再試。", pausedButton: "暫時無法登入", pausedHint: "也可以使用先前登入過的裝置。",
    next: "請等待驗證器 App 顯示下一組驗證碼，再試一次。", nextButton: "等待下一組驗證碼",
  },
  en: {
    primary: "Enter your authenticator app’s 6-digit code to sign in automatically.",
    label: "Authenticator or device sign-in code", signIn: "Sign in", codeHint: "You can also paste an 8-character device sign-in code",
    reach: "How does my phone reach AgEnD?", reachLead: "Open this AgEnD's address in your phone's browser, then sign in.",
    ways: ["Same Wi-Fi: use the computer's local network address.", "Private network, such as Tailscale: connect both devices to that network first.", "Outside connection: use the address your admin provides."],
    wrong: "Could not sign in. Use the newest code in your authenticator app and check the clock on your authenticator device.",
    wrongHint: "If the code is correct but you still cannot sign in, paste an 8-character device sign-in code, or use a device you have signed in from before.",
    paused: "Sign-in is paused. Please wait 5 minutes, then try again.", pausedButton: "Sign-in paused", pausedHint: "You can also use a device you have signed in from before.",
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
    visibleInputs: [...document.querySelectorAll("#form input")].filter(n => n.getClientRects().length).length,
    switchPresent: !!document.querySelector("#fallbackAction"),
    hintLines: Math.round(document.querySelector("#codeHint").getBoundingClientRect().height / parseFloat(getComputedStyle(document.querySelector("#codeHint")).lineHeight)),
    disabled: document.querySelector("#go").disabled,
    disabledText: getComputedStyle(document.querySelector("#go")).color, disabledBackground: getComputedStyle(document.querySelector("#go")).backgroundColor, disabledOpacity: getComputedStyle(document.querySelector("#go")).opacity,
  }));
  if (geometry.scroll > geometry.width || geometry.top !== (name.startsWith("phone") ? 32 : 64) || geometry.buttons.some(b => b.height < 44) || geometry.nameInputs || !geometry.codeEmpty || (geometry.placeholder || geometry.switchPresent || geometry.visibleInputs !== 1 || (name.includes("zh-TW") && geometry.hintLines !== 1))) throw new Error(JSON.stringify(geometry));
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
    for (const state of ["primary", "reach", "wrong", "paused", "next-code"]) {
      await page.goto(origin + "/signin"); await page.waitForSelector("#form:not([hidden])");
      await page.evaluate(({ w, state, lang }) => {
        const form = document.getElementById("form");
        form.addEventListener("submit", e => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
        form.querySelector("h1").textContent = lang === "zh-TW" ? "登入 AgEnD" : "Sign in to AgEnD";
        form.querySelector("p").textContent = w.primary;
        const codeLabel = form.querySelector('label[for="code"]'); codeLabel.textContent = w.label;
        const code = document.getElementById("code");
        code.placeholder = ""; code.inputMode = "text"; code.autocomplete = "one-time-code"; code.maxLength = 32; code.value = "";
        const codeHint = document.createElement("p"); codeHint.id = "codeHint"; codeHint.textContent = w.codeHint; code.after(codeHint);
        document.getElementById("resend").hidden = true; document.getElementById("another").hidden = true;
        form.querySelector(".hint").hidden = true; form.querySelectorAll("details").forEach(d => { d.hidden = true; });
        const go = document.getElementById("go"); go.textContent = state === "paused" ? w.pausedButton : state === "next-code" ? w.nextButton : w.signIn; go.disabled = ["paused", "next-code"].includes(state);
        const msg = document.getElementById("msg"); msg.textContent = state === "wrong" ? w.wrong : state === "paused" ? w.paused : state === "next-code" ? w.next : ""; msg.hidden = !["wrong", "paused", "next-code"].includes(state); msg.className = state === "wrong" ? "" : "ok"; msg.setAttribute("role", state === "wrong" ? "alert" : "status");
        if (state === "wrong" || state === "paused") { const hint = document.createElement("p"); hint.id = "errorHint"; hint.textContent = state === "wrong" ? w.wrongHint : w.pausedHint; msg.after(hint); }
        const reach = document.createElement("details"); reach.id = "reach"; reach.className = "help"; reach.open = state === "reach";
        const summary = document.createElement("summary"); summary.textContent = w.reach;
        const lead = document.createElement("p"); lead.textContent = w.reachLead;
        const ul = document.createElement("ul"); for (const text of w.ways) { const li = document.createElement("li"); li.textContent = text; ul.append(li); }
        reach.append(summary, lead, ul); form.append(reach); code.blur();
        // Projection only: keep short Chinese UI terms intact, without disabling normal paragraph wrapping.
        if (lang === "zh-TW") {
          const terms = /8 字元裝置登入碼|使用先前登入過的裝置|同一個網路|驗證器 App|驗證器|下一組驗證碼|驗證碼|自動登入|每組|立即|直接|核准/g;
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
  await writeFile(join(out, "receipt.json"), JSON.stringify({ base: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), contract: "Unified-input UI revision; decision a690be6b; shell #3548 d5e2a3c8; code-only/next-code core response pending", browser: version, scope: "Unified-input design projection in actual signin.html. One field, no switch/name/Settings name row. All POSTs refused; no auto-submit implementation. Alphabet/route read from owned source; six-digit numeric-prefix ambiguity disclosed in design. Next-code API waits Junsion core. No production/core/SKEW/live-auth acceptance.", captures }, null, 2) + "\n");
  console.log(JSON.stringify({ captures: captures.length, out, browser: version }));
} finally {
  await browser?.close(); await new Promise(r => server.close(r));
}

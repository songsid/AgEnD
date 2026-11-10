// Proposal only: actual signin.html and Settings shells, presentation-only DOM projection.
// No production source/core change. Static sign-in POSTs refused; Settings uses a synthetic own-name read.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { bootFixture } from "./smoke-fixture/index.mts";
const repo = process.cwd();
if (!process.env.SETTINGS_REPO) throw new Error("set SETTINGS_REPO to the owned 2.3.x build root for Settings captures");
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
#account { text-align: left; text-transform: none; letter-spacing: normal; font: var(--fw-regular) var(--fs-lg)/var(--lh-md) var(--font-ui); min-height: var(--tap); }
#nameHint { margin: var(--s-2) 0 var(--s-4); color: var(--text-3); font-size: var(--fs-xs); }
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
    primary: "輸入你的登入名稱，以及驗證器 App 的驗證碼。", account: "登入名稱", nameHint: "在已登入的裝置，前往「設定 → 存取與安全 → 擁有者驗證」查看你的登入名稱。",
    label: "6 位數驗證碼（驗證器 App）", signIn: "登入",
    fallback: "改用裝置登入碼", fallbackHint: "還沒設定驗證器？也可以使用裝置登入碼。",
    reach: "如何在手機開啟 AgEnD？", reachLead: "先在手機瀏覽器開啟這個 AgEnD 的網址，再登入。",
    ways: ["同一個 Wi-Fi：使用 AgEnD 電腦的區網網址。localhost 只適用於那台電腦。", "Tailnet：兩台裝置先連上同一個 tailnet，再開啟該電腦的網址。", "外部入口：使用管理員已開啟的外部網址。這裡不會自動開啟公開連結。"],
    fallbackLead: "輸入你的 8 字元裝置登入碼。", fallbackLabel: "裝置登入碼", back: "改用驗證器登入",
    deviceHint: "在聊天平台的 General 傳 /web，取得裝置登入碼。它只能使用一次。",
    wrong: "無法登入。請確認登入名稱、App 裡最新的驗證碼，以及手機時間。",
    wrongHint: "如果確定驗證碼正確，登入可能暫時受限制。請改用 8 字元裝置登入碼，或使用之前登入過的裝置。",
    paused: "登入暫停，請等 5 分鐘後再試。", pausedButton: "5 分鐘後再試", pausedHint: "也可以改用 8 字元裝置登入碼，或回到之前登入過的裝置。",
    ownName: "你的登入名稱", ownHint: "在其他裝置用驗證器登入時，輸入這個名稱。",
  },
  en: {
    primary: "Enter your sign-in name and the code from your authenticator app.", account: "Sign-in name", nameHint: "On a signed-in device, find your name in Settings → Access & security → Owner verification.",
    label: "6-digit authenticator code", signIn: "Sign in",
    fallback: "Use a device sign-in code", fallbackHint: "No authenticator set up? Use a device sign-in code instead.",
    reach: "How does my phone reach AgEnD?", reachLead: "Open this AgEnD's address in your phone's browser, then sign in.",
    ways: ["Same Wi-Fi: use the AgEnD computer's LAN address. localhost works only on that computer.", "Tailnet: connect both devices to the same tailnet, then open the computer's address.", "Outside entry: use an outside address the admin has already opened. This page never opens a public link for you."],
    fallbackLead: "Enter your 8-character device sign-in code.", fallbackLabel: "Device sign-in code", back: "Use my authenticator",
    deviceHint: "Send /web in General on your chat platform to get a device sign-in code. It can be used only once.",
    wrong: "Could not sign in. Check your sign-in name, the newest code in your app and your phone's clock.",
    wrongHint: "If you are sure the code is right, sign-in may be limited for a while: use the 8-character device sign-in code instead, or a device you have signed in from before.",
    paused: "Sign-in is paused. Please wait 5 minutes, then try again.", pausedButton: "Try again in 5 minutes", pausedHint: "You can also use an 8-character device sign-in code, or return to a device you signed in from before.",
    ownName: "Your sign-in name", ownHint: "Enter this name when signing in with your authenticator on another device.",
  },
};
let browser, fx;
const settingsOnly = process.env.SETTINGS_ONLY === "1";
const previous = settingsOnly ? JSON.parse(await readFile(join(out, "receipt.json"), "utf8")) : null;
const captures = previous ? previous.captures.filter(c => c.kind === "signin") : [];
let version = previous?.browser;
const record = async (page, name, kind) => {
  await page.evaluate(() => document.fonts.ready);
  const geometry = await page.evaluate((kind) => ({ scroll: document.documentElement.scrollWidth, width: innerWidth,
    top: kind === "signin" ? document.querySelector("main").getBoundingClientRect().top : null,
    buttons: kind === "signin" ? [...document.querySelectorAll("#form button:not([hidden]),#reach summary,input:not([hidden])")].filter(n => n.getClientRects().length).map(n => ({ text: n.textContent || n.id, height: n.getBoundingClientRect().height })) : [],
    nameVisible: kind === "settings" ? !!document.getElementById("s118SigninName")?.getClientRects().length : null,
    versionDetail: kind === "settings" ? document.querySelector(".pill.ver")?.getAttribute("aria-label") : null,
  }), kind);
  if (geometry.scroll > geometry.width || geometry.top < 0 || geometry.buttons.some(b => b.height < 44) || (kind === "settings" && (!geometry.nameVisible || !geometry.versionDetail?.includes("2.3.5-alpha.10+s118")))) throw new Error(JSON.stringify(geometry));
  await page.screenshot({ path: join(out, name), fullPage: true });
  captures.push({ file: name, kind, geometry });
};
try {
  if (!settingsOnly) {
  browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox", "--disable-background-networking"] });
  version = browser.version();
  for (const lang of ["zh-TW", "en"]) for (const screen of ["desk-light", "phone-dark"]) {
    const phone = screen.startsWith("phone");
    const context = await browser.newContext({ locale: lang, viewport: { width: phone ? 390 : 1366, height: phone ? 844 : 900 }, colorScheme: phone ? "dark" : "light" });
    await context.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    const page = await context.newPage();
    for (const state of ["primary", "reach", "fallback", "wrong", "paused"]) {
      await page.goto(origin + "/signin"); await page.waitForSelector("#form:not([hidden])");
      await page.evaluate(({ w, state, lang }) => {
        const form = document.getElementById("form");
        form.addEventListener("submit", e => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
        form.querySelector("h1").textContent = lang === "zh-TW" ? "登入 AgEnD" : "Sign in to AgEnD";
        form.querySelector("p").textContent = state === "fallback" ? w.fallbackLead : w.primary;
        const codeLabel = form.querySelector('label[for="code"]'); codeLabel.textContent = state === "fallback" ? w.fallbackLabel : w.label;
        if (state !== "fallback") {
          const nameLabel = document.createElement("label"); nameLabel.htmlFor = "account"; nameLabel.textContent = w.account;
          const name = document.createElement("input"); name.id = "account"; name.name = "account"; name.type = "text"; name.autocomplete = "username"; name.autocapitalize = "none"; name.spellcheck = false; name.placeholder = "alice_tg"; name.maxLength = 256;
          if (state === "wrong" || state === "paused") name.value = "alice_tg";
          const nameHint = document.createElement("p"); nameHint.id = "nameHint"; nameHint.textContent = w.nameHint;
          codeLabel.before(nameLabel, name, nameHint);
        }
        const code = document.getElementById("code");
        code.placeholder = state === "fallback" ? "XXXX-XXXX" : "123456"; code.inputMode = state === "fallback" ? "text" : "numeric"; code.autocomplete = "one-time-code"; code.maxLength = state === "fallback" ? 12 : 32; code.value = "";
        document.getElementById("resend").hidden = true; document.getElementById("another").hidden = true;
        form.querySelector(".hint").hidden = true; form.querySelectorAll("details").forEach(d => { d.hidden = true; });
        const go = document.getElementById("go"); go.textContent = state === "paused" ? w.pausedButton : w.signIn; go.disabled = state === "paused";
        const msg = document.getElementById("msg"); msg.textContent = state === "wrong" ? w.wrong : state === "paused" ? w.paused : ""; msg.hidden = !["wrong", "paused"].includes(state); msg.className = state === "paused" ? "ok" : "";
        if (state === "wrong" || state === "paused") { const hint = document.createElement("p"); hint.id = "errorHint"; hint.textContent = state === "wrong" ? w.wrongHint : w.pausedHint; msg.after(hint); }
        const button = document.createElement("button"); button.id = "fallbackAction"; button.type = "button"; button.className = "secondary"; button.textContent = state === "fallback" ? w.back : w.fallback;
        go.after(button);
        const hint = document.createElement("p"); hint.id = "fallbackHint"; hint.textContent = state === "fallback" ? w.deviceHint : w.fallbackHint; button.after(hint);
        const reach = document.createElement("details"); reach.id = "reach"; reach.className = "help"; reach.open = state === "reach";
        const summary = document.createElement("summary"); summary.textContent = w.reach;
        const lead = document.createElement("p"); lead.textContent = w.reachLead;
        const ul = document.createElement("ul"); for (const text of w.ways) { const li = document.createElement("li"); li.textContent = text; ul.append(li); }
        reach.append(summary, lead, ul); form.append(reach); code.blur();
      }, { w: words[lang], state, lang });
      await record(page, `${screen}-${lang}-${state}.png`, "signin");
    }
    await context.close();
  }
  await browser.close(); browser = null;
  }
  process.env.REPO = resolve(process.env.SETTINGS_REPO || repo);
  const settingsBuildVersion = JSON.parse(await readFile(join(process.env.REPO, "package.json"), "utf8")).version;
  // Actual dashboard Settings shell; only the own-admin status and the proposed static name row are projected.
  fx = await bootFixture({ port: Number(process.env.HP ?? 47740), classic: false, instances: 3 });
  for (const lang of ["zh-TW", "en"]) for (const screen of ["desk-light", "phone-dark"]) {
    const phone = screen.startsWith("phone");
    const p = await fx.page({ device: phone ? "phone" : "desk", theme: phone ? "dark" : "light", lang });
    try {
      await p.ctx.route("**/ui/outside", r => r.request().method() === "GET" ? r.fulfill({ json: { webOnly: false, here: true, manage: true, codeNeeded: false, strict: false, enrolled: true, enrolledAt: Date.UTC(2026, 10, 9), outside: false, pausedForMs: 0, link: null, signinName: "alice_tg" } }) : r.fulfill({ status: 405 }));
      await p.ctx.route("**/auth/totp", r => r.fulfill({ status: 405 }));
      await p.page.goto(fx.base + "/settings/access"); await p.page.waitForSelector("#outsideCard");
      const mine = await p.page.evaluate(async () => (await (await fetch("/ui/outside")).json()).signinName);
      await p.page.evaluate(({ name, w }) => {
        const row = document.createElement("div"); row.className = "s-row"; row.id = "s118SigninName";
        const copy = document.createElement("div"), label = document.createElement("strong"), hint = document.createElement("p"), value = document.createElement("code");
        label.textContent = w.ownName; hint.className = "note"; hint.textContent = w.ownHint; value.textContent = name;
        copy.append(label, hint); row.append(copy, value); document.getElementById("outSetUpOn").after(row);
      }, { name: mine, w: words[lang] });
      await p.page.locator("#outsideCard").scrollIntoViewIfNeeded();
      await record(p.page, `${screen}-${lang}-settings-name.png`, "settings");
    } finally { await p.ctx.close(); }
  }
  const digest = async name => createHash("sha256").update(await readFile(join(out, name))).digest("hex");
  await writeFile(join(out, "SHA256SUMS"), (await Promise.all(captures.map(async c => `${await digest(c.file)}  ${c.file}\n`))).join(""));
  await writeFile(join(out, "receipt.json"), JSON.stringify({ base: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), contract: "#3548 d5e2a3c873da04a72de4def25c2e53db2889a381", settingsBuildVersion, browser: version, scope: "Design-only DOM projections in actual signin.html and dashboard Settings shell; no production source or authenticator POST. Settings own-name read is synthetic. No core/SKEW/live-auth acceptance.", captures }, null, 2) + "\n");
  console.log(JSON.stringify({ captures: captures.length, out, browser: version }));
} finally {
  await browser?.close(); await fx?.close(); await new Promise(r => server.close(r));
}

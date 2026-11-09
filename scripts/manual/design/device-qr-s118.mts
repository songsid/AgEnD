// Visual proposal only: real Settings/sign-in shells and shared Dialog; no device-auth implementation.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix } from "../smoke-fixture/index.mts";
const out = process.env.OUT!;
if (!out || !process.env.QR_ENCODER) throw Error("OUT and QR_ENCODER required");
mkdirSync(out, { recursive: true });
const { default: qrFactory } = await import(process.env.QR_ENCODER);
const qr = qrFactory(0, "M");
qr.addData("https://agend.team.example/signin#add-device=DESIGN-ONLY-NOT-A-LOGIN"); qr.make();
const n = qr.getModuleCount(), size = n + 8;
let d = "";
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="white"/><path d="${d}" fill="black"/></svg>`;
const css = `
.s118-head { display:flex; align-items:center; justify-content:space-between; gap:var(--s-3); flex-wrap:wrap; }
.s118-head h3 { margin:0; }
.s118-list { list-style:none; padding:0; margin:var(--s-4) 0 0; }
.s118-list li { display:flex; align-items:center; gap:var(--s-3); padding:var(--s-3) 0; }
.s118-list li+li { border-top:1px solid var(--border); }
.s118-list .grow { flex:1; min-width:0; }
.s118-list strong,.s118-list .note { display:block; }
.s118-qr { display:block; width:208px; height:208px; margin:var(--s-3) auto; border-radius:var(--r-sm); }
.s118-host { text-align:center; overflow-wrap:anywhere; }
.s118-device { display:flex; align-items:center; gap:var(--s-3); padding:var(--s-4); background:var(--surface); border-radius:var(--r-md); }
.s118-device strong { display:block; }
.s118-code { font-family:var(--font-mono); letter-spacing:.16em; }
.s118-phone-state { display:flex; flex-direction:column; gap:var(--s-3); }
.s118-phone-state h1,.s118-phone-state p { margin:0; }
.s118-phone-state .s118-device { background:var(--bg); }
.s118-phone-state button { margin-top:var(--s-3); }
@media(max-width:899px) { .s-access-devices .btn { min-height:var(--tap); min-width:var(--tap); } }
`;
const fx = await bootFixture({ port: Number(process.env.PORT || 49610), instances: 3, classic: false });
async function prep(page: any) {
  await page.evaluate("globalThis.__name = fn => fn"); // tsx function-name helper for the visual-only evaluation callbacks
  await page.route("**/__s118/qr.svg", (r: any) => r.fulfill({ contentType: "image/svg+xml", body: svg }));
  await page.route("**/__s118/proposal.css", (r: any) => r.fulfill({ contentType: "text/css", body: css }));
  await page.evaluate(() => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/__s118/proposal.css"; document.head.appendChild(l); });
}
async function devices(page: any, phone = false) {
  await page.evaluate(async (phone: boolean) => {
    const { html, render } = await import("/assets/app-html.js");
    const { Icon } = await import("/assets/ui-icons.js");
    const col = document.querySelector(".p-settings .panel-body > .col")!;
    const root = document.createElement("div"); root.id = "s118-proposal"; const back = col.querySelector(":scope > .s-back"); if (back) back.after(root); else col.prepend(root);
    render(html`<section class="card s-access-devices" id="access-devices">
      <div class="s118-head"><h3>登入與新增裝置</h3>${!phone ? html`<button type="button" class="btn btn-sm btn-primary">＋新增裝置</button>` : null}</div>
      <p class="note" role=${phone ? "status" : undefined}>${phone ? "這支手機已登入。你可以登出這支手機；其他裝置需由擁有者管理。" : "查看已登入的裝置，或讓另一支手機登入。"}</p>
      <ul class="s118-list">
        <li><${Icon} name=${phone ? "globe" : "monitor"} size=${20}/><span class="grow"><strong>${phone ? "iPhone · Safari（這支手機）" : "Chrome · Linux（這台電腦）"}</strong><span class="note">目前使用中</span></span>${phone ? html`<button type="button" class="btn btn-sm">登出</button>` : html`<span class="tag ok">已登入</span>`}</li>
        <li><${Icon} name="globe" size=${20}/><span class="grow"><strong>${phone ? "Chrome · Linux（擁有者）" : "Pixel 8 · Chrome"}</strong><span class="note">最後使用：${phone ? "剛剛" : "3 小時前"}</span></span>${!phone ? html`<button type="button" class="btn btn-sm">登出</button>` : null}</li>
      </ul></section>`, root);
  }, phone);
}
async function dialog(page: any, phase: string) {
  await page.evaluate(async (phase: string) => {
    const { html, render } = await import("/assets/app-html.js");
    const { Dialog } = await import("/assets/ui-dialog.js");
    const { Icon } = await import("/assets/ui-icons.js");
    const { ErrorState } = await import("/assets/ui-states.js");
    document.getElementById("s118-dialog")?.remove();
    const root = document.createElement("div"); root.id = "s118-dialog"; document.body.appendChild(root);
    const close = () => render(null, root);
    let body: any, actions: any, title = "新增裝置";
    if (phase === "qr") {
      body = html`<p>用手機相機掃描，再回到這台電腦允許手機登入。</p><img class="s118-qr" src="/__s118/qr.svg" alt="新增裝置 QR 圖碼"/>
        <div class="s118-host"><strong>agend.team.example</strong><p class="note">使用已設定的私有網路入口</p></div>
        <p class="note" role="status">此登入請求 5 分鐘後失效，只能使用一次。掃描後仍需你允許。</p>
        <details><summary>無法掃描？使用裝置登入碼</summary><p class="note">在手機登入頁取得 8 位裝置登入碼，再在這台電腦輸入。</p></details>`;
      actions = html`<button class="btn" type="button" onClick=${close}>取消</button>`;
    } else if (phase === "approve") {
      title = "允許這支手機登入";
      body = html`<p>只有你剛才掃描的手機需要登入時，才選擇允許。</p>
        <div class="s118-device"><${Icon} name="globe" size=${24}/><div><strong>iPhone · Safari</strong><span class="note">剛剛提出請求 · 私有網路</span></div></div>
        <p class="note">手機會取得獨立的登入狀態，不會取得這台電腦的身分確認或驗證器。</p>
        <p class="note" role="status">請在 4 分 32 秒內決定。</p>`;
      actions = html`<button type="button" class="btn" onClick=${close}>拒絕</button><button type="button" class="btn btn-primary">允許這支手機登入</button>`;
    } else if (phase === "expired") {
      title = "登入請求已逾期";
      body = html`<${ErrorState} message="這次新增裝置已逾期，手機尚未登入。"/><p class="note">重新產生 QR 圖碼後，請再用手機掃描一次。</p>`;
      actions = html`<button type="button" class="btn" onClick=${close}>關閉</button><button type="button" class="btn btn-primary">重新產生 QR 圖碼</button>`;
    } else if (phase === "unreachable") {
      title = "先設定手機能開啟的入口";
      body = html`<p>目前的網址只能在這台電腦開啟，手機無法連線。</p><p class="note">請先在「外部存取入口」設定可用的網址。這裡不會自動開啟公開連結。</p>`;
      actions = html`<button type="button" class="btn" onClick=${close}>取消</button><button type="button" class="btn btn-primary">設定外部存取入口</button>`;
    } else {
      title = "輸入裝置登入碼";
      body = html`<p>在手機的登入頁選擇「使用裝置登入碼」，再把手機顯示的 8 位登入碼輸入這裡。</p><div class="field"><label for="s118-code">裝置登入碼</label><input id="s118-code" class="s118-code" value="ABCD-EFGH"/></div><p class="note">接著會顯示手機資料，讓你決定是否允許登入。</p>`;
      actions = html`<button type="button" class="btn" onClick=${close}>取消</button><button type="button" class="btn btn-primary">查看裝置</button>`;
    }
    render(html`<${Dialog} title=${title} onClose=${close} actions=${actions}>${body}</${Dialog}>`, root);
  }, phase);
  await page.waitForSelector("dialog[open]");
}
async function shot(page: any, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.waitForTimeout(150);
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw Error("overflow " + name);
  await page.screenshot({ path: join(out, name + ".png") });
}
try {
  const desk = (await fx.page(matrix("desk-light-zh-TW")[0]!, { path: "/settings/access" }));
  await desk.page.waitForSelector(".p-settings .panel-body > .col .card"); await prep(desk.page); await devices(desk.page);
  await shot(desk.page, "01-desktop-overview.zh-TW");
  for (const [phase, name] of [["qr", "02-desktop-qr"], ["approve", "03-desktop-allow"], ["expired", "06-desktop-expired"], ["unreachable", "07-desktop-no-entry"], ["code", "08-desktop-code-fallback"]]) {
    await dialog(desk.page, phase!); await shot(desk.page, name + ".zh-TW"); await desk.page.locator(".dlg-x").click();
  }
  await desk.ctx.close();
  const dark = await fx.page(matrix("desk-dark-zh-TW")[0]!, { path: "/settings/access" });
  await dark.page.waitForSelector(".p-settings .panel-body > .col .card"); await prep(dark.page); await devices(dark.page); await dialog(dark.page, "qr");
  await shot(dark.page, "09-desktop-dark-qr.zh-TW"); await dark.ctx.close();
  for (const theme of ["dark", "light"]) {
    const phone = await fx.browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: theme, locale: "zh-TW", isMobile: true, hasTouch: true });
    const p = await phone.newPage(); await p.goto(fx.base + "/signin"); await p.waitForSelector("#form:not([hidden])"); await prep(p);
    await p.evaluate((theme: string) => { document.documentElement.setAttribute("data-theme", theme); document.getElementById("form")!.hidden = true;
      const root = document.createElement("section"); root.className = "s118-phone-state";
      const h = document.createElement("h1"); h.textContent = "等待電腦允許"; root.appendChild(h);
      const text = document.createElement("p"); text.textContent = "請回到剛才顯示 QR 圖碼的電腦，選擇「允許這支手機登入」。"; root.appendChild(text);
      const detail = document.createElement("div"); detail.className = "s118-device"; detail.textContent = "這支手機：iPhone · Safari"; root.appendChild(detail);
      const status = document.createElement("p"); status.textContent = "你尚未登入。這次請求將於 4 分 32 秒後失效。"; root.appendChild(status);
      const cancel = document.createElement("button"); cancel.className = "secondary"; cancel.textContent = "取消登入"; root.appendChild(cancel);
      document.querySelector("main")!.appendChild(root);
    }, theme);
    await shot(p, theme === "dark" ? "04-phone-waiting.zh-TW" : "10-phone-light-waiting.zh-TW"); await phone.close();
  }
  const done = await fx.page(matrix("phone-dark-zh-TW")[0]!, { path: "/settings/access" });
  await done.page.waitForSelector(".p-settings .panel-body > .col .card"); await prep(done.page); await devices(done.page, true);
  await shot(done.page, "05-phone-signed-in.zh-TW"); await done.ctx.close();
  writeFileSync(join(out, "scope.txt"), "Visual proposal only. Real main Settings/sign-in/Preact/Dialog shell; device states are mocked. No QR auth implemented or exercised. Sample QR contains DESIGN-ONLY, no credential.\n");
} finally { await fx.close(); }

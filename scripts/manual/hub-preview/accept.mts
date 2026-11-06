/** E server acceptance: actual sealed HTTPS Hub/D storage + unchanged fleet preview.js. Panel UI is a separate PR. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { hubPreviewRig } from "../../../tests/helpers/hub-preview-rig.js";

const out = resolve(process.env.OUT ?? "docs/screenshots/hub-preview-server"), oldRef = process.env.OLD_REF ?? "c69e304e07d84b9fe591b848f61916f35bae932f";
mkdirSync(out, { recursive: true });
const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core");
const r = await hubPreviewRig();
let canaryRequests = 0;
const canary = createServer({ cert: readFileSync(r.certs.cert), key: readFileSync(r.certs.key) }, (_req, res) => { canaryRequests++; res.writeHead(200); res.end("canary"); });
await new Promise<void>(done => canary.listen(0, "127.0.0.1", done));
const external = `https://hub.example.test:${(canary.address() as { port: number }).port}`;
const html = `<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;padding:20px;background:#f4f7fb;color:#172033}h2{margin:0 0 12px}li{margin:8px 0}</style>
<h2>Isolated HTML / 隔離的 HTML</h2><p>This content is fetched through the room's file authorization. 此內容經由房間的檔案權限讀取。</p>
<script>
(async function(){
  const result={};const test=(name,fn)=>{try{fn();result[name]="unexpectedly allowed";}catch(e){result[name]=e.name;}};
  test("ownCookie",()=>document.cookie);test("parentCookie",()=>parent.document.cookie);
  test("ownStorage",()=>localStorage.getItem("hub-preview-secret"));test("parentStorage",()=>parent.localStorage.getItem("hub-preview-secret"));
  result.webrtc=typeof RTCPeerConnection;
  const blocked=[];addEventListener("securitypolicyviolation",e=>blocked.push(e.effectiveDirective));
  const fetches=[${JSON.stringify(r.webOrigin + "/hub/v1/session?previewProbe=1")},${JSON.stringify(external + "/fetch")}].map(async url=>{try{await fetch(url,{credentials:"include"});return "unexpectedly allowed";}catch(e){return e.name;}});
  const image=new Image();image.hidden=true;image.src=${JSON.stringify(external + "/image")};document.body.append(image);
  const nested=document.createElement("iframe");nested.hidden=true;nested.src=${JSON.stringify(external + "/nested")};document.body.append(nested);
  result.fetches=await Promise.all(fetches);await new Promise(done=>setTimeout(done,150));result.blocked=blocked;
  parent.postMessage({type:"hub-preview-proof",result},"*");
})();</script>`;
const world = await r.htmlWorld(html);
const browser = await pw.chromium.launch({ args: ["--no-sandbox", "--no-proxy-server", "--host-resolver-rules=MAP hub.example.test 127.0.0.1"] });
const results: unknown[] = [];
try {
  for (const [device, viewport] of Object.entries({ desktop: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } })) {
    for (const lang of ["en", "zh-TW"]) {
      const skew = device === "phone" && lang === "zh-TW";
      const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, colorScheme: device === "phone" ? "dark" : "light" });
      // tsx preserves function names with this helper inside Playwright-serialized callbacks.
      await context.addInitScript({ content: "globalThis.__name = (fn) => fn;" });
      await context.addCookies([{ name: world.asker.cookie.split("=")[0], value: world.asker.cookie.split("=")[1], url: r.webOrigin, secure: true, httpOnly: true, sameSite: "Strict" }]);
      await context.addInitScript(({ lang }) => {
        if (window !== window.top) return;
        localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("hub-preview-secret", "parent-only");
      }, { lang });
      // A cached shell's public modules with the new Hub-only page/data; no named imports into cached code.
      if (skew) await context.route("**/assets/*.js", async route => {
        const name = new URL(route.request().url()).pathname.split("/").pop();
        let source: string;
        try { source = execFileSync("git", ["show", `${oldRef}:src/ui/shared/${name}`], { encoding: "utf8", maxBuffer: 8 << 20 }); }
        catch { return route.continue(); }
        return route.fulfill({ contentType: "text/javascript", body: source });
      });
      const page = await context.newPage(), errors: string[] = [], foreign: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      page.on("request", (q: any) => { const u = new URL(q.url()); if (![r.webOrigin, r.previewOrigin, external].includes(u.origin)) foreign.push(q.url()); });
      await page.goto(r.webOrigin + "/ui/hub"); await page.waitForTimeout(1000);
      await page.evaluate(async ({ lang, url }) => {
        await import("/assets/preview.js"); await import("/assets/chat-strings.js");
        const words = await import("/assets/app-i18n.js"); words.setLang(lang, { store: false }); document.documentElement.lang = lang;
        const pv = (window as any).AgendPreview; pv.init(document.body.dataset, { text: (key, ...args) => words.t(`chat.${key}`, ...args) }); pv.setOptIn(false);
        document.querySelector("#app")?.remove();
        const host = document.createElement("main"); host.className = "panel p-settings";
        host.innerHTML = `<header class="card"><h2>${lang === "zh-TW" ? "Hub 預覽伺服器驗收" : "Hub preview server acceptance"}</h2></header><div class="panel-body hub-body"><section class="card"><h2>${lang === "zh-TW" ? "隔離預覽" : "Isolated preview"}</h2><p class="note">${lang === "zh-TW" ? "伺服器驗收頁；側欄介面由後續 PR 提供。" : "Server acceptance fixture; the panel UI follows separately."}</p><p id="proof-state" role="status">${lang === "zh-TW" ? "預覽尚未開始" : "Preview has not started"}</p><div id="proof-holder" class="preview-holder"></div><pre id="proof-report"></pre></section></div>`;
        document.body.append(host);
        (window as any).proofHtml = await (await fetch(url)).text();
        (window as any).proofStates = [];
        addEventListener("message", e => {
          const frame = pv.liveFrame("proof");
          if (e.source !== frame?.contentWindow || e.origin !== "null" || e.data?.type !== "hub-preview-proof") return;
          (window as any).proofResult = e.data.result; (window as any).proofOrigin = e.origin;
          document.querySelector("#proof-report")!.textContent = JSON.stringify(e.data.result, null, 2);
        });
      }, { lang, url: world.file.url });
      const prefix = `${device}-${lang}`;
      await page.screenshot({ path: join(out, `${prefix}-before.png`), fullPage: true });
      // A genuine ready from the real shim is refused when the parent's boot differs.
      await page.evaluate(() => {
        const pv = (window as any).AgendPreview, holder = document.createElement("div"); holder.hidden = true; document.body.append(holder);
        pv.setOptIn(true); pv.init({ ...document.body.dataset, previewBoot: "0".repeat(32) });
        pv.start("wrong-boot", holder, "<p>must not render</p>", { state: state => { (window as any).badBootState = state; } });
      });
      await page.waitForFunction(() => (window as any).badBootState === "unavailable");
      assert.equal(await page.evaluate(() => (window as any).AgendPreview.running("wrong-boot")), false);
      await page.evaluate(() => {
        const pv = (window as any).AgendPreview; pv.init(document.body.dataset); pv.setOptIn(true);
        const holder = document.querySelector("#proof-holder") as HTMLElement;
        holder.style.height = "300px"; holder.style.flex = "none";
        pv.start("proof", document.querySelector("#proof-holder"), (window as any).proofHtml, { state: (state, reason) => {
          (window as any).proofStates.push(state); document.querySelector("#proof-state")!.textContent = (document.documentElement.lang === "zh-TW" ? ({ running: "隔離預覽執行中", starting: "正在啟動預覽" }[state] ?? state) : state) + (reason ? ": " + reason : "");
        } }, { fill: true });
      });
      await page.waitForFunction(() => !!(window as any).proofResult, null, { timeout: 15_000 });
      const proof = await page.evaluate(() => ({ result: (window as any).proofResult, origin: (window as any).proofOrigin,
        states: (window as any).proofStates, frame: { sandbox: document.querySelector("#proof-holder iframe")!.getAttribute("sandbox"),
          allow: document.querySelector("#proof-holder iframe")!.getAttribute("allow"), referrer: document.querySelector("#proof-holder iframe")!.getAttribute("referrerpolicy"),
          src: document.querySelector("#proof-holder iframe")!.getAttribute("src") } }));
      assert.equal(proof.origin, "null");
      for (const key of ["ownCookie", "parentCookie", "ownStorage", "parentStorage"]) assert.equal(proof.result[key], "SecurityError");
      assert.deepEqual(proof.result.fetches, ["TypeError", "TypeError"]); assert.equal(proof.result.webrtc, "undefined");
      assert(proof.result.blocked.includes("connect-src")); assert.equal(proof.frame.sandbox, "allow-scripts"); assert.equal(proof.frame.allow, "");
      assert.equal(proof.frame.referrer, "no-referrer"); assert.equal(proof.frame.src, r.previewOrigin + "/frame"); assert(proof.states.includes("running"));
      assert.equal(canaryRequests, 0); assert.equal(r.webRequests.filter(path => path.includes("previewProbe=1")).length, 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: join(out, `${prefix}-after.png`), fullPage: true });
      // Repeated ready cannot make the parent post HTML again; a second render cannot replace the loaded document.
      const child = page.frames().find((f: any) => f.url() === r.previewOrigin + "/frame"); assert(child);
      await child.evaluate(() => parent.postMessage({ v: 1, type: "error", ch: "0".repeat(32), kind: "error", message: "wrong channel", line: 1, col: 1 }, "*"));
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => (window as any).AgendPreview.errors("proof")), null);
      await page.evaluate(() => {
        const pv = (window as any).AgendPreview, frame = pv.liveFrame("proof");
        pv.onMessage({ source: frame.contentWindow, origin: "null", data: { v: 1, type: "ready", ch: null, boot: document.body.dataset.previewBoot } });
        frame.contentWindow.postMessage({ v: 1, type: "render", ch: "b".repeat(32), html: "<h1>SECOND RENDER</h1>" }, "*");
      });
      await page.waitForTimeout(100); assert(!(await child.locator("body").innerText()).includes("SECOND RENDER"));
      // An untracked real shim receives no HTML automatically. Bad channel and sibling posts cannot render it.
      await page.evaluate(() => {
        const f = document.createElement("iframe"); f.id = "shim-probe"; f.hidden = true;
        f.setAttribute("sandbox", "allow-scripts"); f.setAttribute("allow", ""); f.referrerPolicy = "no-referrer";
        addEventListener("message", e => { if (e.source === f.contentWindow && e.origin === "null" && e.data?.type === "ready") (window as any).shimReady = e.data; });
        f.src = document.body.dataset.previewOrigin + "/frame"; document.body.append(f);
      });
      await page.waitForFunction(() => !!(window as any).shimReady);
      assert.equal(await page.evaluate(() => (window as any).shimReady.boot === document.body.dataset.previewBoot), true);
      const shimProbe = await (await page.locator("#shim-probe").elementHandle()).contentFrame(); assert(shimProbe);
      await page.evaluate(() => (document.querySelector("#shim-probe") as HTMLIFrameElement).contentWindow!.postMessage({ v: 1, type: "render", ch: "bad", html: "<h1>BAD CHANNEL</h1>" }, "*"));
      await child.evaluate(() => parent.frames[parent.frames.length - 1].postMessage({ v: 1, type: "render", ch: "c".repeat(32), html: "<h1>WRONG SOURCE</h1>" }, "*"));
      await page.waitForTimeout(100); assert.equal(await shimProbe.locator("h1").count(), 0);
      await page.evaluate(() => (document.querySelector("#shim-probe") as HTMLIFrameElement).contentWindow!.postMessage({ v: 1, type: "render", ch: "c".repeat(32), html: "<h1>SINGLE VALID PARENT POST</h1>" }, "*"));
      await shimProbe.locator("h1").waitFor({ state: "attached" }); assert.equal(await shimProbe.locator("h1").innerText(), "SINGLE VALID PARENT POST");
      await page.evaluate(() => (document.querySelector("#shim-probe") as HTMLIFrameElement).contentWindow!.postMessage({ v: 1, type: "render", ch: "c".repeat(32), html: "<h1>REPLAY</h1>" }, "*"));
      await page.waitForTimeout(100); assert.equal(await shimProbe.locator("h1").innerText(), "SINGLE VALID PARENT POST");
      await child.evaluate(url => { location.href = url; }, external + "/navigate");
      await page.waitForTimeout(200); assert.equal(canaryRequests, 0); assert(!child.url().startsWith(external));
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
      results.push({ device, lang, skew, ...proof, noExternalRequests: canaryRequests === 0,
        handshake: { badBootRefused: true, wrongChannelRefused: true, siblingRenderRefused: true, singleParentRender: true } });
      await context.close();
    }
  }
  assert.equal(results.length, 4);
  // A separate signed-in person and a revoked room cannot supply HTML to the shim.
  assert.equal((await r.call(world.other, "GET", world.file.url)).status, 404);
  assert.equal((await r.call(world.owner, "DELETE", `/hub/v1/grants/${world.grant.id}?revision=${world.grant.revision}`)).status, 200);
  assert.equal((await r.call(world.asker, "GET", world.file.url)).status, 403);
  mkdirSync(".artifacts/hub-preview-browser", { recursive: true });
  writeFileSync(".artifacts/hub-preview-browser/results.json", JSON.stringify({ oldRef, results }, null, 2) + "\n");
  console.log(JSON.stringify({ cases: results.length, pngs: results.length * 2, out }));
} finally { await browser.close(); canary.closeAllConnections(); await new Promise<void>(done => canary.close(() => done())); await r.close(); }

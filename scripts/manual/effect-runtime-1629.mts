/** #1629 native shim controls. Scratch HTTP + browser only; never starts a fleet, tunnel, adapter or service.
 * PW_DIR=<private prefix> PLAYWRIGHT_BROWSERS_PATH=<private cache> npx tsx scripts/manual/effect-runtime-1629.mts
 * Diagnostic parent is a fixture, not the unimplemented product registry. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { createPreviewListener } from "../../src/web-preview.js";
import { effectTemplateProblem } from "../../src/web-effect-template.js";
// Run with PW_DIR pointing to a private Playwright prefix and PLAYWRIGHT_BROWSERS_PATH to its private browser cache.
const root = resolve(process.env.OUT_DIR || ".artifacts/effect-1629-browser");
mkdirSync(root, { recursive: true });
if (!process.env.PW_DIR)
  throw new Error("Set PW_DIR to an isolated Playwright installation");
const require = createRequire(
    join(resolve(process.env.PW_DIR), "package.json"),
  ),
  { chromium } = require("playwright");
const privateDir = mkdtempSync(join(root, "navigation-"));
mkdirSync(join(privateDir, "home"));
mkdirSync(join(privateDir, "tmp"));
let effect: any,
  browser: any,
  trap = 0;
const boot = "c".repeat(32),
  receipts: any[] = [];
const actions: Record<string, string> = {
  normal: "",
  noscript: "",
  location: "location.href='about:blank#effect-test';",
  meta: "const m=document.createElement('meta');m.httpEquiv='refresh';m.content='0;url=about:blank#effect-test';document.head.append(m);",
  form: "const f=document.createElement('form');f.action='about:blank';f.method='GET';document.body.append(f);f.submit();",
};
const parent = createServer((req, res) => {
  if (req.url?.startsWith("/trap")) {
    trap++;
    res.end();
    return;
  }
  const kind = new URL(req.url!, "http://fixture").searchParams.get("kind")!;
  const payload = `<script>window.ORDER=['head'];window.LIFE=[];window.THEME=null;window.RENDER_PORT=!!window.event?.ports?.length;window.CALLBACK_PORT=false;window.GETTER_CALLS=0;window.LATER=setTimeout.bind(window);agend.on('theme',e=>{THEME=e.mode;CALLBACK_PORT=window.event?.currentTarget instanceof MessagePort;});if(${JSON.stringify(kind)}==='normal'){const dataGetter=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data').get;Object.defineProperty(MessageEvent.prototype,'data',{configurable:true,get(){GETTER_CALLS++;return dataGetter.call(this);}});window.setTimeout=function(fn){fn();return 0;};}document.addEventListener('DOMContentLoaded',()=>LIFE.push('dom'));addEventListener('load',()=>LIFE.push('load'));<\/script><canvas></canvas><script>ORDER.push('body');agend.ready();agend.ready();LATER(async()=>{if(${JSON.stringify(kind)}==='normal'){const r={renderPortVisible:RENDER_PORT,callbackPortVisible:CALLBACK_PORT,dataGetterCalls:GETTER_CALLS};try{r.parentDom=parent.document.body.textContent;}catch(e){r.parentDom='blocked';}try{r.cookie=document.cookie;}catch(e){r.cookie='blocked';}try{r.storage=localStorage.length;}catch(e){r.storage='blocked';}r.frozen=Object.isFrozen(agend);r.keys=Object.keys(agend).sort().join(',');r.descriptor=!Object.getOwnPropertyDescriptor(window,'agend').writable&&!Object.getOwnPropertyDescriptor(window,'agend').configurable;try{await fetch('/trap');r.fetch='allowed';}catch(e){r.fetch='blocked';}r.theme=THEME;parent.postMessage({type:'TEST_ISOLATION',r},'*');}parent.postMessage({type:'TEST_LIFECYCLE',order:ORDER,life:LIFE},'*');${actions[kind] || ""}},100);<\/script>`;
  const template = kind === "noscript" ? `<body><noscript><canvas id="fallback"></canvas></noscript>${payload}` : payload;
  assert.equal(effectTemplateProblem(template), null);
  const html = JSON.stringify(template).replace(
    /</g,
    String.fromCharCode(92) + "u003c",
  );
  res.writeHead(200, {
    "Content-Type": "text/html",
    "Set-Cookie": "effect-test=dummy; SameSite=Lax",
  });
  res.end(`<!doctype html><body><script>
 window.R={loads:0,removed:false,ready:[],lifecycle:null,isolation:null};const f=document.createElement('iframe');f.sandbox='allow-scripts';let rendered=false,p;
 f.addEventListener('load',()=>{R.loads++;if(R.loads>=2){f.remove();if(p)p.close();R.removed=true;}});
 addEventListener('message',e=>{if(e.source!==f.contentWindow||e.origin!=='null')return;const d=e.data;if(d?.type==='TEST_ISOLATION'){R.isolation=d.r;return;}if(d?.type==='TEST_LIFECYCLE'){R.lifecycle={order:d.order,life:d.life};return;}if(rendered||!d||Object.keys(d).sort().join(',')!=='boot,ch,type,v'||d.v!==1||d.type!=='ready'||d.ch!==null||d.boot!==${JSON.stringify(boot)})return;rendered=true;const c=new MessageChannel();p=c.port1;p.onmessage=e=>{R.ready.push(e.data);p.postMessage({v:1,type:'theme',ts:1,mode:'dark'});};f.contentWindow.postMessage({v:1,type:'render',ch:'0123456789abcdef',html:${html}},'*',[c.port2]);});
 f.src='http://127.0.0.1:${effect.settings.port}/effect';document.body.append(f);</script>`);
});
const listen = async (s: any) => {
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  return s.address().port;
};
try {
  const port = await listen(parent);
  effect = createPreviewListener({
    settings: { enabled: true, port: 0, origin: null },
    healthPort: port,
    config: {},
    bootId: boot,
  });
  await listen(effect.server);
  browser = await chromium.launch({
    headless: true,
    env: {
      HOME: join(privateDir, "home"),
      TMPDIR: join(privateDir, "tmp"),
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
    },
  });
  for (const kind of Object.keys(actions)) {
    const ctx = await browser.newContext(),
      page = await ctx.newPage(),
      external: string[] = [],
      errors: string[] = [],
      consoleMessages: string[] = [];
    await page.route("**/*", async (r: any) => {
      const u = new URL(r.request().url());
      if (
        u.hostname === "127.0.0.1" &&
        [String(port), String(effect.settings.port)].includes(u.port)
      )
        return r.continue();
      external.push(u.origin + u.pathname);
      return r.abort();
    });
    page.on("pageerror", (e: any) => errors.push(e.message));
    page.on("console", (m: any) => consoleMessages.push(m.text()));
    await page.goto(`http://127.0.0.1:${port}/?kind=${kind}`);
    if (kind === "noscript") {
      const probe = '<noscript><iframe srcdoc="x"></iframe></noscript><script>agend.ready()</script>';
      assert.equal(await page.evaluate((s: string) => !!new DOMParser().parseFromString(s, "text/html").querySelector("iframe"), probe), true);
      assert.equal(effectTemplateProblem(probe), "unsupported_element");
      assert.equal(effectTemplateProblem('<iframe srcdoc="x"></iframe>'), "unsupported_element");
    }
    await page.waitForFunction(
      () => !!(window as any).R?.lifecycle,
      undefined,
      { timeout: 10000 },
    );
    if (kind === "normal")
      await page.waitForFunction(
        () => !!(window as any).R?.isolation,
        undefined,
        { timeout: 10000 },
      );
    if (kind === "location" || kind === "meta")
      await page.waitForFunction(() => (window as any).R.removed, undefined, {
        timeout: 10000,
      });
    else await page.waitForTimeout(250);
    const observed = await page.evaluate(() => (window as any).R);
    if (kind === "noscript") {
      const frame = page.frames().find((f: any) => f.url().endsWith("/effect"));
      assert.ok(frame);
      assert.equal(await frame.evaluate(() => !!document.querySelector("noscript #fallback")), true);
    }
    if (kind === "normal")
      assert.deepEqual(observed.isolation, {
        renderPortVisible: false,
        callbackPortVisible: false,
        dataGetterCalls: 0,
        parentDom: "blocked",
        cookie: "blocked",
        storage: "blocked",
        frozen: true,
        keys: "on,ready",
        descriptor: true,
        fetch: "blocked",
        theme: "dark",
      });
    assert.deepEqual(observed.ready, [{ type: "ready" }]);
    assert.deepEqual(observed.lifecycle, {
      order: ["head", "body"],
      life: ["dom", "load"],
    });
    assert.equal(
      observed.loads,
      kind === "location" || kind === "meta" ? 2 : 1,
    );
    assert.equal(observed.removed, kind === "location" || kind === "meta");
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    if (kind === "form")
      assert.ok(
        consoleMessages.some(
          (s) => s.includes("form submission") && s.includes("sandboxed"),
        ),
      );
    receipts.push({ kind, observed, external, errors, consoleMessages });
    await ctx.close();
  }
  assert.equal(trap, 0);
  writeFileSync(
    join(root, "receipt.json"),
    JSON.stringify(
      { browser: browser.version(), receipts, trap, pass: true },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "PASS effect isolation, one normal load, ordered classic scripts, lifecycle, ready-only output and navigation controls; scratch cleanup in finally.",
  );
} finally {
  if (browser) await browser.close();
  for (const s of [effect?.server, parent])
    if (s?.listening) {
      s.closeAllConnections();
      s.close();
      await once(s, "close");
    }
  rmSync(privateDir, { recursive: true, force: true });
}

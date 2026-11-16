// M-3238 (the user): Settings → AI accounts → Connect. (1) The device step: the provider's page was a small link and its code a
// bare line — now numbered steps: a big link button naming the page, with Copy link; the code large, with Copy; "come back
// here". (2) The end: the chat's status lines (`backticks`, two ✅ lines saying the same, "instance", 「已喚醒：無。已重啟：無」) —
// now one headline and one plain line on which agents were reloaded, by the names people see.
// The real app on the shared fixture (in-process FleetManager, scratch home, loopback only, fake agents); the sign-in
// endpoints answered by routes (the mock login: a Codex device sign-in for profile "jefflin" running, then ended with two
// agents reloaded; the account dialog's Codex card waiting on the provider's page and code). Headless. Cases: desk light en,
// desk dark zh-TW, phone light en, phone dark zh-TW. Pictured per case: 1-device (the older dialog), 2-done, 3-card (the
// account dialog's card). Run it on the base too (SMOKE_NAME=…-before): it FAILs there.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] scripts/manual/smoke/run.sh smoke-connect-dialogs-m3238.mts
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-connect-dialogs-m3238";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49000), instances: 4, classic: false });
const names = fx.instances.map((i: any) => i.name);
const URL_ = "https://auth.openai.com/codex/device", CODE = "K7Q2-9XMB";
const RUN = { id: "r".repeat(32), backend: "codex", profile: "jefflin", phase: "running", ok: null, startedOn: "Chrome on Linux", startedAt: 1, endedAt: null, mine: true,
  lines: [], hint: { url: URL_, code: CODE, linkable: true }, terminal: null, accessCode: null };
const DONE = { ...RUN, phase: "ended", ok: true, endedAt: 2, hint: null,
  lines: ["✅ codex 的 profile `jefflin` 帳號已連接。正在把受影響的 instance 帶回來，讓它們載入新憑證…", `✅ codex 的 profile \`jefflin\` 已就緒。已喚醒：無。已重啟（重新載入憑證）：${names[1]}, ${names[2]}。現在可以正常對話了。`],
  recovery: { woken: [], restarted: [names[1], names[2]], pending: [], failed: false }, cleanupFailed: false };
const CARD = { selected: ["codex"], pending: ["codex"], skipped: [], states: { codex: "invalid" }, ready: false, console: [],
  login: { backend: "codex", id: "c".repeat(32), revision: 2, phase: "authorization", url: URL_, code: CODE, canAct: false } };
let login: any = RUN;
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];

try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW")) {
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    const zh = c.lang === "zh-TW";
    const p = await freshPage(fx, c, { account: "operator", path: "/settings/agents", beforeNavigate: async (ctx: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f" });
      await ctx.route(/\/ui\/backend-login$/, (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ login, targets: [] }) }));
      await ctx.route(/\/ui\/browser-backend-signins(\?.*)?$/, (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CARD) }));
    } });
    const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const open = (dialog: "SignInDialog" | "BrowserSignInDialog", props: Record<string, unknown>) => page.evaluate(`Promise.all([import("/ui/js/backend-signin.js"), import("/assets/app-shell.js")])
      .then(function (m) { return m[0].refreshSignIn().then(function () { m[1].closeDialog(); m[1].showDialog(m[0].${dialog}, ${JSON.stringify(props)}); }); })`);
    const measure = () => page.evaluate(`(() => { var d = document.querySelector("dialog[open]") || document.querySelector(".dlg"); var b = function (e) { if (!e) return null; var r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height), w: Math.round(r.width) }; };
      var link = d && d.querySelector(".signin-open"), code = d && d.querySelector(".signin-code");
      return { steps: d ? [].map.call(d.querySelectorAll(".signin-steps > li"), function (li) { var s = li.querySelector("span"); return (s || li).textContent.trim(); }) : [],
        link: b(link), linkHref: link && link.getAttribute("href"), code: b(code), codeText: code && code.textContent, codePx: code ? parseFloat(getComputedStyle(code).fontSize) : 0,
        copies: d ? [].map.call(d.querySelectorAll(".signin-copy"), function (x) { return x.textContent.trim(); }) : [], text: d ? d.textContent : "",
        lines: !!(d && d.querySelector(".signin-lines")), numbered: !!(d && d.querySelector(".signin-steps > li")) && getComputedStyle(d.querySelector(".signin-steps > li")).listStyleType === "decimal", vw: innerWidth, wide: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`) as Promise<any>;
    try {
      need(await mounted(page, 30000), "the app mounted");
      // (1) the device step, the older dialog (a named Codex profile)
      login = RUN;
      await open("SignInDialog", { backend: "codex", profile: "jefflin", resume: true }); await page.waitForTimeout(700);
      const d = await measure();
      const want = zh ? ["開啟登入頁面", "在那個頁面輸入這組授權碼", "完成後回到這裡，這個畫面會自動更新。"] : ["Open the sign-in page", "Enter this code on that page", "Come back here when you're done. This page updates by itself."];
      need(JSON.stringify(d.steps) === JSON.stringify(want) && d.numbered, `device: numbered steps (${JSON.stringify({ steps: d.steps, numbered: d.numbered })})`);
      need(d.link && d.link.h >= 44 && d.link.l >= 0 && d.link.r <= d.vw && d.linkHref === URL_ && /auth\.openai\.com\/codex\/device/.test(d.text), `device: a big link button naming the page, on screen (${JSON.stringify({ link: d.link, href: d.linkHref })})`);
      need(d.codeText === CODE && d.codePx >= 20 && d.copies.length === 2, `device: the code large, and Copy for each (${JSON.stringify({ code: d.codeText, px: d.codePx, copies: d.copies })})`);
      need(!d.wide, "device: no sideways scroll");
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "1-device") });
      // (2) the end
      login = DONE;
      await open("SignInDialog", { backend: "codex", profile: "jefflin", resume: true }); await page.waitForTimeout(700);
      const e = await measure();
      const plain = !/`|instance|✅|已喚醒|已重啟/.test(e.text) && !e.lines;
      need(plain && (zh ? /Codex · 設定檔 jefflin 帳號已連接。/.test(e.text) && /已重新載入，改用這個帳號：/.test(e.text) : /Your Codex · profile jefflin account is connected\./.test(e.text) && /Reloaded to use it: /.test(e.text)),
        `done: one headline and one plain line, no status lines, backticks or jargon (${JSON.stringify(e.text.slice(0, 200))})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "2-done") });
      // (3) the account dialog's Codex card (the structured sign-in)
      await open("BrowserSignInDialog", { backend: "codex" }); await page.waitForTimeout(1500);
      const k = await measure();
      need(JSON.stringify(k.steps) === JSON.stringify(want) && k.numbered && k.link && k.link.h >= 44 && k.link.r <= k.vw && k.codeText === CODE && k.codePx >= 20 && k.copies.length === 2 && !k.wide,
        `card: the same steps, a big link, the code large, Copy for each (${JSON.stringify({ steps: k.steps, link: k.link, px: k.codePx, copies: k.copies })})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "3-card") });
      need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    } catch (err) {
      failed.push(`threw: ${String(err).slice(0, 300)}`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "error") }).catch(() => {});
    }
    results.push({ name: caseName(c), ok: failed.length === 0, failed });
    await p.ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);

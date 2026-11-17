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
// ui-gate: {"name": "Connect dialogs (device steps and the end)", "hp": 19669}
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
    const measure = () => page.evaluate(`(() => { var d = document.querySelector("dialog[open]") || document.querySelector(".dlg"); if (!d) return null;
      var b = function (e) { if (!e) return null; var r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) }; };
      var q = function (s) { return d.querySelector(s); }, li = d.querySelector(".signin-steps > li");
      var link = q("a.signin-open"), copyLink = q(".signin-linkrow .signin-copy"), box = q(".signin-code-box"), code = q(".signin-code-box .signin-code");
      return { steps: [].map.call(d.querySelectorAll(".signin-steps > li"), function (x) { var t = x.querySelector(".signin-step-title"); return t ? t.textContent.trim() : ""; }),
        circle: li ? getComputedStyle(li, "::before").width : null, link: b(link), linkText: link ? link.textContent.trim() : null, linkHref: link && link.getAttribute("href"),
        copyLink: b(copyLink), url: q(".signin-url") ? q(".signin-url").textContent : null, box: b(box), boxBorder: box ? getComputedStyle(box).borderTopWidth : null,
        code: code ? code.textContent : null, codePx: code ? parseFloat(getComputedStyle(code).fontSize) : 0, codeInBox: !!(box && q(".signin-code-box .signin-copy")),
        hint: q(".signin-back.s-info") ? q(".signin-back.s-info").textContent : null,
        footer: [].map.call(d.querySelectorAll(".dlg-actions button"), function (x) { return [x.className, x.textContent.trim()]; }),
        banner: !!q(".signin-done-banner"), headline: q(".signin-done-banner .signin-headline") ? q(".signin-done-banner .signin-headline").textContent : null,
        tags: [].map.call(d.querySelectorAll(".signin-recovery-box .tag"), function (x) { return x.textContent; }), h3: !!q(".signin-browser h3"),
        text: d.textContent, lines: !!q(".signin-lines"), vw: innerWidth, wide: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`) as Promise<any>;
    try {
      need(await mounted(page, 30000), "the app mounted");
      const want = zh ? ["前往官方網站完成授權", "在那個頁面輸入這組授權碼"] : ["Finish on the provider's official website", "Enter this code on that page"];
      const openLabel = zh ? "開啟登入頁面" : "Open sign-in page", cancelLabel = zh ? "取消連接" : "Cancel connecting", closeLabel = zh ? "關閉" : "Close";
      const steps = (x: any, where: string) => {
        need(x && JSON.stringify(x.steps) === JSON.stringify(want) && x.circle === "24px", `${where}: two steps with their number circles (${JSON.stringify(x && { steps: x.steps, circle: x.circle })})`);
        need(x && x.linkText === openLabel && x.linkHref === URL_ && x.link && x.copyLink && Math.abs(x.link.t - x.copyLink.t) <= 2 && x.copyLink.r <= x.vw, `${where}: 「${openLabel}」 beside Copy link, one row (${JSON.stringify(x && { link: x.link, copy: x.copyLink })})`);
        need(x && x.url === "auth.openai.com/codex/device", `${where}: the page's address a quiet note under them (${x && x.url})`);
        need(x && x.code === CODE && x.codeInBox && x.boxBorder === "1px" && x.codePx >= 17, `${where}: the code and its Copy in one bordered box (${JSON.stringify(x && { code: x.code, inBox: x.codeInBox, border: x.boxBorder, px: x.codePx })})`);
        need(x && x.hint && !x.wide, `${where}: the auto-update hint a quiet line; no sideways scroll`);
        need(x && JSON.stringify(x.footer.slice(0, 1)) === JSON.stringify([["btn danger", cancelLabel]]) && JSON.stringify(x.footer.at(-1)) === JSON.stringify(["btn", closeLabel]), `${where}: Cancel a quiet danger button on the footer's left, Close on its right (${JSON.stringify(x && x.footer)})`);
      };
      // (1) the device step, the older dialog (a named Codex profile)
      login = RUN;
      await open("SignInDialog", { backend: "codex", profile: "jefflin", resume: true }); await page.waitForTimeout(700);
      steps(await measure(), "device");
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "1-device") });
      // (2) the end
      login = DONE;
      await open("SignInDialog", { backend: "codex", profile: "jefflin", resume: true }); await page.waitForTimeout(700);
      const e = await measure();
      need(e && e.banner && e.headline === (zh ? "Codex · 設定檔 jefflin 帳號已連接。" : "Your Codex · profile jefflin account is connected.") && e.tags.length === 2
        && !/`|instance|✅|已喚醒|已重啟/.test(e.text) && !e.lines && JSON.stringify(e.footer) === JSON.stringify([["btn btn-primary", closeLabel]]),
        `done: a check banner with the headline, the reloaded agents as tags, Close (${JSON.stringify(e && { banner: e.banner, headline: e.headline, tags: e.tags, footer: e.footer })})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "2-done") });
      // (3) the account dialog's Codex card (the structured sign-in): the same as (1), no second heading or surface
      await open("BrowserSignInDialog", { backend: "codex" }); await page.waitForTimeout(1500);
      const k = await measure();
      steps(k, "card");
      need(k && !k.h3, "card: no second heading (the title names the CLI)");
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

// Hub PR A (issue #3226): the chat thread, renderer, time, composer + WorkBar core, the usage rail's frame and the
// Settings page head move to src/ui/shared/ (served under /assets/ by the fleet and the Hub listener), with re-export
// files at the old /ui/js/ paths. Nothing on the fleet's pages may change: this smoke records the DOM of the parts that
// moved (the chat thread with Markdown, a code block and a file; the composer with a draft and an attached file; the
// usage rail; the Settings page head) on the realistic fixture (never `fleet start`), desk light/en and phone dark/zh-TW,
// so a run on the base and a run on the branch can be compared byte for byte (DOM=…/dom-<label>.json), plus screenshots.
// SKEW (branch only, OLD_REF set): an old cached panel-chat.js / settings-layout.js / header-tools.js with this branch's
// shared modules (their old relative imports reach the re-export files), and the reverse.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> LABEL=base|branch [OLD_REF=songsid/release/2.3.5-alpha] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-hub-shared-a.mts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-hub-shared-a";
const REPO = process.env.REPO!, LABEL = process.env.LABEL ?? "branch", OLD_REF = process.env.OLD_REF ?? "";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48710), instances: 2 });
const fm = fx.fm as any;
const name = fx.instances.find((i: any) => !i.general)!.name;
const { publicAttachment } = await import(REPO + "/src/web-upload.ts");
const csv = join(fx.dir, "data.csv"); writeFileSync(csv, "a,b\n1,2\n");
const served = fm.webFiles.registerServed({ path: csv, instance: name, name: "data.csv", mime: "text/csv", kind: "document" });
const at = (h: number) => new Date(Date.UTC(2026, 10, 6, h, 0, 0)).toISOString();
fm.emitSseEvent("message", { instance: name, sender: "web-user", role: "user", text: "Can you summarise the release?", ts: at(1) });
fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", ts: at(2), attachments: [publicAttachment(served)],
  text: ["## Release", "", "- **Faster** start", "- Fewer restarts", "", "| Area | Status |", "| --- | --- |", "| Web | done |", "", "```js", "const answer = 42;", "```"].join("\n") });

const r: Record<string, unknown> = { browser: fx.browser.version(), label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const CASES = [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const;
// The DOM of what moved, as the user's browser has it (no timers' text: the clock is fixed above; per-run keys dropped).
const DOM = `(() => {
  const html = (s) => { const e = document.querySelector(s); return e ? e.outerHTML.replace(/ data-v="[^"]*"/g, "").replace(/ data-key="[^"]*"/g, "").replace(/ data-arg="[0-9a-f]{12}-\\d+"/g, ' data-arg="K"').replace(/\\b\\d+[dhm]( \\d+[hm])?\\b/g, "T").replace(/ title="[^"]*\\d{1,2}:\\d{2}:\\d{2}[^"]*"/g, ' title="TIME"').replace(/[0-9a-f]{32}/g, "ID") : null; };
  return { thread: html(".thread"), composer: html(".composer-box"), rail: html(".u-rail"), head: html(".s-page-head") };
})()`;
const dom: Record<string, unknown> = {};

async function chat(c: (typeof CASES)[number], tag: string, route?: (page: any) => Promise<void>) {
  const { ctx, page, csp } = await fx.page(c as any, { path: `/ui/chat/${encodeURIComponent(name)}`, storage: { agend_usage_rail: "1" } });
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  if (route) { await route(page); await page.reload(); }
  const ready = await page.waitForSelector(".thread .msg", { timeout: 15000 }).then(() => true, () => false);
  await page.fill("#msgIn", "A draft that stays");
  await page.setInputFiles('.composer input[type="file"]', { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.waitForTimeout(600);
  if (c.device === "desk") await page.waitForFunction(() => document.querySelector(".u-rail") && !document.querySelector(".u-rail .skeleton"), null, { timeout: 15000 }).catch(() => {});
  const d = await page.evaluate(DOM);
  await page.screenshot({ path: shotPath(SMOKE, `${LABEL}-${tag}`, "1-chat") });
  return { ctx, page, csp, errs, ready, d };
}

try {
  for (const c of CASES) {
    const tag = `${c.device}-${c.theme}-${c.lang}`;
    const o = await chat(c, tag);
    const send = await o.page.$("#sendBtn");
    const s = await fx.page(c as any, { path: "/settings/agents" });
    await s.page.waitForSelector(".s-page-head", { timeout: 15000 });
    const head = await s.page.evaluate(DOM);
    await s.page.screenshot({ path: shotPath(SMOKE, `${LABEL}-${tag}`, "2-settings") });
    dom[tag] = { thread: o.d.thread, composer: o.d.composer, rail: o.d.rail, head: head.head };
    check(tag, o.ready && !!o.d.thread && !!o.d.composer && !!send && (c.device === "phone" || !!o.d.rail) && !!head.head && o.errs.length === 0 && (await o.csp()).length === 0,
      { ready: o.ready, thread: !!o.d.thread, composer: !!o.d.composer, rail: !!o.d.rail, head: !!head.head, errs: o.errs });
    await o.ctx.close(); await s.ctx.close();
  }

  if (OLD_REF) {
    const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };
    const serveOld = (files: string[]) => async (page: any) => page.route((u: URL) => files.some((f) => u.pathname === `/ui/js/${f}` || u.pathname === `/assets/${f}`), (route: any) => {
      const path = new URL(route.request().url()).pathname, f = path.replace(/^\/(ui\/js|assets)\//, "");
      const body = path.startsWith("/assets/") ? old(`shared/${f}`) : old(f);
      return body === null ? route.continue() : route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body });
    });
    // A tab opened before the upgrade: its panel-chat.js (relative ./chat-thread.js etc.) with today's server.
    for (const [n, files] of [["old-panel-chat", ["panel-chat.js"]], ["old-shell-header-tools", ["header-tools.js", "side-panel.js"]], ["old-settings-layout", ["settings-layout.js"]]] as const) {
      const o = await chat(CASES[0], `skew-${n}`, serveOld([...files]));
      const sendOk = !!(await o.page.$("#sendBtn"));
      let headOk = true;
      if (n === "old-settings-layout") {
        const s = await fx.page(CASES[0] as any, { path: "/settings/agents" });
        await serveOld(["settings-layout.js"])(s.page); await s.page.reload();
        headOk = await s.page.waitForSelector(".s-page-head", { timeout: 15000 }).then(() => true, () => false);
        await s.ctx.close();
      }
      check(`skew-${n}`, o.ready && sendOk && headOk && o.errs.length === 0, { ready: o.ready, sendOk, headOk, errs: o.errs });
      await o.ctx.close();
    }
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  const out = shotPath(SMOKE, "dom", LABEL).replace(/\.png$/, ".json");
  writeFileSync(out, JSON.stringify(dom, null, 1)); r.dom = out;
  writeFileSync(shotPath(SMOKE, "result", LABEL).replace(/\.png$/, ".json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}

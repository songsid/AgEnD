/**
 * M-3645 real-app captures: where a toast stands in a Hub chat.
 * The real Hub listener (tests/helpers/hub-s3b-rig.ts) serves the workspace shell over HTTPS on loopback; every /hub/v1/*
 * call is answered by the rooms fixture (tests/support/hub-rooms-fixture.ts) — no fleet, CLI or account. In a one-to-one
 * chat (room-helper) and the weekly group room, the shared toast (/assets/ui-toast.js) is shown with the wording of #4412's
 * mute confirmation; then two confirmations in a row. Each toast is measured against the chat's head, the composer, Send
 * and every message row the thread shows (clipped to the thread's visible box).
 * "before" serves BASE_REF's app.css (route.fulfill; nothing on disk changes); "after" is this checkout.
 * Writes PNGs and receipt.json (sourceHead, baseRef, every check, every PNG's sha256) to OUT.
 *   PW_DIR=<playwright-core root> OUT=<dir> [BASE_REF=origin/release/2.3.5-alpha] npx tsx scripts/manual/hub-chat-toast-m3645/capture.mts
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { createHubRoomsFixture } from "../../../tests/support/hub-rooms-fixture.js";
import { provisionHubIdentity } from "../../../src/hub/tls.js";

const out = resolve(process.env.OUT ?? ".artifacts/hub-chat-toast-m3645"), base = process.env.BASE_REF ?? "origin/release/2.3.5-alpha";
mkdirSync(out, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-c", "gc.auto=0", ...a], { encoding: "utf8", maxBuffer: 16 << 20 });
const OLD_CSS = git("show", `${base}:src/ui/shared/app.css`);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const receipt: any = { sourceHead: git("rev-parse", "HEAD").trim(), baseRef: git("rev-parse", base).trim(), dirty: git("status", "--porcelain", "--", "src").trim().split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };

// The rooms fixture's roster, as obviously made-up sample names in these captures (the fixture itself is unchanged).
const NAMES: Record<string, Record<string, string>> = {
  en: { "王經理": "Sam Sample", "陳主任": "Alex Sample", "吳小安": "Casey Sample", "林小華": "Jordan Sample", "周小明": "Riley Sample" },
  "zh-TW": { "王經理": "範例主管", "陳主任": "範例同事", "吳小安": "範例組員", "林小華": "範例夥伴", "周小明": "範例訪客" },
};
const sampleNames = (text: string, lang: string) => Object.entries(NAMES[lang]!).reduce((t, [from, to]) => t.split(from).join(to), text);
// #4412's mute confirmation (hubDirectPosts.muted), with the chat's title; and the Hub's own pin confirmation.
const MUTED: Record<string, (n: string) => string> = { en: (n) => `${n}’s own messages are off.`, "zh-TW": (n) => `已關閉 ${n} 主動發來的訊息。` };
const PINNED: Record<string, string> = { en: "Pinned.", "zh-TW": "已釘選。" };

const port = 49600 + Math.floor(Math.random() * 90), origin = `https://127.0.0.1:${port}`;
const rig = await s3bRig({ webOrigin: origin });
const keys = mkdtempSync(join(out, ".keys-"));
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const tls = { key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) };
const web = createServer(tls, (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>((yes) => web.listen(port, "127.0.0.1", yes));

/** The toast and what it covers: the chat's head (it should stay inside), and the composer, Send or a message row (never). */
function measure() {
  const box = (el: Element | null) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  const clip = (a: any, c: any) => a && c && { l: Math.max(a.l, c.l), t: Math.max(a.t, c.t), r: Math.min(a.r, c.r), b: Math.min(a.b, c.b) };
  const hits = (a: any, c: any) => !!a && !!c && a.l < c.r && a.r > c.l && a.t < c.b && a.b > c.t;
  const shown = [...document.querySelectorAll(".toasts > .toast")].filter((x) => getComputedStyle(x).display !== "none");
  const head = box(document.querySelector(".hub-chat-main .hub-chat-head, .hub-chat-head"));
  let scroller = document.querySelector(".hub-chat-main .msg")?.parentElement ?? null;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  const view = box(scroller);
  const rows = [...document.querySelectorAll(".hub-chat-main .msg")].map((m) => clip(box(m), view)).filter((r: any) => r && r.b - r.t > 1 && r.r - r.l > 1);
  const composer = box(document.querySelector(".hub-room-composer")), send = box(document.querySelector(".hub-room-composer .btn-send"));
  const toasts = shown.map((x) => box(x)!);
  return {
    texts: shown.map((x) => x.textContent), toasts, head, view,
    inHead: toasts.every((t) => !!head && t.t >= head.t - 0.5 && t.b <= head.b + 0.5),
    onComposer: toasts.some((t) => hits(t, composer)), onSend: toasts.some((t) => hits(t, send)),
    onRows: toasts.flatMap((t) => rows.filter((r) => hits(t, r))).length, rows: rows.length,
    clickThrough: shown.every((x) => getComputedStyle(x).pointerEvents === "none"),
  };
}

const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core");
const browser = await pw.chromium.launch({ args: ["--no-sandbox", "--no-proxy-server"] });
try {
  for (const [device, lang, theme] of [["desk", "en", "light"], ["desk", "zh-TW", "dark"], ["phone", "en", "light"], ["phone", "zh-TW", "dark"]] as const) {
    for (const [room, when] of [["room-helper", "before"], ["room-helper", "after"], ["room-weekly", "before"], ["room-weekly", "after"]] as const) {
      const kind = room === "room-helper" ? "direct" : "group", tag = `${device}-${lang}-${theme}-${kind}-${when}`, errors: string[] = [];
      const fx = createHubRoomsFixture();
      const context = await browser.newContext({ viewport: device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 860 }, locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: theme,
        ignoreHTTPSErrors: true, hasTouch: device === "phone", isMobile: device === "phone", reducedMotion: "reduce" });
      await context.addInitScript({ content: "globalThis.__name = (fn) => fn;" });
      await context.addInitScript(({ lang, theme }) => {
        localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_theme", theme); localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1");
      }, { lang, theme });
      await context.route("**/hub/v1/**", async (q: any) => {
        const req = q.request(), u = new URL(req.url()), path = u.pathname + u.search;
        if (u.pathname.endsWith("/events")) return q.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "retry: 600000\n\n" });
        const raw = req.postData(), answer = fx.handle({ method: req.method(), path, headers: req.headers(), body: raw ? JSON.parse(raw) : undefined });
        return q.fulfill({ status: answer?.status ?? 200, contentType: "application/json", body: sampleNames(JSON.stringify(answer?.body ?? {}), lang) });
      });
      if (when === "before") await context.route("**/assets/app.css", (route: any) => route.fulfill({ contentType: "text/css; charset=utf-8", body: OLD_CSS }));
      const p = await context.newPage(); p.on("pageerror", (e: Error) => errors.push(e.message));
      const shot = async (name: string) => { const path = `m3645-${tag}-${name}.png`; await p.screenshot({ path: join(out, path) }); receipt.pictures.push({ path, sha256: sha(readFileSync(join(out, path))) }); };
      await p.goto(`${origin}/ui/hub?room=${room}`);
      await p.locator(".hub-chat-main .msg").first().waitFor({ timeout: 15000 });
      await p.locator(".hub-room-composer .btn-send").waitFor({ timeout: 15000 });
      await p.waitForTimeout(600);
      const title = (await p.locator(".hub-chat-head .hub-chat-title").first().innerText()).split("\n")[0]!.trim();
      const show = (text: string) => p.evaluate(async (text) => (await import("/assets/ui-toast.js")).toast(text), text);
      const clear = () => p.evaluate(() => document.querySelectorAll(".toasts > .toast").forEach((x: any) => x.click()));
      await show(MUTED[lang]!(title)); await p.waitForTimeout(300);
      const one = await p.evaluate(measure);
      if (when === "before") {
        // The bug as seen in #4412: on a desk the toast stood on Send (a group room's members list takes the corner instead),
        // on a phone on the thread's first rows.
        if (device === "phone" || kind === "direct") check(`${tag}: the toast covers Send or a message row (the bug)`, one.onSend || one.onRows > 0, one);
        receipt.before = { ...(receipt.before || {}), [tag]: { onSend: one.onSend, onRows: one.onRows, toast: one.toasts[0] } };
      } else {
        check(`${tag}: the toast stands in the chat's head`, one.inHead && one.toasts.length === 1, one);
        check(`${tag}: …never on the composer, Send or one of the ${one.rows} message rows shown`, !one.onComposer && !one.onSend && one.onRows === 0, one);
        check(`${tag}: …and lets clicks through to the head's buttons`, one.clickThrough, one);
      }
      await shot("1-toast");
      if (when === "after") {
        await clear(); await show(MUTED[lang]!(title)); await show(PINNED[lang]!); await p.waitForTimeout(300);
        const two = await p.evaluate(measure);
        check(`${tag}: two confirmations in a row: the newest stands in the head, the older gives way`, two.toasts.length === 1 && two.texts[0] === PINNED[lang] && two.inHead && two.onRows === 0, two);
        await shot("2-newest");
      }
      check(`${tag}: no page errors`, errors.length === 0, errors);
      await context.close();
    }
  }
} finally {
  await browser.close(); web.close(); await rig.close?.(); rmSync(keys, { recursive: true, force: true });
}
const failed = receipt.checks.filter((c: any) => !c.ok).length;
receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(`checks ${receipt.summary}`);
process.exit(failed ? 1 : 0);

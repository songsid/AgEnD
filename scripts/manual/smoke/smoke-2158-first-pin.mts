// #2158 from defaults (fleet decision a78ebdc5): a chat opened cold is at the bottom once it has settled. WebKit, on a
// cold load, shrank the thread under the first pin (168 px, as its text settled) and clamped the view up by as
// much; that clamp's scroll event came before the ResizeObserver and counted as the reader leaving the bottom, so the
// history filling in after it left the newest message 231 px down (seen on main: the first load of a case).
// A fresh profile with nothing seeded signs in through the visible /signin, then loads a chat of 200 messages (seedChat:
// zh-TW and English, long Markdown, code, tables, photos; demo names only), K times per case, each in a new context:
// - desk light (English);
// - phone dark (zh-TW, reduced motion, a LAN origin — Chromium; WebKit has no host-resolver rule, so 127.0.0.1);
// - the temporary public link (desk light, reduced motion; stubbed as the harness says: tunnel, cloudflared, owner
//   check, General notice, transport).
// Judged: every load is within 2 px of the bottom 2.5 s after the last message is drawn. Listed: the loads where the
// race happened (a clamp's scroll event off the bottom, on a shorter thread and view) — the path the fix is for.
// No page error. The only lines accepted are WebKit's own, under WebKit only, matched exactly on the text before
// " @ <url>": its sheet for each <select>, the viewport key it doesn't know, and (by position, inside the window of the
// smoke's own navigation from /ui to the chat) the stream and poll that navigation cancels, as #2053's smoke does.
//   PW_DIR=… REPO=… OUT=… [PW_ENGINE=webkit] [K=5] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2158-first-pin.mts
//   (WebKit: the in-Docker recipe in smoke-emoji-tofu.mts's header)
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, openPublicLink, seedChat, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2158-first-pin";
const N = Number(process.env.N ?? 200), K = Number(process.env.K ?? 5);
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
// (WebKit writes the URL as "http: /127.0.0.1:<port>/ui/…": a space after the scheme.)
const CANCEL = /^(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/ui\/(events|poll)(\?\S*)? due to access control checks\.$/;
const split = (errors: string[], nav: [number, number]) => {
  const accepted: string[] = [], other: string[] = [];
  errors.forEach((e, i) => {
    const text = e.replace(/ @ \S+$/, "");
    const own = ENGINE === "webkit" && (WEBKIT_OWN.has(text) || (i >= nav[0] && i < nav[1] && CANCEL.test(text)));
    (own ? accepted : other).push(e);
  });
  return { accepted, other };
};

const fx = await bootFixture({ port: Number(process.env.HP ?? 48570), classic: false });
const fm = fx.fm;
const CHAT = "observability-dashboards";
for (const name of Object.keys(fm.fleetConfig.instances)) if (name !== CHAT) delete fm.fleetConfig.instances[name];
await seedChat(fx, [CHAT], N);

// Every scroll event on the thread's scroller and every scrollTop the page writes: [kind, ms, top, height, client height].
const TRACE = `window.__ev = []; const t0 = performance.now();
  document.addEventListener("scroll", (e) => { const s = e.target; if (!s || !s.classList || !s.classList.contains("scroller")) return;
    window.__ev.push(["s", Math.round(performance.now() - t0), Math.round(s.scrollTop), s.scrollHeight, s.clientHeight]); }, true);
  const orig = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(Element.prototype, "scrollTop", { configurable: true, get() { return orig.get.call(this); },
    set(v) { if (this.classList && this.classList.contains("scroller")) window.__ev.push(["w", Math.round(performance.now() - t0), Math.round(v), this.scrollHeight, this.clientHeight]); orig.set.call(this, v); } });`;
/**
 * The race: a scroll event lower than the page's last write (clamped), on a thread shorter than at that write, that
 * leaves the view off the bottom (the view got shorter too before the event came). A clamp that lands at the bottom
 * happens on most cold loads and is harmless.
 */
const clamped = (ev: Array<[string, number, number, number, number]>) => ev.some((e, i) => {
  if (e[0] !== "s") return false;
  const w = ev.slice(0, i).reverse().find((x) => x[0] === "w");
  return !!w && e[3] < w[3] && e[2] < Math.min(w[2], w[3] - w[4]) && e[3] - e[2] - e[4] > 1;
});

const results: any[] = [];
async function runCase(name: string, open: () => Promise<FreshPage>) {
  const loads: any[] = [];
  let errors: string[] = [], accepted: string[] = [];
  for (let k = 0; k < K; k++) {
    const p = await open();
    await mounted(p.page, 30000);
    await p.ctx.addInitScript({ content: TRACE });
    const from = p.errors.length;
    await p.page.goto(`${p.base}/ui/chat/${CHAT}`);
    await mounted(p.page, 30000);
    await p.page.waitForFunction((n: number) => document.querySelectorAll(".p-chat .msg").length >= n, N, { timeout: 60000 });
    const nav: [number, number] = [from, p.errors.length];
    await p.page.waitForTimeout(2500);
    const r = await p.page.evaluate(`(() => { const s = document.querySelector(".p-chat .scroller");
      return { dist: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), ev: window.__ev }; })()`) as any;
    const load = { k, dist: r.dist, clamped: clamped(r.ev), ev: r.ev };
    loads.push(load);
    if (r.dist > 2 || k === 0) await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}-${k}`, r.dist > 2 ? "off" : "chat") });
    const s = split(p.errors, nav);
    errors = errors.concat(s.other); accepted = accepted.concat(s.accepted);
    await p.ctx.close();
  }
  const off = loads.filter((l) => l.dist > 2);
  const ok = !off.length && !errors.length;
  results.push({ name, ok, off: off.map((l) => `#${l.k}:${l.dist}px`), clamped: loads.filter((l) => l.clamped).map((l) => l.k), errors, accepted, loads });
  console.log(`${ok ? "ok  " : "FAIL"} ${ENGINE}-${name}: ${K - off.length}/${K} at the bottom${off.length ? ` (off: ${off.map((l) => `#${l.k} ${l.dist}px`).join(", ")})` : ""}; race on load ${loads.filter((l) => l.clamped).map((l) => `#${l.k}`).join(", ") || "none"}${errors.length ? ` ERRORS ${JSON.stringify(errors).slice(0, 400)}` : ""}`);
}
await runCase("desk-light-en", () => freshPage(fx, { device: "desk", theme: "light", lang: "en" }));
await runCase(ENGINE === "webkit" ? "phone-dark-zh-TW-reduced" : "phone-dark-zh-TW-lan-reduced",
  () => freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, ENGINE === "webkit" ? { reducedMotion: true } : { origin: "lan", reducedMotion: true }));
const link = await openPublicLink(fx);
await runCase("public-link-desk-light-en-reduced", () => link.publicPage({ device: "desk", theme: "light", lang: "en" }, { reducedMotion: true }));
await link.close();
writeFileSync(shotPath(SMOKE, `${ENGINE}-result`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(results, null, 1));
const accepted = [...new Set(results.flatMap((r) => r.accepted).map((e: string) => e.replace(/ @ \S+$/, "")))];
if (accepted.length) console.log(`WebKit's own lines, accepted:\n  ${accepted.join("\n  ")}`);
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : `PASS (${ENGINE})`);
await fx.close();
process.exit(bad.length ? 1 : 0);

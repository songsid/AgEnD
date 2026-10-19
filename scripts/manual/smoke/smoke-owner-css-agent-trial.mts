// #2198 from defaults (fleet decision a78ebdc5): custom CSS General saves for a person is kept even when their "keep it"
// takes longer than the 20 s keep window to come back through chat; a version saved on their own Settings page still
// goes back at 20 s. A fresh profile signed in through the visible /signin, nothing seeded.
//   agent  — General saves (set_web_settings custom_css save, the tool's own path) while the person has the dashboard
//            open: the page puts it in and, once its stylesheet loaded, reports it shown (POST /ui/owner-css/shown); the
//            bar asks; nobody answers on the page; at 20 s after it was shown it goes back (the dead-man switch); 40 s
//            after it was shown General keeps it (the chat round trip): it is in force again, no bar, on the page.
//   person — the person saves in Settings → Web appearance (the page's editor and Save): no answer, back at 20 s.
// No page error.
//   PW_DIR=… REPO=… OUT=… [PW_ENGINE=webkit] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-owner-css-agent-trial.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted } from "../smoke-fixture/index.mts";

const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
const CANCEL = /^(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/ui\/(events|poll)(\?\S*)? due to access control checks\.$/;
const other = (errors: string[]) => errors.filter((e) => { const t = e.replace(/ @ \S+$/, ""); return !(ENGINE === "webkit" && (WEBKIT_OWN.has(t) || CANCEL.test(t))); });

const fx = await bootFixture({ port: Number(process.env.HP ?? 48660), classic: false });
const fm = fx.fm;
const results: any = { engine: ENGINE, cases: {} };
let failed = false;
const verdict = (name: string, ok: boolean, d: any) => { results.cases[name] = { ok, ...d }; if (!ok) failed = true; console.log(`${ok ? "ok  " : "FAIL"} ${ENGINE} ${name}: ${JSON.stringify(d).slice(0, 500)}`); };
// A function predicate: a string one is compiled in the page, and the dashboard's CSP refuses eval.
const until = async (page: any, fn: (a: any) => boolean, arg: any, ms: number) => { try { await page.waitForFunction(fn, arg, { timeout: ms, polling: 100 }); return true; } catch { return false; } };
const linkOf = (page: any) => page.evaluate(() => (document.getElementById("owner-css") as HTMLLinkElement | null)?.getAttribute("href") ?? null);
const barShown = (page: any) => page.evaluate(() => !!document.querySelector(".oc-keep"));
const CSS_A = "body { outline: 6px solid #e91e63 }", CSS_B = "body { outline: 6px dashed #3f51b5 }";

// ── agent: General saves, the person sees it, "keep it" comes back 40 s later ──
{
  const p = await freshPage(fx, { device: "desk", theme: "light", lang: "en" } as any);
  const posts: Array<{ url: string; at: number }> = [];
  p.page.on("request", (r: any) => { if (r.method() === "POST" && /\/ui\/owner-css/.test(r.url())) posts.push({ url: new URL(r.url()).pathname, at: Date.now() }); });
  await p.page.goto(`${p.base}/ui/fleet`); await mounted(p.page, 60000); await p.page.waitForTimeout(800);
  const saved = fm.webSettings.change(p.personKey, { what: "custom_css", action: "save", text: CSS_A });
  const sha = fm.ownerCss.state(p.personKey).active;
  const t0 = Date.now();
  const linked = await until(p.page, (s: string) => (document.getElementById("owner-css") as HTMLLinkElement | null)?.getAttribute("href") === `/ui/owner-css.css?v=${s}`, sha, 15000);
  const shownPost = await until(p.page, () => true, null, 1).then(async () => { const end = Date.now() + 10000; while (Date.now() < end && !posts.some((x) => x.url === "/ui/owner-css/shown")) await p.page.waitForTimeout(100); return posts.find((x) => x.url === "/ui/owner-css/shown"); });
  const shownAt = shownPost?.at ?? null;
  const bar = await barShown(p.page);
  const hostAfterShown = fm.ownerCss.state(p.personKey).pending;
  // Nobody answers on the page. At 20 s after it was shown, it goes back (on the host, and the page follows).
  const backOnPage = await until(p.page, () => !document.getElementById("owner-css") && !document.querySelector(".oc-keep"), null, 30000);
  const backAt = Date.now();
  const hostBack = fm.ownerCss.state(p.personKey);
  // "Keep it", 40 s after it was on their screen (the chat round trip): General keeps.
  const wait = shownAt ? Math.max(0, shownAt + 40000 - Date.now()) : 0;
  await p.page.waitForTimeout(wait);
  const kept = fm.webSettings.change(p.personKey, { what: "custom_css", action: "keep", trial: saved.trial });
  const keptAt = Date.now();
  const relinked = await until(p.page, (s: string) => (document.getElementById("owner-css") as HTMLLinkElement | null)?.getAttribute("href") === `/ui/owner-css.css?v=${s}` && !document.querySelector(".oc-keep"), sha, 15000);
  const hostEnd = fm.ownerCss.state(p.personKey);
  const ok = saved.ok && !!sha && linked && !!shownAt && bar && hostAfterShown && !hostAfterShown.waiting && backOnPage
    && hostBack.active === null && kept.ok && kept.active === sha && relinked && hostEnd.active === sha && hostEnd.pending === null && other(p.errors).length === 0;
  verdict("agent", !!ok, { saved: saved.ok, note: String(saved.note ?? "").slice(0, 140), linkedMs: shownAt ? shownAt - t0 : null, bar, waitingAfterShown: hostAfterShown?.waiting ?? null,
    backAfterShownMs: shownAt ? backAt - shownAt : null, keepAfterShownMs: shownAt ? keptAt - shownAt : null, kept: { ok: kept.ok, restored: !!kept.note, error: kept.error },
    relinked, hostEnd: { active: hostEnd.active === sha, pending: hostEnd.pending }, posts: posts.map((x) => x.url), errors: other(p.errors) });
  await p.ctx.close();
}

// ── person: saved on their own Settings page, no answer: back at 20 s, as before ──
{
  const p = await freshPage(fx, { device: "desk", theme: "light", lang: "en" } as any);
  fm.webSettings.change(p.personKey, { what: "custom_css", action: "off" });
  await p.page.goto(`${p.base}/settings/appearance`); await mounted(p.page, 60000);
  const box = p.page.locator(".s-owner-css textarea.s-css-text");
  await box.waitFor({ timeout: 20000 });
  await box.fill(CSS_B);
  await p.page.locator(".s-owner-css .s-css-actions button.btn-primary").click();
  const t0 = Date.now();
  const bar = await until(p.page, () => !!document.querySelector(".oc-keep"), null, 10000);
  const pending = fm.ownerCss.state(p.personKey).pending;
  await p.page.waitForTimeout(Math.max(0, t0 + 21500 - Date.now()));
  const host = fm.ownerCss.state(p.personKey);
  const barGone = await until(p.page, () => !document.querySelector(".oc-keep"), null, 5000);
  verdict("person", bar && !!pending && !pending.waiting && host.active === null && host.pending === null && barGone && other(p.errors).length === 0,
    { bar, waiting: pending?.waiting ?? null, after21s: { active: host.active, pending: host.pending }, barGone, errors: other(p.errors) });
  await p.ctx.close();
}

writeFileSync(`${process.env.OUT ?? "."}/smoke-owner-css-agent-trial-${ENGINE}.json`, JSON.stringify(results, null, 1));
console.log(`${failed ? "FAIL" : "PASS"} (${process.env.OUT ?? "."}/smoke-owner-css-agent-trial-${ENGINE}.json)`);
await fx.browser.close();
process.exit(failed ? 1 : 0);

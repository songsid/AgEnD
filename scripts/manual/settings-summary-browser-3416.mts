/** Display-only production diff/store projections in the real authenticated app/Settings shell. No Settings writes. */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { bootFixture, matrix, caseName } from "./smoke-fixture/index.mts";
const repo = resolve(process.env.REPO!), out = resolve(process.env.OUT!), baseline = process.env.BASELINE_REF!;
if (!baseline) throw Error("BASELINE_REF is required");
mkdirSync(out, { recursive: true });
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
if (git("status", "--porcelain", "--untracked-files=no")) throw Error("capture requires a clean tracked tree");
const head = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
const inputs = ["src/settings-summary.ts", "src/settings-change.ts", "src/settings-confirmation.ts", "src/ui/shared/app-shell.js", "src/ui/settings-confirm.js", "src/ui/shared/app-i18n.js", "src/ui/shared/app.css", "src/ui/app.html", "scripts/manual/settings-summary-browser-3416.mts", "scripts/manual/smoke-fixture/index.mts"];
const sources = Object.fromEntries(inputs.map(p => [p, digest(readFileSync(join(repo, p)))]));
const fx = await bootFixture({ port: Number(process.env.HP ?? 54940), instances: 2, classic: false });
const { settingsChangeDiff } = await import(join(repo, "src/settings-change.ts"));
const { SettingsConfirmationStore } = await import(join(repo, "src/settings-confirmation.ts"));
const { setLocale } = await import(join(repo, "src/locale.ts"));
const stores: any[] = [], results: any[] = []; let effects = 0;
const keys = ["src/ui/shared/app-shell.js", "src/ui/settings-confirm.js", "src/ui/shared/app-i18n.js", "src/ui/shared/app.css"];
const baselineAssets = Object.fromEntries(keys.map(p => [p, execFileSync("git", ["show", `${baseline}:${p}`], { cwd: repo, encoding: "utf8" })]));
const oldPath: Record<string, string> = { "/assets/app-shell.js": keys[0], "/ui/js/settings-confirm.js": keys[1], "/assets/app-i18n.js": keys[2], "/assets/app.css": keys[3] };
try {
  const cases = [
    ...matrix("full").map(c => ({ ...c, variant: "after" })),
    ...matrix("desk-light-en,desk-light-zh-TW,phone-dark-en,phone-dark-zh-TW").map(c => ({ ...c, variant: "before" })),
    ...["old-shell", "old-server", "old-i18n", "old-confirm"].map(variant => ({ device: "phone" as const, theme: "light" as const, lang: "zh-TW" as const, variant })),
  ];
  for (const c of cases) {
    setLocale(c.lang === "en" ? "zh-TW" : "en");
    const instances = Object.fromEntries(["first", "second", "third"].map(n => [n, {}]));
    const diff = settingsChangeDiff({ defaults: { cross_instance_visibility: "hidden" }, instances, api_key: "dummy-old" },
      { defaults: { cross_instance_visibility: "full" }, instances, api_key: "dummy-next" }, { operation: "PATCH /api/settings/fleet" })!;
    const store = new SettingsConfirmationStore({ audit: () => {} }); stores.push(store);
    const view: any = store.propose({ session: "owned-display-fixture", key: caseName(c) + c.variant, fingerprint: diff.fingerprint,
      section: diff.section, requestedBy: "Fixture browser", source: "web_session", summary: diff.summary, summary_i18n: diff.summary_i18n, bytes: 1,
      current: () => true, unchanged: async () => true, apply: async () => { effects++; return {}; } }).view;
    const canonical = JSON.stringify({ summary: view.summary, fingerprint: diff.fingerprint });
    if (c.variant === "old-server") delete view.summary_i18n;
    const { ctx, page, csp } = await fx.page(c);
    const served: Record<string, string> = {}, substitutions: Record<string, string> = {};
    const responses: Promise<void>[] = [];
    page.on("response", (r: any) => { const path = new URL(r.url()).pathname; if (path.startsWith("/assets/") || path.startsWith("/ui/js/") || path === "/ui") responses.push((async () => { try { served[path] = digest(await r.body()); } catch {} })()); });
    const replace = c.variant === "before" ? Object.keys(oldPath) : c.variant === "old-shell" ? ["/assets/app-shell.js"] : c.variant === "old-i18n" ? ["/assets/app-i18n.js"] : c.variant === "old-confirm" ? ["/ui/js/settings-confirm.js"] : [];
    for (const path of replace) { const source = oldPath[path]; substitutions[path] = digest(baselineAssets[source]); await page.route(`**${path}`, (r: any) => r.fulfill({ status: 200, contentType: path.endsWith(".css") ? "text/css" : "text/javascript", body: baselineAssets[source] })); }
    await page.route(`**/api/settings/pending/${view.id}`, (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(view) }));
    await page.goto(fx.base + "/settings/access");
    await page.evaluate(async (v: any) => { const m: any = await import("/ui/js/settings-confirm.js" as string); m.track(v); }, view);
    await page.waitForSelector(".pending-stack.inline .pending-summary");
    await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))); });
    const text = await page.locator(".pending-summary").innerText();
    const translated = !["before", "old-shell", "old-server"].includes(c.variant);
    const expected = translated ? c.lang : c.lang === "en" ? "zh-TW" : "en";
    if (!text.includes(expected === "en" ? "fingerprint" : "指紋") || !text.includes(expected === "en" ? "inherit it" : "繼承此設定")) throw Error(`wrong summary language: ${caseName(c)} ${c.variant}: ${text}`);
    const state = await page.evaluate(async () => { const { appStore }: any = await import("/assets/app-store.js" as string); const v = appStore.get().pendingChanges[0]; return { summary: v.summary, count: appStore.get().pendingChanges.length }; });
    if (JSON.stringify(state.summary) !== JSON.stringify(view.summary) || state.count !== 1) throw Error("canonical summary changed");
    const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, tap: [...document.querySelectorAll(".pending-card button")].map(el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; }), sidebar: !!document.querySelector("#sidebar"), settings: !!document.querySelector(".pending-stack.inline") }));
    if (layout.overflow > 1 || !layout.sidebar || !layout.settings) throw Error("shell/layout gate failed: " + JSON.stringify(layout));
    const name = `${c.variant}-${caseName(c)}`; await page.screenshot({ path: join(out, name + ".png"), fullPage: true });
    let switchText: string | null = null;
    if (c.variant === "after" && c.device === "phone" && c.theme === "light") {
      await page.evaluate(async (language: string) => { const m: any = await import("/assets/app-i18n.js" as string); m.setLang(language, { store: false }); }, c.lang === "en" ? "zh-TW" : "en");
      await page.waitForFunction((word: string) => document.querySelector(".pending-summary")?.textContent?.includes(word), c.lang === "en" ? "指紋" : "fingerprint");
      switchText = await page.locator(".pending-summary").innerText();
      await page.screenshot({ path: join(out, name + "-switched.png"), fullPage: true });
    }
    if (canonical !== JSON.stringify({ summary: store.get(view.id, "owned-display-fixture")!.summary, fingerprint: diff.fingerprint })) throw Error("server record changed");
    const violations = await csp(); if (violations.length) throw Error("CSP: " + JSON.stringify(violations));
    await Promise.all(responses);
    results.push({ name, fleetLocale: c.lang === "en" ? "zh-TW" : "en", pageLanguage: c.lang, text, switchText, canonical, layout, substitutions,
      served: Object.entries(served).map(([path, digest]) => ({ digest, paths: [path] })), csp: violations });
    await ctx.close(); store.close();
  }
} finally { for (const s of stores) s.close(); await fx.close(); }
for (const language of ["en", "zh-TW"]) {
  const previous = results.find(r => r.name === `before-phone-dark-${language}`), candidate = results.find(r => r.name === `after-phone-dark-${language}`);
  if (JSON.stringify(previous.layout.tap) !== JSON.stringify(candidate.layout.tap)) throw Error("existing phone control dimensions changed");
}
if (effects !== 0 || git("rev-parse", "HEAD") !== head || git("status", "--porcelain", "--untracked-files=no")) throw Error("capture boundary changed");
for (const p of inputs) if (sources[p] !== digest(readFileSync(join(repo, p)))) throw Error("source changed: " + p);
writeFileSync(join(out, "receipt.json"), JSON.stringify({ head, tree, baseline, sources, browser: fx.browser.version(), effects, cases: results,
  scope: "Display fixtures from real diff + confirmation store; real cookie sign-in/app.html/Settings shell/Preact/styles, recorded pending reads. No write, authority/effect or chat delivery E2E. Baseline exact assets substituted only as listed. No live account, fleet, CLI or native runtime." }, null, 2) + "\n");
console.log(JSON.stringify({ cases: results.length, screenshots: results.length + 2, effects, cleanup: "browser/listeners/store/scratch home closed" }));
process.exit(0);

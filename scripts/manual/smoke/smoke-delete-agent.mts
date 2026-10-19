// Delete an agent from Settings (the user's beta.9 report: Delete + Apply did nothing — "unsupported_sensitive_effect"),
// from defaults (fleet decision a78ebdc5). A fresh profile signs in through the visible /signin, opens Settings → Agents,
// deletes a demo agent from its ⋯ menu and applies. The agent's config carries what refused it before: free text
// (a description, a display name), an unknown key and a string list. Judged, per case:
//   - the DELETE is held for a fleet admin's confirmation (202), and the page says so on the change's row;
//   - the admin confirms (as the General card or `agend settings confirm <id>` does: the store's decide), and the agent
//     is gone — from the running config, from fleet.yaml on disk and from the page; the page reports it applied;
//   - no page error, and no raw error code on the page.
// Cases: desk light (English), phone dark (zh-TW, reduced motion, a LAN origin in Chromium), and the temporary public
// link (desk light, reduced motion) — where, as everywhere, nothing is deleted until a fleet admin confirms it.
// Stubbed, as the harness says: the lifecycle's stop (never the live tmux server) — FleetManager.removeInstance runs as in
// production, with a remove that persists exactly as the real one does (delete the entry, save fleet.yaml).
//   PW_DIR=… REPO=… OUT=… [PW_ENGINE=webkit] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-delete-agent.mts
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { bootFixture, freshPage, mounted, openPublicLink, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-delete-agent";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
// The page's own navigation to /settings/agents (freshPage, right after the sign-in reaches /ui) cancels what /ui had in
// flight: its stream, a poll, and — when it has not answered yet (1 run in 9) — the app's one /auth/session read
// (AgendAuth.session). WebKit logs each as "cannot load … due to access control checks" (the URL as "http: /host…").
// Accepted only by position — inside that navigation, before the smoke's first click (nothing after it navigates) — and
// only for those three; the same line anywhere later fails.
const CANCEL = /^(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/(events|poll)|auth\/session)(\?\S*)? due to access control checks\.$/;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48580), classic: false });
const fm = fx.fm;
const KEEP = ["observability-dashboards", "billing-reconciliation"];
const VICTIMS = ["search-indexer", "nightly-benchmarks", "docs-site-builder"];
for (const name of Object.keys(fm.fleetConfig.instances)) if (![...KEEP, ...VICTIMS].includes(name)) delete fm.fleetConfig.instances[name];
for (const v of VICTIMS) Object.assign(fm.fleetConfig.instances[v], { description: "Indexes the docs nightly — free text", display_name: `${v} ✨`,
  custom_note: { owner: "demo team", since: "2026-10" }, custom_labels: ["alpha", "beta"] });
fm.saveFleetConfig();
const removed: string[] = [];
fm.lifecycle.runTransition = (_name: string, fn: (t: unknown) => Promise<unknown>) => fn({});
fm.lifecycle.remove = async (name: string, _auth: unknown, execution?: any) => {
  const persist = () => { delete fm.fleetConfig.instances[name]; fm.saveFleetConfig(); };
  if (execution) execution.mutate(persist); else persist();
  removed.push(name);
};
const onDisk = () => Object.keys((yaml.load(readFileSync(fm.configPath, "utf8")) as any).instances ?? {});
const RAW = /unsupported_sensitive_effect|confirmation_diff_too_large|settings_confirmation_unavailable|session_required/;

const results: any[] = [];
async function deleteThroughUi(p: FreshPage, victim: string, lang: string) {
  await mounted(p.page, 30000);
  await p.page.waitForSelector(".s-row", { timeout: 15000 });
  const row = p.page.locator(".s-row").filter({ hasText: `${victim} ✨` }).first();
  await row.locator(".s-actions button").last().click();                       // ⋯
  await p.page.getByText(lang === "en" ? "Delete agent" : "刪除 agent", { exact: true }).last().click();
  await p.page.waitForSelector("dialog[open]", { timeout: 5000 });
  await p.page.click("dialog[open] .btn-danger");
  await p.page.getByRole("button", { name: lang === "en" ? "Apply changes" : "套用變更" }).click();
}
async function runCase(name: string, open: () => Promise<FreshPage>, victim: string, lang: string) {
  const p = await open();
  await mounted(p.page, 30000);
  await p.page.waitForTimeout(800);
  const navEnd = p.errors.length;                   // the opening navigation's lines end here
  const calls: any[] = [];
  p.page.on("response", (r: any) => { const u = new URL(r.url()); if (r.request().method() !== "GET" && u.pathname.startsWith("/api/settings")) calls.push(`${r.request().method()} ${u.pathname} ${r.status()}`); });
  const names = () => p.page.locator(".s-row .s-name").allTextContents();
  await p.page.waitForSelector(".s-row", { timeout: 15000 });
  const before = await names();
  await deleteThroughUi(p, victim, lang);
  // Held for a fleet admin: the pending card says what it waits for, where to confirm it, and offers Withdraw — on screen.
  const card = await p.page.waitForSelector(".pending-card.pending", { timeout: 10000 }).then(() => true, () => false);
  await p.page.waitForTimeout(1500);                                      // the "queued" toast has had its moment
  const waitingCard = await p.page.evaluate(() => {
    const c = document.querySelector(".pending-card.pending") as HTMLElement | null; if (!c) return null;
    const r = c.getBoundingClientRect();
    return { text: c.innerText, inView: r.height > 0 && r.top >= 0 && r.bottom <= innerHeight, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight };
  });
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "1-waiting") });
  const gate = (fm as any).settingsGate();
  const pending = [...gate.store.records.values()].filter((e: any) => e.view.state === "pending");
  const summary = pending.map((e: any) => e.view.summary).flat();
  for (const e of pending) await gate.store.decide(e.view.id, "confirm", { label: "fleet admin (smoke)", current: () => true });
  // The card turns to "Confirmed and applied" (the page follows it every 2 s) and the agent's row goes.
  const applied = await p.page.waitForSelector(".pending-card.applied", { timeout: 10000 }).then(() => true, () => false);
  const gone = await p.page.waitForFunction((v: string) => ![...document.querySelectorAll(".s-row .s-name")].some((e) => (e.textContent ?? "").includes(v)), victim, { timeout: 20000 }).then(() => true, () => false);
  await p.page.waitForTimeout(500);
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "2-deleted") });
  const after = await names();
  const text = await p.page.evaluate(() => document.body.innerText);
  const errors = p.errors.filter((e, i) => { const text = e.replace(/ @ \S+$/, "");
    return !(ENGINE === "webkit" && (WEBKIT_OWN.has(text) || (i < navEnd && CANCEL.test(text)))); });
  const chk = { heldForConfirmation: calls.some((c) => c === `DELETE /api/settings/fleet/instances/${victim} 202`) && pending.length === 1,
    // The confirmation says what it does in one line (the operation, then "<the agent>: deleted"), none of its fields.
    oneLineSummary: summary.length === 2 && /^fleet\.instances\..+: deleted$/.test(summary[1]) && !summary.join().includes("custom"),
    // What it waits for, where to confirm it (General, or the host command when no chat can take it), and Withdraw.
    pageSaysWaiting: card && !!waitingCard && waitingCard.text.includes(lang === "en" ? "Waiting for confirmation" : "等待確認")
      && (lang === "en" ? /General|agend settings confirm/ : /General|agend settings confirm/).test(waitingCard.text) && waitingCard.text.includes(lang === "en" ? "Withdraw" : "撤回"),
    waitingCardOnScreen: !!waitingCard?.inView,
    cardSaysApplied: applied, goneFromPage: gone && before.some((n: string) => n.includes(victim)) && !after.some((n: string) => n.includes(victim)) && after.length === before.length - 1, goneFromConfig: !Object.hasOwn(fm.fleetConfig.instances, victim), goneFromDisk: !onDisk().includes(victim),
    removedOnce: removed.filter((r) => r === victim).length === 1, noRawCode: !RAW.test(text), noErrors: errors.length === 0 };
  const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length, failed, calls, summary, errors, waitingCard, before, after });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${ENGINE}-${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify({ calls, summary, errors, waitingCard, before, after }).slice(0, 1600)}` : ""}`);
  await p.ctx.close();
}
await runCase("desk-light-en", () => freshPage(fx, { device: "desk", theme: "light", lang: "en" }, { path: "/settings/agents" }), VICTIMS[0], "en");
await runCase(ENGINE === "webkit" ? "phone-dark-zh-TW-reduced" : "phone-dark-zh-TW-lan-reduced",
  () => freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, ENGINE === "webkit" ? { reducedMotion: true, path: "/settings/agents" } : { origin: "lan", reducedMotion: true, path: "/settings/agents" }), VICTIMS[1], "zh-TW");
// The temporary public link (desk light, reduced motion; stubbed as the harness says): the same — held for a fleet
// admin's confirmation in chat, never applied by the link alone, and done once it is confirmed.
{
  const link = await openPublicLink(fx);
  await runCase("public-link-desk-light-en-reduced", () => link.publicPage({ device: "desk", theme: "light", lang: "en" }, { reducedMotion: true, path: "/settings/agents" }), VICTIMS[2], "en");
  await link.close();
}
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : `PASS (${ENGINE})`);
await fx.close();
process.exit(bad.length ? 1 : 0);

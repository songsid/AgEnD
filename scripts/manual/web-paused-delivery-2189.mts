/**
 * #2189: fresh browser, visible sign-in and composer only; no cookies/prefs/consents seeded.
 * Real web routes + human delivery facade + explicitWake + IPC handoff, with a private lifecycle wake/IPC adapter.
 * No fleet, CLI, tmux, vendor or real account is started. Replies below are synthetic adapter output, not an LLM.
 * Includes local/LAN, phone, OS reduced motion, Classic and real fixture PublicWebLink (transport/provider mocked).
 * Run after build+postbuild:
 * REPO=<checkout> PW_DIR=<playwright-core> OUT=<short directory> npx tsx scripts/manual/web-paused-delivery-2189.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, openPublicLink, mounted, shotPath } from "./smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48780), instances: 2 });
const fm = fx.fm, paused = new Set<string>(), wakes: string[] = [], handoffs: any[] = [], rows: any[] = [];
let mode: "held" | "refused" | "ready" = "held", release: (() => void) | null = null;
// Only synthetic display names/rooms in screenshots, never the fixture's historical fleet labels.
const template = fx.instances.find(i => !i.general)!.name;
const name = "demo-paused-agent";
fm.fleetConfig.instances[name] = { ...fm.fleetConfig.instances[template], display_name: "Demo paused agent", description: "Synthetic web delivery fixture" };
delete fm.fleetConfig.instances[template];
writeFileSync(join(fx.dir, "classicBot.yaml"), "channels:\n  demo:\n    channelId: '-1000000000111'\n    adapterId: telegram\n    instanceName: classic-demo-paused\n    name: Demo paused room\n    backend: codex\n");
const { ClassicChannelManager } = await import(process.env.REPO! + "/src/classic-channel-manager.ts");
fm.classicChannels = new ClassicChannelManager(fx.dir, fm.logger);
const classic = fm.classicChannels.getAll()[0]?.instanceName;
const originalStatus = fm.getInstanceStatus.bind(fm);
fm.getInstanceStatus = (n: string) => paused.has(n) ? "paused" : originalStatus(n);
fm.lifecycle.isPaused = (n: string) => paused.has(n);
// Replace only the launch/wake boundary. Keep explicitWake, the facade, receipt binding and web admission real.
fm.lifecycle.wake = async (n: string) => {
  wakes.push(n);
  if (mode === "refused") throw new Error(`No warm slot is free for '${n}' (demo refusal)`);
  if (mode === "held") await new Promise<void>(r => { release = r; });
  paused.delete(n);
  fm.instanceIpcClients.set(n, { connected: true, send(payload: any) {
    handoffs.push({ instance: n, text: payload.content, source: payload.meta?.source });
    const reply = `Demo reply: ${payload.content}`;
    setTimeout(() => fm.emitSseEvent("message", { instance: n, sender: n, role: "agent", text: reply, ts: new Date().toISOString() }), 100);
    return true;
  } });
};
const pause = (n: string) => { paused.add(n); fm.instanceIpcClients.delete(n); fm.emitSseEvent("status", fm.getUiStatus()); };
const wait = async (test: () => boolean) => { for (let i = 0; i < 100; i++) { if (test()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error("private wake adapter not reached"); };
async function check(id: string, open: () => Promise<any>, target = name) {
  pause(target); mode = "held"; release = null;
  const before = handoffs.length, wakeBefore = wakes.length;
  let p: any, page: any, behaviorPassed = false;
  try {
    p = await open(); page = p.page;
    if (!await mounted(page)) throw new Error("app not mounted");
    // Navigate by the visible instance link, including the phone's drawer.
    if (page.viewportSize().width < 900) await page.locator("#main button.only-narrow").click();
    await page.locator(`a[href="/ui/chat/${encodeURIComponent(target)}"]`).first().click();
    await page.locator("#msgIn").waitFor();
    const first = `hello ${id}`;
    await page.locator("#msgIn").fill(first); await page.locator("#sendBtn").click();
    await page.locator(".send-waking").waitFor(); await wait(() => release !== null);
    await page.screenshot({ path: shotPath("web-paused-delivery-2189", id, "waking") });
    release!();
    await page.getByText(`Demo reply: ${first}`, { exact: true }).waitFor();
    if (handoffs.length !== before + 1 || wakes.length !== wakeBefore + 1 || handoffs.at(-1).source !== "web") throw new Error("not exactly one wake and handoff");
    await page.screenshot({ path: shotPath("web-paused-delivery-2189", id, "reply") });
    pause(target); mode = "refused";
    // Wait for the real stream's paused status before the next visible send.
    await page.waitForTimeout(150);
    const refused = `keep this text ${id}`;
    await page.locator("#msgIn").fill(refused);
    const response = page.waitForResponse((r: any) => r.url().endsWith("/ui/send") && r.request().method() === "POST");
    await page.locator("#sendBtn").click(); const failed = await response;
    if (failed.status() !== 503 || (await failed.json()).reason !== "wake_capacity") throw new Error("wrong refusal");
    await page.locator(".send-failure").waitFor();
    if (!(await page.locator(".send-failure").innerText()).match(/No slot|沒有空位/)) throw new Error("missing actionable reason");
    if (await page.locator("#msgIn").inputValue() !== refused || handoffs.length !== before + 1) throw new Error("draft lost or refused message delivered");
    await page.screenshot({ path: shotPath("web-paused-delivery-2189", id, "refused-text-kept") });
    mode = "ready";
    await page.locator(".send-failure button").click();
    await page.getByText(`Demo reply: ${refused}`, { exact: true }).waitFor();
    if (handoffs.length !== before + 2 || wakes.length !== wakeBefore + 3 || await page.locator(".send-failure").count()) throw new Error("retry was not one accepted handoff");
    await page.screenshot({ path: shotPath("web-paused-delivery-2189", id, "retry-reply") });
    behaviorPassed = true;
    const unexpected = p.errors.filter((e: string) => !(/status of 503/.test(e) && /\/ui\/send/.test(e)));
    if (unexpected.length) throw new Error(`unexpected browser errors: ${unexpected.join("; ")}`);
    rows.push({ id, status: "pass", origin: new URL(page.url()).origin, target: target === classic ? "Classic" : "configured", wakes: 3, handoffs: 2,
      fromDefaults: true, visibleSignin: true, reducedMotion: await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), errors: unexpected, expectedRefusalErrors: p.errors.filter((e: string) => !unexpected.includes(e)) });
  } catch (e) {
    rows.push({ id, status: "fail", behaviorPassed, error: String(e) });
    await page?.screenshot({ path: shotPath("web-paused-delivery-2189", id, "failed") }).catch(() => {});
  } finally { console.log(JSON.stringify(rows.at(-1))); release?.(); await p?.ctx.close(); }
}
try {
  for (const device of ["desk", "phone"] as const) for (const origin of ["loopback", "lan"] as const) {
    const c = { device, theme: device === "phone" ? "dark" as const : "light" as const, lang: "en" as const };
    await check(`${device}-${origin}`, () => freshPage(fx, c, { origin, reducedMotion: device === "phone" }));
  }
  if (!classic) throw new Error("no private Classic fixture");
  await check("classic-phone", () => freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, { reducedMotion: true }), classic);
  const link = await openPublicLink(fx);
  try { await check("public-phone", () => link.publicPage({ device: "phone", theme: "light", lang: "en" }, { reducedMotion: true })); }
  finally { await link.close(); }
} finally { await fx.close(); }
const out = process.env.OUT!; mkdirSync(out, { recursive: true });
writeFileSync(join(out, "receipt.json"), JSON.stringify({ scope: "Private lifecycle/IPC + synthetic replies; no real backend/channel/account", browser: fx.browser.version(), rows }, null, 2));
console.log(JSON.stringify(rows));
if (rows.length !== 6 || rows.some(r => r.status !== "pass")) process.exitCode = 1;

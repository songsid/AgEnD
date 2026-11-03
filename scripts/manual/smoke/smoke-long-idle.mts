// M-2260 (the user, hmsg-16c13410): a dashboard chat left open for half a day, looked at again — in a real browser, on
// the product's own web server (the shared fixture: no CLI, no tmux), signed in as the operator, a chat open.
//  A. slow link after a sleep: the network goes, the streams die, the fleet says 600 replies of ~6 KB across three
//     agents; the network comes back at 200 KB/s (WSL's relay, a tunnel). Judged: the open chat shows its newest
//     reply within 20 s (a reload takes ~5 s on this link; the reconnect's own backoff is up to 5 s here), without
//     "Could not load…", and without the messages from before the gap sitting across a hole (what a reload shows).
//  B. a frozen tab (Chrome freezes hidden tabs) while the fleet sends half a day of heartbeats (4,320 status frames) and
//     300 replies: on waking, the newest reply shows within 2 s.
//  C. the session ran out meanwhile: "Your session has ended. Sign in again" within 5 s, and no request after it.
// Cases A (desk-light-en, phone-dark-zh-TW), B and C (desk-light-en). No page error except the expected network ones.
// MODE=before (REPO = a checkout of the base) shows the bug: A never shows the newest.
//   PW_DIR=… REPO=… OUT=… npx --prefix <checkout> tsx scripts/manual/smoke/smoke-long-idle.mts
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-long-idle";
const MODE = process.env.MODE === "before" ? "before" : "after";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48860), classic: false, instances: 40 });
const fm = fx.fm;
const names = Object.keys(fm.fleetConfig.instances).filter((n: string) => !fm.fleetConfig.instances[n].general_topic);
const inst = names[0]!;
const BODY = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(106).slice(0, 6000);
let n = 0;
const say = (who = inst, body = BODY) => fm.emitSseEvent("message", { instance: who, sender: who, role: "agent", text: `reply ${++n} from ${who}\n\n${body}`, ts: new Date().toISOString() });
const newestOf = (who: string) => { for (const m of [...fm.webChatHistory.list(who)].reverse()) { const k = /reply (\d+) from/.exec(m.text); if (k) return Number(k[1]); } return -1; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; failed: string[]; note?: string }> = [];
const T = { en: { failed: "Could not load what is open now", ended: "Your session has ended" }, "zh-TW": { failed: "無法載入目前的狀態", ended: "登入已結束" } } as const;

async function open(c: { device: "desk" | "phone"; theme: "light" | "dark"; lang: "en" | "zh-TW" }) {
  const p = await freshPage(fx, c as any, { account: "operator" });
  await mounted(p.page, 30000);
  await p.page.goto(`${p.base}/ui/chat/${encodeURIComponent(inst)}`);
  await p.page.waitForSelector("#msgIn", { timeout: 20000 });
  await p.page.waitForTimeout(800);
  const cdp = await p.ctx.newCDPSession(p.page);
  const shown = () => p.page.evaluate(`[...document.querySelectorAll(".msg[data-key]")].map(el => Number((/reply (\\d+) from/.exec(el.textContent) || [])[1])).filter(Number.isFinite)`) as Promise<number[]>;
  const line = () => p.page.evaluate(`[...document.querySelectorAll(".conn")].map(e => e.textContent.trim()).join(" | ")`) as Promise<string>;
  return { ...p, cdp, shown, line };
}
async function until(fn: () => Promise<boolean>, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await sleep(200); } return false; }

// A. slow link after a sleep.
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const failed: string[] = [];
  const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
  for (let i = 0; i < 30; i++) say();
  const p = await open(c);
  const before = await p.shown();
  await p.cdp.send("Network.enable");
  await p.cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  for (const res of [...(fm.sseClients ?? [])]) { try { (res as any).destroy(); } catch { /* gone */ } }
  for (let i = 0; i < 600; i++) { say(names[i % 3]!); if (i % 50 === 0) await sleep(5); }
  say(inst, "The newest reply, said while this page was away.");          // short: it shows in the screenshot
  await sleep(4000);
  await p.cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 80, downloadThroughput: 200 * 1024, uploadThroughput: -1 });
  const w = Date.now(), newest = newestOf(inst);
  const ok = await until(async () => (await p.shown()).at(-1) === newest, MODE === "before" ? 60000 : 20000);
  const took = Date.now() - w;
  need(ok, `the newest reply (${newest}) shown within ${MODE === "before" ? 60 : 20} s (shown: …${(await p.shown()).slice(-3).join(",")}; line: ${await p.line()})`);
  // Then the chat's own newest history arrives (as a reload reads it): the replies from before the gap go, no hole.
  const whole = ok && await until(async () => { const shown = await p.shown(); return shown.at(-1) === newest && !shown.some(k => before.includes(k)); }, 30000);
  const settled = Date.now() - w;
  const shown = await p.shown();
  need(whole, `no hole: the replies from before the gap are not shown across it (shown ${shown[0]}…${shown.at(-1)}, ${shown.length})`);
  need(!(await p.line()).includes(T[c.lang].failed), "no \"Could not load…\"");
  await p.page.screenshot({ path: shotPath(SMOKE, c as any, `${MODE}-slow-link`) });
  // The reload, for comparison.
  const r = Date.now();
  await p.page.reload();
  await until(async () => (await p.shown()).at(-1) === newest, 60000);
  const reload = Date.now() - r;
  need(p.errors.filter(e => !/ERR_INTERNET_DISCONNECTED|ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_NETWORK_CHANGED/.test(e)).length === 0, `no page error: ${p.errors.slice(0, 2).join(" / ")}`);
  results.push({ name: `A slow link ${c.device}-${c.theme}-${c.lang}`, ok: !failed.length, failed, note: `newest after ${ok ? took : "never"} ms, the whole chat as a reload shows it after ${whole ? settled : "never"} ms; reload ${reload} ms` });
  await p.ctx.close();
}

// B. a frozen tab, half a day of heartbeats.
{
  const failed: string[] = [];
  const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
  const c = { device: "desk", theme: "light", lang: "en" } as const;
  const p = await open(c);
  await p.cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  for (let i = 0; i < 4320; i++) { fm.emitSseEvent("status", fm.getUiStatus()); if (i % 14 === 0) say(i % 42 === 0 ? names[1] : inst, "short"); if (i % 200 === 0) await sleep(1); }
  say(inst, "the last thing said");
  await sleep(500);
  const w = Date.now(), newest = newestOf(inst);
  await p.cdp.send("Page.setWebLifecycleState", { state: "active" });
  const ok = await until(async () => (await p.shown()).at(-1) === newest, MODE === "before" ? 30000 : 2000);
  need(ok, `the newest reply shown within 2 s of waking (line: ${await p.line()})`);
  results.push({ name: "B frozen tab desk-light-en", ok: !failed.length, failed, note: `newest after ${ok ? Date.now() - w : "more than the limit"} ms` });
  await p.page.screenshot({ path: shotPath(SMOKE, c as any, `${MODE}-frozen`) });
  await p.ctx.close();
}

// C. the session ran out meanwhile.
{
  const failed: string[] = [];
  const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
  const c = { device: "desk", theme: "light", lang: "en" } as const;
  const p = await open(c);
  fm.webSessions.revokeAll();
  for (const res of [...(fm.sseClients ?? [])]) { try { (res as any).destroy(); } catch { /* gone */ } }
  const banner = () => p.page.evaluate(`document.querySelector('[data-trust="session-ended"]')?.textContent || ""`) as Promise<string>;
  need(await until(async () => (await banner()).includes(T.en.ended), 5000), "the session-ended banner within 5 s");
  await p.page.screenshot({ path: shotPath(SMOKE, c as any, `${MODE}-session-ended`) });
  const count = () => p.page.evaluate(`performance.getEntriesByType("resource").filter(e => /\\/ui\\/(poll|events)/.test(e.name)).length`) as Promise<number>;
  const a = await count(); await sleep(15000); const b = await count();
  need(b === a, `no request after it (${b - a} in 15 s)`);
  need((await banner()).includes(T.en.ended), "the banner is still there afterwards");
  results.push({ name: "C session ended desk-light-en", ok: !failed.length, failed });
  await p.ctx.close();
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.note ? ` (${r.note})` : ""}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
await fx.close();
process.exit(results.every(r => r.ok) ? 0 : 1);

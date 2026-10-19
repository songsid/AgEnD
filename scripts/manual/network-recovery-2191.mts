/** Fresh sign-in/settings UI; synthetic provider login only, no CLI/fleet/vendor/account starts. */
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, openPublicLink, shotPath } from "./smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48790), instances: 2, classic: false });
const fm = fx.fm, rows: any[] = [];
fm.logger.error = (...args: unknown[]) => console.error(...args);
const channel = { id: "demo-recovery", type: "discord", mode: "topic", bot_token_env: "AGEND_SMOKE_RECOVERY_TOKEN", access: { mode: "locked", allowed_users: [] } };
fm.fleetConfig.channels = [channel]; fm.rawFleetConfig.channels = [channel];
process.env.AGEND_SMOKE_RECOVERY_TOKEN = "synthetic-never-sent";
let attempts = 0, release: (() => void) | null = null;
fm.startSingleAdapter = async (_fleet: unknown, _channel: unknown, _started: unknown, operation: any) => {
  operation.assert(); attempts++;
  await new Promise<void>(resolve => { release = resolve; }); operation.assert();
  const adapter = Object.assign(new EventEmitter(), { type: "discord", sendText: async () => ({ messageId: "synthetic" }), connectionEvidence: () => ({ ready: true, authRejected: false }) });
  fm.adapter = adapter; fm.adapters.set(channel.id, adapter);
  fm.worlds.set(channel.id, { adapter, botUserId: "demo-bot", botUsername: "demo_recovery", groupId: "" });
};
const wait = async (test: () => boolean) => { const end = Date.now() + 5000; while (!test()) { if (Date.now() > end) throw new Error("timed out waiting for recovery"); await new Promise(r => setTimeout(r, 20)); } };
function disconnect() {
  fm.adapter = null; fm.adapters.delete(channel.id); fm.worlds.delete(channel.id);
  fm.adapterState.set(channel.id, { status: "retrying", retryCount: 12, lastError: "synthetic offline connection" });
  release = null;
}

try {
  for (const c of [
    { device: "desk", theme: "light", lang: "en", origin: "loopback" },
    { device: "phone", theme: "dark", lang: "zh-TW", origin: "loopback" },
    { device: "desk", theme: "dark", lang: "en", origin: "lan" },
    { device: "phone", theme: "light", lang: "zh-TW", origin: "lan" },
  ] as const) {
    disconnect(); const before = attempts, id = `${c.device}-${c.origin}`;
    const p = await freshPage(fx, c, { origin: c.origin, reducedMotion: true, account: "operator", path: "/settings/bots" });
    let requests = 0;
    p.page.on("request", (r: any) => { if (r.method() === "POST" && r.url().endsWith(`/${channel.id}/retry`)) requests++; });
    try {
      if (!await mounted(p.page)) throw new Error("settings did not mount");
      await p.page.getByRole("button", { name: /Retry now|立即重試/, exact: true }).dblclick();
      await wait(() => release !== null);
      if (attempts !== before + 1 || requests !== 1) throw new Error(`duplicate retry ${attempts - before}/${requests}`);
      await p.page.screenshot({ path: shotPath("network-recovery-2191", id, "retrying") });
      release!(); await wait(() => fm.adapterRetryInFlight.size === 0);
      await p.page.reload();
      await p.page.getByText(/Connected · @demo_recovery|已連線 · @demo_recovery/, { exact: true }).waitFor();
      if (await p.page.getByRole("button", { name: /Retry now|立即重試/, exact: true }).count()) throw new Error("connected row still offers retry");
      await p.page.screenshot({ path: shotPath("network-recovery-2191", id, "connected") });
      if (p.errors.length) throw new Error(p.errors.join("; "));
      rows.push({ id, status: "pass", attempts: 1, requests, fromDefaults: true, visibleSignin: true, reducedMotion: true, errors: p.errors });
    } catch (e) { rows.push({ id, status: "fail", error: String(e) }); }
    finally { release?.(); await p.ctx.close(); }
  }
  disconnect(); const before = attempts;
  const link = await openPublicLink(fx);
  try {
    const p = await link.publicPage({ device: "phone", theme: "light", lang: "en" }, { reducedMotion: true, path: "/settings/bots" });
    try {
      await p.page.getByText(channel.id, { exact: true }).waitFor();
      if (await p.page.getByRole("button", { name: "Retry now", exact: true }).count()) throw new Error("public link offers retry");
      const status = await p.page.evaluate(async () => (await fetch("/api/settings/connections/demo-recovery/retry", { method: "POST" })).status);
      if (![403, 404].includes(status) || attempts !== before) throw new Error("public link gained a retry");
      await p.page.screenshot({ path: shotPath("network-recovery-2191", "public-phone", "refused") });
      const unexpected = p.errors.filter((e: string) => !/status of (403|404).*\/api\/settings\/connections\/demo-recovery\/retry/.test(e));
      if (unexpected.length) throw new Error(unexpected.join("; "));
      rows.push({ id: "public-phone", status: "pass", refusedStatus: status, attempts: 0, fromDefaults: true, errors: unexpected, expectedRefusalErrors: p.errors });
    } finally { await p.ctx.close(); }
  } finally { await link.close(); }
} catch (error) { rows.push({ id: "fixture", status: "fail", error: String(error) }); }
finally { await fx.close(); }
const out = process.env.OUT!; mkdirSync(out, { recursive: true });
writeFileSync(join(out, "receipt.json"), JSON.stringify({ scope: "Real Settings HTTP/UI/retry scheduler; provider login stubbed, no live fleet or account", runtime: process.version, browser: fx.browser.version(), rows }, null, 2));
console.log(JSON.stringify(rows));
if (rows.length !== 5 || rows.some(r => r.status !== "pass")) process.exitCode = 1;

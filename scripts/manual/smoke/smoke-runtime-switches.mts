// M-2255 / #2953 1.1, 1.8, 2.1, 2.2: Settings → Runtime's switches in a real browser, on the product's own web server
// (the shared fixture: an in-process FleetManager in a scratch home, no CLI, no tmux). Signed in as the operator.
// Per case (desk 1366 / phone 390, light / dark, en / zh-TW):
//  - both switches drawn off, as switches, with their plain-language text in the page's language; the per-PC limit;
//  - the connection guide in the page (Tailscale Serve to this fleet's own address, SSH tunnel, never Funnel, no LAN http);
//  - no horizontal overflow on a phone; no page error or CSP violation.
// Flows (desk-light-en and phone-dark-zh-TW): "Allow other Windows PCs to pair" on → the page says it waits for a fleet
// admin → confirmed server-side (as a General admin's card would) → on in fleet.yaml and in force, applied live (the
// runtime API answers enabled, the download appears) → off: asked in the app's dialog, applied at once → the limit
// saved. Environment case (desk-dark-en): AGEND_WINDOWS_CLI=1 → shown on, not changeable, the variable named.
//   PW_DIR=… REPO=… OUT=… npx --prefix <checkout> tsx scripts/manual/smoke/smoke-runtime-switches.mts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-runtime-switches";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48820), classic: false, instances: 6 });
const fm = fx.fm;
const sw = await import(process.env.REPO + "/src/runtime-switches.ts");
fm.runtimeEffects = { windows_cli: false, remote_runtime: false };     // as a started fleet leaves it: changes apply live
const yamlRuntimes = () => { const text = readFileSync(join(fx.dir, "fleet.yaml"), "utf8"); const at = text.indexOf("runtimes:"); return at < 0 ? "" : text.slice(at, at + 160); };
const CASES = [
  { device: "desk", theme: "light", lang: "en", flow: true },
  { device: "phone", theme: "light", lang: "zh-TW" },
  { device: "desk", theme: "dark", lang: "en", env: true },
  { device: "phone", theme: "dark", lang: "zh-TW", flow: true },
] as const;
const T = {
  en: { local: "Use this PC's Windows CLIs", remote: "Allow other Windows PCs to pair", stays: "This computer stays your fleet", funnel: "Never use Tailscale Funnel",
    wait: "Waiting for a fleet admin to confirm. It turns on once they do.", off: "Turn off", saved: "Saved.", env: "Set by the environment (AGEND_WINDOWS_CLI=1)", limit: "Agents at once on each Windows PC", download: "Download Windows Runtime" },
  "zh-TW": { local: "使用這台電腦 Windows 上的 CLI", remote: "允許其他 Windows 電腦配對", stays: "這台電腦仍是你的 Fleet", funnel: "請勿使用 Tailscale Funnel",
    wait: "等待 Fleet 管理員確認，確認後就會開啟。", off: "關閉此功能", saved: "已儲存。", env: "由環境變數設定（AGEND_WINDOWS_CLI=1）", limit: "每台 Windows 電腦同時執行的 Agent 數", download: "下載 Windows Runtime" },
} as const;
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
const until = async (fn: () => boolean | Promise<boolean>, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

for (const c of CASES) {
  const failed: string[] = [];
  const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
  const name = `${c.device}-${c.theme}-${c.lang}`, t = T[c.lang];
  if ("env" in c) process.env.AGEND_WINDOWS_CLI = "1";
  const p = await freshPage(fx, c as any, { account: "operator" });
  const page = p.page;
  try {
    await mounted(page, 30000);
    await page.goto(`${p.base}/settings/runtimes`);
    await page.waitForSelector("#runtimeRemoteRuntime", { timeout: 20000 });
    await page.waitForTimeout(400);
    const box = page.locator(".runtime-switches");
    const textOf = () => box.evaluate((el: any) => el.textContent as string);
    const state = () => page.evaluate(`(() => { const a = document.querySelector("#runtimeWindowsCli"), b = document.querySelector("#runtimeRemoteRuntime");
      return { local: [a.getAttribute("role"), a.checked, a.disabled], remote: [b.getAttribute("role"), b.checked, b.disabled],
        overflow: document.scrollingElement.scrollWidth - innerWidth, guide: [...document.querySelectorAll(".runtime-guide code")].map(x => x.textContent),
        guideOpen: document.querySelector(".runtime-guide").open }; })()`) as Promise<any>;
    const s = await state(), text = await textOf();
    need(JSON.stringify(s.local) === JSON.stringify(["switch", "env" in c, "env" in c]), `this PC's switch ${JSON.stringify(s.local)}`);
    need(JSON.stringify(s.remote) === JSON.stringify(["switch", false, false]), `pairing switch ${JSON.stringify(s.remote)}`);
    for (const k of ["local", "remote", "stays", "funnel", "limit"] as const) need(text.includes(t[k]), `text: ${t[k]}`);
    need(s.guide[0] === `tailscale serve --https=443 http://127.0.0.1:${fx.fm.fleetConfig.health_port}`, `guide address ${s.guide[0]}`);
    need(s.overflow <= 0, `no horizontal overflow (${s.overflow}px)`);
    if ("env" in c) need(text.includes(t.env), "the environment's override is named");
    // The open guide in the first shot (it starts closed while pairing is off).
    // The whole section in one shot: the settings pane scrolls inside the page, so the viewport grows for it.
    const vp = page.viewportSize()!;
    await page.evaluate(`document.querySelector(".runtime-guide").open = true`);
    await page.setViewportSize({ width: vp.width, height: 2000 }); await page.waitForTimeout(300);
    await box.screenshot({ path: shotPath(SMOKE, c as any, "switches") });
    // Back to the device's own size: a mobile page resized back is reloaded, so its layout (and where a tap lands) is
    // the device's again, not the tall one's.
    await page.setViewportSize(vp); await page.reload(); await page.waitForSelector("#runtimeRemoteRuntime", { timeout: 20000 }); await page.waitForTimeout(400);

    if ("flow" in c) {
      // On: waits for a fleet admin (the page says so), then confirmed as a General admin's card would.
      const put = page.waitForResponse((r: any) => r.url().endsWith("/api/settings/fleet/runtimes") && r.request().method() === "PUT");
      await page.locator("#runtimeRemoteRuntime").click();
      const answer = await (await put).json();
      need(answer.result === "pending_confirmation" && !!answer.pending_change?.id, `on waits for confirmation: ${JSON.stringify(answer).slice(0, 120)}`);
      need(await until(async () => (await textOf()).includes(t.wait), 5000), "the page says it waits for a fleet admin");
      need(!sw.remoteRuntimeEnabled() && !yamlRuntimes().includes("remote_runtime: true"), "nothing in force before the confirmation");
      await box.screenshot({ path: shotPath(SMOKE, c as any, "pending") });
      const decided = await fm.settingsGate().store.decide(answer.pending_change.id, "confirm", { label: "General admin (smoke)", current: () => true });
      need(decided.state === "applied", `confirmed → ${decided.state}`);
      need(await until(async () => (await state()).remote[1] === true), "the switch shows on after the confirmation");
      need(sw.remoteRuntimeEnabled() && yamlRuntimes().includes("remote_runtime: true"), `in force and in fleet.yaml: ${yamlRuntimes()}`);
      need(await until(() => fm.runtimeEffects?.remote_runtime === true, 3000), "applied live (no restart)");
      need(await until(async () => (await page.locator(".runtime-bundle-download").count()) > 0, 10000), "the runtime page now offers the download");
      need((await state()).guideOpen === true, "the guide opens while pairing is on");
      await page.setViewportSize({ width: vp.width, height: 2000 }); await page.waitForTimeout(300);
      await box.screenshot({ path: shotPath(SMOKE, c as any, "on") });
      await page.setViewportSize(vp); await page.reload(); await page.waitForSelector("#runtimeRemoteRuntime", { timeout: 20000 }); await page.waitForTimeout(400);
      need((await state()).remote[1] === true, "still on after a reload (saved, not just shown)");
      await page.screenshot({ path: shotPath(SMOKE, c as any, "on-page"), fullPage: false });
      // Off: asked in the app's dialog, then applied at once.
      await page.locator("#runtimeRemoteRuntime").click();
      const yes = page.locator('button[data-confirm="yes"]');
      await yes.waitFor({ timeout: 5000 });
      need((await yes.innerText()).trim() === t.off, `the dialog's button says ${t.off}`);
      await page.waitForTimeout(250);
      await page.screenshot({ path: shotPath(SMOKE, c as any, "off-ask") });
      await yes.click();
      need(await until(async () => (await state()).remote[1] === false), "off shows at once");
      need(!sw.remoteRuntimeEnabled() && yamlRuntimes().includes("remote_runtime: false"), `off in force and in fleet.yaml: ${yamlRuntimes()}`);
      need(await until(() => fm.runtimeEffects?.remote_runtime === false && fm.runtimeHub === null, 3000), "paired PCs' connections closed (hub gone)");
      // The limit.
      await page.locator("#runtimeMaxAgents").fill("6");
      await page.locator(".runtime-limit button[type=submit]").click();
      need(await until(async () => (await textOf()).includes(t.saved)), "the limit is saved");
      need(yamlRuntimes().includes("max_agents_per_machine: 6") && sw.maxAgentsPerMachine() === 6, `limit in fleet.yaml and in force: ${yamlRuntimes()}`);
    }
    need(p.errors.length === 0, `no page error or CSP violation: ${p.errors.slice(0, 2).join(" / ")}`);
  } catch (e) { failed.push(`threw: ${String(e).slice(0, 300)}`); }
  finally {
    if ("env" in c) delete process.env.AGEND_WINDOWS_CLI;
    await p.ctx.close();
    // Back to the defaults for the next case, whatever happened in this one.
    if (fm.fleetConfig.runtimes) { delete fm.fleetConfig.runtimes; fm.saveFleetConfig([{ path: ["runtimes"], remove: true }]); }
  }
  results.push({ name, ok: !failed.length, failed });
}
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
await fx.close();
process.exit(results.every(r => r.ok) ? 0 : 1);

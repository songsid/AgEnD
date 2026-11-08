// #3451: fleet Settings → Hub → "HTML previews on this Hub" Save and "Run this Hub" Stop through the REAL routes and the real
// Settings confirmation gate (no /api/settings/hub/* stub — the M-2682 smoke stubbed both PUTs, which is how both answering 403
// admin_confirmation_required got past it). The shared Settings fixture (in-process FleetManager, scratch home, loopback only)
// is given a `hub:` block in its own fleet.yaml after boot; the fixture never starts the Hub runtime. The host's own session
// (`agend web` here: host, admin, local) saves: Preview Save → fleet.yaml has hub.web.preview_port; Stop asks once, Cancel keeps it, confirming writes
// hub.enabled false; no other dialog, no page error, no CSP report. Desktop and phone.
//   PW_DIR=<dir> REPO=<checkout> OUT=<dir> [MATRIX=…] npx tsx scripts/manual/smoke/smoke-hub-host-switches-3451.mts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { bootFixture, caseName, matrix } from "../smoke-fixture/index.mts";

const OUT = join(process.env.OUT ?? "/tmp/smoke-out", "hub-host-switches-3451");
mkdirSync(OUT, { recursive: true });
const CASES = matrix(process.env.MATRIX ?? "desk-light-en,phone-dark-zh-TW,phone-light-en,desk-dark-zh-TW");
const HUB = { enabled: true, hubId: "4c3b2a19-0e8f-4d7c-9b6a-5f4e3d2c1b0a", name: "Team Hub", webOrigin: "https://hub.example.test:8444", memberOrigin: "https://hub.example.test:8443",
  webListen: { host: "127.0.0.1", port: 8444 }, memberListen: { host: "127.0.0.1", port: 8443 } };
const r: Record<string, unknown> = {}, fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const freePort = async () => { const s = createServer(); await new Promise<void>((res) => s.listen({ host: "127.0.0.1", port: 0 }, res)); const p = (s.address() as { port: number }).port; await new Promise<void>((res) => s.close(() => res())); return p; };
const fx = await bootFixture({ port: 19480, instances: 4, classic: false, host: true });
const yamlPath = join(fx.dir, "fleet.yaml"), base = readFileSync(yamlPath, "utf8");
const { default: yaml } = await import(process.env.REPO + "/node_modules/js-yaml/dist/js-yaml.mjs");
const hubOnDisk = () => (yaml.load(readFileSync(yamlPath, "utf8")) as any)?.hub;
try {
  for (const c of CASES) {
    const name = caseName(c), zh = c.lang === "zh-TW";
    // Each case starts from a running Hub with previews off, on disk and in force.
    writeFileSync(yamlPath, base + yaml.dump({ hub: HUB })); fx.fm.rawFleetConfig = { ...fx.fm.rawFleetConfig, hub: structuredClone(HUB) };
    const { ctx, page, csp } = await fx.page(c, { path: "/settings" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const answers: Array<[string, number]> = [];
    const bodies: unknown[] = [];
    page.on("response", async (res: any) => { const u = new URL(res.url()); if (u.pathname.startsWith("/api/settings/") && res.request().method() !== "GET") { answers.push([u.pathname, res.status()]); try { bodies.push(await res.json()); } catch {} } });
    (globalThis as any).__dbg = () => ({ answers, bodies });
    await page.goto(fx.base + "/settings/hub");
    await page.waitForSelector(".hub-preview-settings form", { timeout: 15000 });
    await page.evaluate(`document.querySelector(".hub-preview-settings").scrollIntoView({ block: "center" })`);
    const port = await freePort();
    await page.click("#hubPreviewOn"); await page.fill("#hubPreviewPort", String(port));
    await page.click(".hub-preview-settings button[type=submit]");
    await page.waitForSelector(".hub-preview-settings [role=status]", { timeout: 15000 });
    const status = await page.evaluate(`document.querySelector(".hub-preview-settings [role=status]").textContent`);
    await page.screenshot({ path: join(OUT, `${name}-preview-saved.png`) });
    check(`${name}:preview-save`, status === (zh ? "已儲存。Hub 會重新載入以套用。" : "Saved. The Hub reloads to apply it.") && hubOnDisk()?.web?.preview_port === port,
      { status, onDisk: hubOnDisk()?.web, answers });
    await page.evaluate(`document.querySelector(".hub-run-settings").scrollIntoView({ block: "center" })`);
    await page.click("#hubRunOn"); await page.waitForSelector("[data-confirm=yes]", { timeout: 8000 });
    await page.click("dialog[open] .btn:not([data-confirm])"); await page.waitForTimeout(300);
    const kept = { enabled: hubOnDisk()?.enabled, on: await page.evaluate(`document.querySelector("#hubRunOn").checked`) };
    await page.click("#hubRunOn"); await page.waitForSelector("[data-confirm=yes]", { timeout: 8000 });
    await page.screenshot({ path: join(OUT, `${name}-run-stop-ask.png`) });
    await page.click("[data-confirm=yes]");
    await page.waitForSelector(".hub-run-settings [role=status]", { timeout: 15000 });
    await page.waitForTimeout(300);
    const stopped = { enabled: hubOnDisk()?.enabled, on: await page.evaluate(`document.querySelector("#hubRunOn").checked`),
      status: await page.evaluate(`document.querySelector(".hub-run-settings [role=status]")?.textContent`), dialogs: await page.evaluate(`document.querySelectorAll("dialog[open]").length`) };
    await page.screenshot({ path: join(OUT, `${name}-run-stopped.png`) });
    check(`${name}:run-stop`, kept.enabled === true && kept.on === true && stopped.enabled === false && stopped.on === false && stopped.dialogs === 0
      && stopped.status === (zh ? "Hub 已停止。" : "The Hub is stopped."), { kept, stopped, answers });
    check(`${name}:no-403`, answers.every(([, s]) => s !== 403) && answers.length === 2, answers);
    check(`${name}:no-errors`, errs.length === 0 && (await csp()).length === 0, { errs, csp: await csp() });
    await ctx.close();
  }
} catch (e) { r.debug = (globalThis as any).__dbg?.(); fail.push(`exception: ${(e as Error).message}`); r.exception = String((e as Error).stack || e).slice(0, 1000); }
finally {
  await fx.close?.();
  writeFileSync(join(OUT, "result.json"), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([, v]) => v !== "PASS")), null, 2));
  console.log(`${Object.keys(r).length} checks; ` + (fail.length ? `FAIL ${fail.length}: ${fail.join(", ")}` : "ALL PASS"));
  process.exit(fail.length ? 1 : 0);
}

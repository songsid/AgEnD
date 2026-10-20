// #2233 part 3 from defaults (fleet decision a78ebdc5): the pre-fleet setup page's "Web only (no bot)", in a real
// browser against the real SetupHost (scratch AGEND_HOME, nothing seeded). Desk and phone.
//   code     — the setup code is typed into the page's own gate;
//   choose   — Web only hides the credentials step and needs no Verify; the review shows the agent alone;
//   confirm  — Create sends the agent with no token; the page says to confirm on the host; the host confirmation is the
//              real control socket (what `agend settings confirm <id>` does);
//   start    — Start AgEnD hands over (the fleet spawn is a spy: no fleet starts); the written fleet.yaml has the agent and
//              no channel/channels, and no .env was written.
// No page error (WebKit's own lines only). The page's CSP has no unsafe-eval: every wait here is a function, not a string.
//   PW_DIR=… REPO=… OUT=… [PW_ENGINE=webkit] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2233-setup-web-only.mts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.env.REPO!, PW = process.env.PW_DIR!, OUT = process.env.OUT ?? "/tmp";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const SMOKE = "smoke-2233-setup-web-only";
mkdirSync(join(OUT, SMOKE), { recursive: true });
const shot = (tag: string, name: string) => join(OUT, SMOKE, `${ENGINE}-${tag}-${name}.png`);
const { SetupHost } = await import(REPO + "/src/setup-host.ts");
const { requestSettingsConfirmation } = await import(REPO + "/src/settings-control.ts");
const yaml = (await import("js-yaml")).default;
const pw = createRequire(PW + "/")("playwright-core");
const browser = ENGINE === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ args: ["--no-sandbox"] });
const results: any = { engine: ENGINE, cases: {} };
let failed = false;
const verdict = (name: string, ok: boolean, d: any) => { results.cases[name] = { ok, ...d }; if (!ok) failed = true; console.log(`${ok ? "ok  " : "FAIL"} ${ENGINE} ${name}: ${JSON.stringify(d).slice(0, 500)}`); };
// WebKit's own lines, as in the other smokes (its automation's injected stylesheet; a viewport key it does not know).
const WEBKIT_OWN = /^(Viewport argument key "interactive-widget"|Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.$)/;

for (const c of [{ device: "desk", viewport: { width: 1366, height: 900 } }, { device: "phone", viewport: { width: 390, height: 844 } }] as const) {
  const dir = mkdtempSync(join(tmpdir(), "smoke-2233-setup-"));
  delete process.env.AGEND_INSTANCE_NAME;
  let spawned = 0;
  const host = new SetupHost({ dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, spawnFleet: () => { spawned++; }, log: () => {} });
  try {
    const { port, path, code } = await host.start();
    const ctx = await browser.newContext({ viewport: c.viewport, isMobile: c.device === "phone", hasTouch: c.device === "phone" });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(String(e.message)));
    page.on("console", (m: any) => { if (m.type() === "error" && !(ENGINE === "webkit" && WEBKIT_OWN.test(m.text()))) errors.push(m.text()); });
    const base = `http://127.0.0.1:${port}${path}`;
    await page.goto(base);
    await page.fill("#code", code); await page.click("#go");
    const gated = await page.waitForSelector("#pickWeb", { timeout: 10000 }).then(() => true, () => false);
    verdict(`${c.device} code`, gated, { gated });
    await page.click("#pickWeb");
    const credHidden = await page.evaluate(`document.getElementById("credStep").hidden && getComputedStyle(document.getElementById("credStep")).display === "none"`);
    await page.fill("#dir", "/home/demo/project"); await page.fill("#name", "agent-1");
    await page.click("#preview");
    await page.waitForFunction(() => !document.getElementById("planOut")!.hidden, null, { timeout: 10000 }).catch(() => {});
    const plan = await page.evaluate(`(() => { try { return JSON.parse(document.getElementById("planOut").textContent); } catch { return document.getElementById("planOut").textContent; } })()`);
    const finishEnabled = await page.evaluate(`!document.getElementById("finish").disabled`);
    await page.screenshot({ path: shot(c.device, "1-review"), fullPage: true });
    verdict(`${c.device} choose`, credHidden && finishEnabled && plan?.web_only === true && plan?.instance?.name === "agent-1" && Array.isArray(plan?.env_keys) && plan.env_keys.length === 0, { credHidden, finishEnabled, plan });
    const commits: string[] = [];
    page.on("request", (r: any) => { if (r.url().includes("quickstart/commit")) commits.push(r.postData() ?? ""); });
    await page.click("#finish");
    const asked = await page.waitForFunction(() => /agend settings confirm /.test(document.getElementById("finishMsg")!.textContent || ""), null, { timeout: 10000 }).then(() => true, () => false);
    const msg = await page.evaluate(`document.getElementById("finishMsg").textContent`);
    const id = /confirm (\S+)/.exec(msg)?.[1] ?? "";
    await page.screenshot({ path: shot(c.device, "2-confirm-on-host"), fullPage: true });
    const inspection: any = await requestSettingsConfirmation(dir, { action: "inspect", id });
    const decided: any = await requestSettingsConfirmation(dir, { action: "confirm", ticket: inspection.ticket });
    verdict(`${c.device} confirm`, asked && commits.length === 1 && JSON.stringify(JSON.parse(commits[0]!)) === JSON.stringify({ web_only: true, backend: JSON.parse(commits[0]!).backend, working_directory: "/home/demo/project", instance_name: "agent-1" })
      && !/token/i.test(commits[0]!) && decided?.pending_change?.state === "applied", { asked, commit: commits[0], state: decided?.pending_change?.state });
    const ready = await page.waitForFunction(() => document.getElementById("finish")!.textContent === "Start AgEnD" && !(document.getElementById("finish") as HTMLButtonElement).disabled, null, { timeout: 15000 }).then(() => true, () => false);
    await page.click("#finish");
    const starting = await page.waitForFunction(() => /AgEnD is starting/.test(document.getElementById("finishMsg")!.textContent || ""), null, { timeout: 10000 }).then(() => true, () => false);
    const startText = await page.evaluate(`document.getElementById("finishMsg").textContent`);
    await page.screenshot({ path: shot(c.device, "3-starting"), fullPage: true });
    for (let i = 0; i < 50 && !spawned; i++) await new Promise(r => setTimeout(r, 100));
    const written = existsSync(join(dir, "fleet.yaml")) ? yaml.load(readFileSync(join(dir, "fleet.yaml"), "utf8")) as any : null;
    verdict(`${c.device} start`, ready && starting && !/channel you configured/.test(startText) && spawned === 1 && !!written?.instances?.["agent-1"] && written.channel === undefined && written.channels === undefined && !existsSync(join(dir, ".env")),
      { ready, startText, spawned, instances: written && Object.keys(written.instances ?? {}), channel: written?.channel, channels: written?.channels, env: existsSync(join(dir, ".env")) });
    verdict(`${c.device} errors`, errors.length === 0, { errors });
    await ctx.close();
  } finally {
    await host.shutdown(false, "smoke done").catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
writeFileSync(join(OUT, SMOKE, `results-${ENGINE}.json`), JSON.stringify(results, null, 1));
console.log(`${failed ? "FAIL" : "PASS"} ${ENGINE}`);
await browser.close();
process.exit(failed ? 1 : 0);

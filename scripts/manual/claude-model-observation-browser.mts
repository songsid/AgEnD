/** Owned display rehearsal: real product cookie/shell/SSE/Log parser, synthetic metadata only; no CLI/API/pane. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { loadavg } from "node:os";
import { bootFixture, matrix, caseName } from "./smoke-fixture/index.mts";
import { ClaudeModelObserver, parseClaudeModelRecord } from "../../src/claude-model-observation.js";
import { deriveNeedsYou } from "../../src/needs-you.js";
const repo = resolve(process.env.REPO!), out = resolve(process.env.OUT!), base = process.env.BASELINE_REF!;
mkdirSync(out, { recursive: true });
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
if (git("status", "--porcelain", "--untracked-files=no")) throw Error("clean tracked tree required");
const head = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
const inputs = git("diff", "--name-only", base, "HEAD").split("\n").filter(p => /^(src\/|scripts\/manual\/claude-model)/.test(p));
const bindings = inputs.map(path => ({ digest: hash(readFileSync(join(repo, path))), paths: [path] }));
const fx = await bootFixture({ port: Number(process.env.HP ?? 55860), instances: 3, classic: false, webYaml: "  log_tab: true" });
const fm = fx.fm, name = "general", dir = fm.getInstanceDir(name); mkdirSync(dir, { recursive: true });
const transcript = join(dir, "session-A.jsonl");
const at = "2026-11-13T07:00:00.000Z";
const record = { type: "system", subtype: "model_refusal_fallback", sessionId: "session-A", uuid: "notice-A", timestamp: at,
  originalModel: "claude-opus-5-5", fallbackModel: "claude-opus-4-8", scope: "session", isSidechain: false };
const response = { type: "assistant", sessionId: "session-A", uuid: "record-A", timestamp: "2026-11-13T07:00:01.000Z", requestedModel: "claude-opus-4-8",
  message: { role: "assistant", id: "response-A", model: "claude-opus-4-8", content: [{ type: "text", text: "Synthetic display fixture." }], stop_reason: "end_turn" } };
let observed: any = null;
fm.fleetConfig.instances[name].model = "claude-opus-5-5";
fm.modelObservationForInstance = (target: string) => target === name ? observed : null;
fm.needsYouItems = () => deriveNeedsYou({ prompts: [], instances: [{ name, modelSwitch: observed?.active }], deliveries: [], ownerOf: () => undefined });
const publish = () => { fm.emitSseEvent("status", fm.getUiStatus()); fm.emitSseEvent("needs", { items: fm.needsYouItems() }); };
const seed = (variant: string) => {
  const r = { ...record, ...(variant === "availability" ? { subtype: "model_fallback", scope: "local" } : {}) };
  const observer = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5");
  observer.observe(parseClaudeModelRecord(r)!, "claude-opus-5-5"); observer.observe(parseClaudeModelRecord(response)!, "claude-opus-5-5");
  observed = variant === "before" ? null : observer.snapshot();
  writeFileSync(transcript, variant === "before" ? "" : [r, response].map(x => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(dir, "statusline.json"), JSON.stringify({ transcript_path: transcript, session_id: "session-A", model: { id: "claude-opus-5-5", display_name: "Opus 5.5" } }));
  return observer;
};
const cases = [
  ...matrix().map(c => ({ ...c, variant: "after" })),
  ...matrix("desk-light-zh-TW,desk-dark-zh-TW").map(c => ({ ...c, variant: "before" })),
  ...matrix("phone-light-en,phone-dark-zh-TW").map(c => ({ ...c, variant: "retained-shell" })),
  ...matrix("desk-light-en,desk-dark-zh-TW").map(c => ({ ...c, variant: "availability" })),
  ...matrix("desk-light-en").map(c => ({ ...c, variant: "retained-panels" })),
];
const partial = join(out, "partial.json");
const prior = process.env.RESUME === "1" ? JSON.parse(readFileSync(partial, "utf8")) : null;
if (prior && (prior.head !== head || prior.tree !== tree || prior.baseline !== base)) throw Error("resume capture inputs differ");
const results: any[] = prior?.results ?? [];
const saveProgress = () => writeFileSync(partial, JSON.stringify({ head, tree, baseline: base, bindings, results }, null, 2) + "\n");
try {
  for (const c of cases) {
    if (results.some(r => r.variant === c.variant && r.case === caseName(c))) continue;
    if (loadavg()[0] > 10) { saveProgress(); throw Error("host load over10; pause campaign (resume with RESUME=1)"); }
    const observer = seed(c.variant), { page, ctx, csp } = await fx.page(c);
    const errors: string[] = [], served: any[] = [], substitutions: any[] = [], reads: Promise<void>[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    page.on("response", (r: any) => { if (/\/(assets|ui\/js)\/.+\.(js|css)(\?|$)/.test(r.url()) && r.status() === 200) reads.push((async () => { served.push({ digest: hash(await r.body()), paths: [new URL(r.url()).pathname] }); })()); });
    const stale = c.variant === "retained-shell" ? ["src/ui/shared/app-i18n.js", "src/ui/shared/app-needs.js", "src/ui/shared/app.css"]
      : c.variant === "before" || c.variant === "retained-panels" ? ["src/ui/panel-details.js", "src/ui/panel-log.js", "src/ui/log-row.js", "src/ui/panel-needs.js", "src/ui/fleet-org.js", "src/ui/fleet-office-card.js", "src/ui/fleet-canvas.js"] : [];
    for (const path of stale) {
      const body = git("show", `${base}:${path}`), url = path.includes("/shared/") ? `/assets/${path.split("/").at(-1)}` : `/ui/js/${path.split("/").at(-1)}`;
      await page.route(`**${url}*`, (route: any) => route.fulfill({ status: 200, contentType: path.endsWith("css") ? "text/css" : "text/javascript", body }));
      substitutions.push({ path: url, source: `${base}:${path}`, digest: hash(body) });
    }
    const checks: any[] = [];
    const checkpoint = async (label: string, path: string, expectLine: boolean, prepare?: () => Promise<void>) => {
      await page.goto(fx.base + path); await page.waitForTimeout(650); if (prepare) await prepare(); await page.evaluate(() => document.fonts.ready);
      const word = c.lang === "en" ? c.variant === "availability" ? "Model switched due to availability" : "Model switched by safeguards" : c.variant === "availability" ? "模型因供應狀況而切換" : "安全機制已切換模型";
      if (expectLine) {
        try { await page.waitForFunction(value => document.body.innerText.includes(value), word, { timeout: 5000 }); }
        catch {
          writeFileSync(join(out, "diagnostic.json"), JSON.stringify({ case: caseName(c), variant: c.variant, label, url: page.url(), errors, expected: observed, actual: (fm.getUiStatus() as any).instances?.find((x: any) => x.name === name)?.model_observation, body: (await page.locator("body").innerText()).slice(0, 12000) }, null, 2));
          await page.screenshot({ path: join(out, "diagnostic.png"), fullPage: true });
          throw Error(`${c.variant}/${label}: missing ${word}`);
        }
      }
      if (label === "details" && expectLine && c.device === "phone") await page.locator(".p-details .model-switch").scrollIntoViewIfNeeded();
      if (label === "log" && expectLine) {
        const pair = page.locator(".log-text").filter({ hasText: "Opus 5.5 → Opus 4.8" });
        if (await pair.count() !== 1) throw Error("model pair must be in wrapping Log text");
        const fits = await pair.evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1);
        if (!fits) throw Error("model pair is clipped");
      }
      const geometry = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth,
        lines: [...document.querySelectorAll(".model-switch, .needs-item, .log-row")].map(el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, text: el.textContent }; }) }));
      if (geometry.overflow > 1) throw Error(`overflow ${JSON.stringify(geometry)}`);
      const file = `${c.variant}-${caseName(c)}-${label}.png`; await page.screenshot({ path: join(out, file), fullPage: true });
      checks.push({ label, file, geometry });
    };
    const visible = c.variant !== "before" && c.variant !== "retained-panels";
    await checkpoint("details", `/ui/fleet/agent/${name}`, visible);
    if (c.variant !== "before") {
      await checkpoint("needs", "/ui/needs", visible);
      await checkpoint("log", `/ui/log/${name}`, visible);
    }
    if (c.variant === "after" && c.device === "desk") {
      await page.addInitScript(() => localStorage.setItem("agend_org_mode", "list"));
      await checkpoint("card", "/ui/fleet/org", true);
    }
    if (c.variant === "after") {
      await checkpoint("office-card", "/ui/fleet/org", true, async () => {
        await page.getByRole("button", { name: c.lang === "en" ? "Office" : "辦公室", exact: true }).click();
        const desk = page.locator(`.oo-desk[data-name="${name}"]`); await desk.waitFor({ state: "attached" });
        await desk.focus(); await desk.press("Enter"); await page.waitForSelector(".oo-card .model-switch");
      });
      await page.goto(fx.base + `/ui/fleet/agent/${name}`); await page.waitForSelector(".model-switch");
      observer.observe(parseClaudeModelRecord({ ...response, uuid: "recovery", timestamp: "2026-11-13T07:00:02.000Z", message: { ...response.message, id: "recovery", model: "claude-opus-5-5" } })!, "claude-opus-5-5");
      observed = observer.snapshot(); publish(); await page.waitForFunction(() => !document.querySelector(".model-switch"));
      checks.push({ label: "recovery-without-reload", active: observed.active, lastServed: observed.lastServed, needs: fm.needsYouItems().length });
    }
    if (errors.length || (await csp()).length) throw Error(JSON.stringify({ errors, csp: await csp() }));
    await Promise.all(reads);
    results.push({ variant: c.variant, case: caseName(c), checks, substitutions, served }); await ctx.close(); saveProgress();
  }
} finally { await fx.close(); }
if (git("rev-parse", "HEAD") !== head || git("status", "--porcelain", "--untracked-files=no")) throw Error("source changed during capture");
writeFileSync(join(out, "receipt.json"), JSON.stringify({ head, tree, baseline: base, bindings, results,
  scope: "Owned scratch home, real cookie/app/SSE/Log reader and parser. Synthetic typed metadata, read-only model/Needs projections. Baseline UI asset substitutions are explicit; no vendor call, CLI, live pane, real transcript or automatic model/policy operation. Retained panels show legacy pair text; retained shell means the three listed old assets, not an all-old loaded tab." }, null, 2) + "\n");
console.log(JSON.stringify({ cases: results.length, screenshots: results.flatMap(r => r.checks).filter(c => c.file).length, cleanup: "owned browser/listeners/home closed" }));
process.exit(0);

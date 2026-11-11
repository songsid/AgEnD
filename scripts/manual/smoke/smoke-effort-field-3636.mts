// #3636 PR 2 (AGEND-177): Settings → agent → Runtime & model gets a reasoning-effort field beside the model, in a real
// browser on the shared fixture (the product's own web server, a scratch home, no fleet start). One claude-code agent
// runs claude-opus-4-6; the scratch home's claude catalog (cli-env/claude-code.json) gives each model its effort levels.
//   1 — the card: Model default first, then that model's levels (before: no effort field);
//   2 — the model field moved to another model: its levels replace them, the field waits for Save (disabled + a note);
//   3 — a choice applied (high): the field shows it, and the label says it takes effect now.
// LABEL=base: the before picture of the card only (the code before this change).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [LABEL=base|branch] [MATRIX=full] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx tsx scripts/manual/smoke/smoke-effort-field-3636.mts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-effort-field-3636";
const LABEL = process.env.LABEL ?? "branch", BASE = LABEL === "base";
const r: Record<string, unknown> = { label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const fx = await bootFixture({ port: 47480, instances: 6 });
try {
  const agent = fx.instances.find(i => i.backend === "claude-code" && !i.general)!.name;
  // The page reads fleet.yaml: the model goes in the file, and the fleet reads it again.
  const file = join(fx.dir, "fleet.yaml"), key = `  ${JSON.stringify(agent)}:\n`;
  writeFileSync(file, readFileSync(file, "utf8").replace(key, `${key}    model: claude-opus-4-6\n`));
  fx.fm.loadConfig(file);
  const inst = fx.fm.fleetConfig.instances[agent];
  const lv = (...l: string[]) => l;
  mkdirSync(join(fx.dir, "cli-env"), { recursive: true });
  const models = [
    { id: "claude-opus-4-6", label: "Claude Opus 4.6", effortLevels: lv("low", "medium", "high", "max") },
    { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5", effortLevels: lv("low", "medium", "high") },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", effortLevels: [] },
  ];
  writeFileSync(join(fx.dir, "cli-env", "claude-code.json"), JSON.stringify({ backend: "claude-code", probedAt: Date.now(), models, apiModels: models }));
  // What the chip's /effort would do on a running agent, without a CLI: the same config write applyEffort makes.
  fx.fm.applyEffort = async (name: string, level: string) => { fx.fm.fleetConfig.instances[name].effort = level; return `${name}: effort ${level}`; };
  for (const c of matrix()) {
    const cn = caseName(c), zh = c.lang === "zh-TW";
    delete inst.effort;
    const { ctx, page, csp } = await fx.page(c, { path: `/ui/fleet/agent/${encodeURIComponent(agent)}?cat=runtime` });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.waitForSelector("#ag-model", { timeout: 15000 }); await page.waitForTimeout(900);
    const card = page.locator("section.card", { has: page.locator("#ag-model") });
    const shot = async (name: string) => { await card.scrollIntoViewIfNeeded(); await page.waitForTimeout(250); await card.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-${name}`) }); };
    const effort = () => page.evaluate(`(() => { const s = document.querySelector("#ag-effort"); return s ? { value: s.value, disabled: s.disabled, options: [...s.options].map((o) => o.textContent.trim()), optionDisabled: [...s.options].map((o) => o.disabled),
      label: s.closest(".field").querySelector(".s-lab")?.innerText.replace(/\\s+/g, " ") ?? "", note: s.closest(".field").querySelector(".note")?.textContent ?? "" } : null; })()`) as Promise<any>;
    await shot("1-card");
    const first = await effort();
    if (BASE) { r[cn] = { first, errs, csp: await csp() }; await ctx.close(); continue; }
    // 2: the model field moves to another model.
    await page.selectOption("#ag-model", "claude-opus-4-5-20251101"); await page.waitForTimeout(900);
    const moved = await effort(); await shot("2-model-moved");
    await page.selectOption("#ag-model", "claude-opus-4-6"); await page.waitForTimeout(900);
    r[`${cn}:back`] = { model: await page.inputValue("#ag-model"), effort: await effort() };
    // 3: a choice, applied at once.
    await page.selectOption("#ag-effort", "high", { timeout: 5000 }); await page.waitForTimeout(1200);
    const chosen = await effort(); await shot("3-chosen");
    // 4: the ⓘ of the field open: what it says about applying (a restart for some CLIs).
    await page.locator("#ag-effort").locator("xpath=ancestor::div[contains(@class,'field')][1]").locator(".s-lab button").click(); await page.waitForTimeout(400);
    const tip = await page.evaluate(`(() => { const w = document.querySelector("#ag-effort").closest(".field").querySelector(".s-tipwrap"); return w ? w.textContent : null; })()`) as string | null;
    await shot("4-tip");
    const staged = await page.evaluate(`document.querySelector(".s-pending, .pending-bar, [data-pending]")?.textContent ?? ""`);
    const got = { first, moved, chosen, tip, staged, errs, csp: await csp(), pageX: await page.evaluate("document.documentElement.scrollWidth - innerWidth") };
    check(cn, !!first && first.options[0] === (zh ? "模型預設" : "Model default") && first.options.slice(1).join() === "low,medium,high,max" && first.value === "" && first.disabled === false
      && !!moved && moved.options.slice(1).join() === "low,medium,high" && moved.disabled === true && moved.note.length > 0
      && !!chosen && chosen.value === "high" && chosen.optionDisabled[0] === true && inst.effort === "high" && !!tip && tip.includes(zh ? "重啟" : "restart") && errs.length === 0 && (got.csp as string[]).length === 0 && got.pageX <= 0, got);
    r[`${cn}:detail`] = got;
    await ctx.close();
  }
  // SKEW. (a) a new page on an OLD daemon (no /ui/effort-options): the card is as before, no error. (b) a tab kept across the
  // upgrade: the OLD shared shell (/assets) under these modules draws the field all the same. (c) the OLD agent-page strings
  // module under the new code (an old tab's cached file): no field text is missing a word, no error.
  if (!BASE) {
    const { execFileSync } = await import("node:child_process");
    const REPO = process.env.REPO!, OLD = process.env.OLD_REF ?? "upstream/release/2.3.5-alpha";
    const old = (f: string) => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD}:src/ui/${f}`], { encoding: "utf8", maxBuffer: 64 << 20 }); } catch { return null; } };
    for (const way of ["old-daemon", "old-shell", "old-strings"]) {
      const c = matrix("desk-light-en")[0]!;
      delete inst.effort;
      const { ctx, page } = await fx.page(c, { path: `/ui/fleet/agent/${encodeURIComponent(agent)}?cat=runtime` });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      const served = new Set<string>();
      if (way === "old-daemon") await page.route(/\/ui\/effort-options/, (route: any) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
      if (way === "old-shell") await page.route("**/assets/**", (route: any) => { const f = new URL(route.request().url()).pathname.replace(/^\/assets\//, ""); const body = old(`shared/${f}`);
        if (body === null) return route.continue(); served.add(f); return route.fulfill({ status: 200, contentType: f.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body }); });
      if (way === "old-strings") await page.route(/\/ui\/js\/agent-page-strings\.js/, (route: any) => { served.add("agent-page-strings.js"); return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: old("agent-page-strings.js")! }); });
      await page.goto(`${fx.base}/ui/fleet/agent/${encodeURIComponent(agent)}?cat=runtime`); await page.waitForSelector("#ag-model", { timeout: 15000 }); await page.waitForTimeout(900);
      const card = page.locator("section.card", { has: page.locator("#ag-model") }); await card.scrollIntoViewIfNeeded();
      await card.screenshot({ path: shotPath(SMOKE, `skew-${way}`, `${LABEL}-card`) });
      const field = await page.evaluate(`(() => { const s = document.querySelector("#ag-effort"); return s ? { options: [...s.options].map((o) => o.textContent.trim()), label: s.closest(".field").querySelector(".s-lab")?.innerText ?? "" } : null; })()`) as any;
      // old-daemon: no field; old-shell: the field; old-strings: the field, its words missing (the key shows) but nothing throws.
      check(`skew-${way}`, errs.length === 0 && (way === "old-daemon" ? field === null : field !== null && field.options.length >= 2) && (way === "old-daemon" || way === "old-strings" || served.size > 0), { field, served: [...served], errs });
      await ctx.close();
    }
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  mkdirSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE), { recursive: true });
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : BASE ? "RECORDED" : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}

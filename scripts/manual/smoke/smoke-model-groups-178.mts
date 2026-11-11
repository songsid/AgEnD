// AGEND-158 PR 3 (AGEND-178): Settings → agent → Runtime & model's model list, in a real browser on the shared fixture
// (the product's own web server, a scratch home, no fleet start). Two agents: a claude-code one on claude-opus-4-6 and an
// antigravity one whose saved model is a "-high" slug. The scratch catalogs (cli-env/*.json) are the shape of the
// probe's cache as an earlier daemon wrote it: claude's account catalog with a [1m] after EVERY model, each with the
// window the account API reported (modelled on one Team account's listing, not live data); agy's `agy models` as agy 1.5.5
// printed it (16 slugs). The model <select> is drawn open (size=N) so the picture shows the whole list.
//   1 — claude: the list (before: aliases and a [1m] for every model in one run; after: the account's models, then the [1m] that
//       can work — here Opus 4.6's and Sonnet 4.6's — under "1M context");
//   2 — antigravity: the list (before: 16 slugs; after: one entry per model, the saved level shows as its model);
//   3 — (branch) choosing an antigravity model: its slug is written (the medium one) and the effort field follows;
//   4 — claude with no account list readable (the cache holds only the CLI's aliases): the documentation's ids, marked
//       "Not checked against this account", and no alias (before: the aliases alone).
// LABEL=base: the before pictures only (the code before this change).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [LABEL=base|branch] [MATRIX=full] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx tsx scripts/manual/smoke/smoke-model-groups-178.mts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-model-groups-178";
const OTHER = "\u0000other";
const LABEL = process.env.LABEL ?? "branch", BASE = LABEL === "base";
const r: Record<string, unknown> = { label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const fx = await bootFixture({ port: 47490, instances: 14 });
try {
  const claude = fx.instances.find(i => i.backend === "claude-code" && !i.general)!.name;
  const agy = fx.instances.find(i => i.backend === "antigravity")!.name;
  const file = join(fx.dir, "fleet.yaml");
  let yaml = readFileSync(file, "utf8");
  for (const [name, model] of [[claude, "claude-opus-4-6"], [agy, "claude-opus-5-5-high"]] as const) { const key = `  ${JSON.stringify(name)}:\n`; yaml = yaml.replace(key, `${key}    model: ${model}\n`); }
  writeFileSync(file, yaml);
  fx.fm.loadConfig(file);
  mkdirSync(join(fx.dir, "cli-env"), { recursive: true });
  const M = 1_000_000, K200 = 200_000;
  const account: Array<[string, string, number]> = [
    ["claude-fable-5-2", "Claude Fable 5.2", M], ["claude-fable-5-1", "Claude Fable 5.1", M], ["claude-opus-5-5", "Claude Opus 5.5", M], ["claude-sonnet-5-5", "Claude Sonnet 5.5", M],
    ["claude-haiku-5-5", "Claude Haiku 5.5", M], ["claude-opus-5", "Claude Opus 5", M], ["claude-sonnet-5", "Claude Sonnet 5", M], ["claude-opus-4-8", "Claude Opus 4.8", M],
    ["claude-opus-4-7", "Claude Opus 4.7", M], ["claude-opus-4-6", "Claude Opus 4.6", M], ["claude-sonnet-4-6", "Claude Sonnet 4.6", M],
    ["claude-opus-4-5-20251101", "Claude Opus 4.5", K200], ["claude-haiku-4-5-20251001", "Claude Haiku 4.5", K200],
  ];
  const apiModels = account.flatMap(([id, name, tokens]) => [
    { id, label: id, description: name, maxInputTokens: tokens },
    { id: `${id}[1m]`, label: `${id}[1m]`, description: "1M context — plan-dependent", maxInputTokens: tokens },
  ]);
  const aliases = [{ id: "default", label: "default", description: "account default" }, { id: "sonnet", label: "sonnet" }, { id: "opus", label: "opus" }, { id: "haiku", label: "haiku" },
    { id: "opusplan", label: "opusplan", description: "opus plans, sonnet executes" }, { id: "Fable", label: "Fable", description: "Claude Fable 5" }];
  writeFileSync(join(fx.dir, "cli-env", "claude-code.json"), JSON.stringify({ backend: "claude-code", probedAt: Date.now(), models: aliases, apiModels }));
  const agyOut = readFileSync(new URL("../../../tests/fixtures/agy-1.3.5-audit/agy-models.stdout.txt", import.meta.url), "utf8");
  const agyModels = agyOut.split("\n").filter(Boolean).map(l => { const [id, label] = l.split("\t"); return { id, label }; });
  // agy 1.5.5 added the two Gemini 4 models (the audited 1.3.5 file has the rest).
  for (const base of ["gemini-4-carbon", "gemini-4-argon"]) for (const lv of ["medium", "high", "low"]) agyModels.unshift({ id: `${base}-${lv}`, label: `${base === "gemini-4-carbon" ? "Gemini 4 Carbon" : "Gemini 4 Argon"} (${lv[0]!.toUpperCase()}${lv.slice(1)})` });
  writeFileSync(join(fx.dir, "cli-env", "antigravity.json"), JSON.stringify({ backend: "antigravity", probedAt: Date.now(), version: "1.5.5", models: agyModels, effortLevels: ["low", "medium", "high"] }));
  fx.fm.backendAvailabilityRows = () => [{ backend: "claude-code", state: "usable", version: "2.1.322", path: "/usr/bin/claude", minVersion: "2.1.0" }];
  const claudeFile = join(fx.dir, "cli-env", "claude-code.json");
  for (const c of matrix()) {
    const cn = caseName(c);
    for (const [step, name, backend] of [["1-claude", claude, "claude-code"], ["2-agy", agy, "antigravity"], ["4-claude-nolist", claude, "claude-code"]] as const) {
      const nolist = step === "4-claude-nolist";
      writeFileSync(claudeFile, JSON.stringify({ backend: "claude-code", probedAt: Date.now(), models: aliases, apiModels: nolist ? [] : apiModels }));
      const { ctx, page, csp } = await fx.page(c, { path: `/ui/fleet/agent/${encodeURIComponent(name)}?cat=runtime` });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      await page.waitForSelector("#ag-model", { timeout: 15000 });
      await page.waitForFunction(`document.querySelectorAll("#ag-model option").length > 3`, null, { timeout: 15000 }); await page.waitForTimeout(700);
      const list = () => page.evaluate(`(() => { const s = document.querySelector("#ag-model"); return { value: s.value, groups: [...s.querySelectorAll("optgroup")].map((g) => ({ label: g.label, options: [...g.querySelectorAll("option")].map((o) => o.value) })),
        options: [...s.options].map((o) => ({ value: o.value, text: o.textContent.trim() })) }; })()`) as Promise<any>;
      // Open the list: a native <select> popup is not in a screenshot, so the same select is drawn as a list box.
      const open = async () => { await page.evaluate(`(() => { const s = document.querySelector("#ag-model"); s.size = Math.min(s.options.length + s.querySelectorAll("optgroup").length, 40); })()`); await page.waitForTimeout(250); };
      const card = page.locator("section.card", { has: page.locator("#ag-model") });
      const shot = async (n: string) => { await open(); await card.scrollIntoViewIfNeeded(); await card.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-${n}`) }); };
      const first = await list(); await shot(step);
      if (BASE) { r[`${cn}:${step}`] = { first, errs, csp: await csp() }; await ctx.close(); continue; }
      const texts = first.options.map((o: any) => o.text);
      if (backend === "claude-code") {
        const zh = c.lang === "zh-TW";
        const values = first.options.map((o: any) => o.value);
        if (nolist) {
          check(`${cn}:claude-nolist`, first.groups.length === 1 && first.groups[0].label === (zh ? "尚未確認此帳號可用" : "Not checked against this account") && first.groups[0].options.every((v: string) => v.startsWith("claude-"))
            && first.groups[0].options.length > 0 && !values.some((v: string) => ["default", "opus", "sonnet", "haiku", "Fable", "opusplan"].includes(v)) && errs.length === 0, { first, errs });
        } else {
          check(`${cn}:claude`, first.groups.length === 1 && first.groups[0].label === (zh ? "1M context（需訂閱／方案支援）" : "1M context (plan-dependent)") && first.groups[0].options.join() === "claude-opus-4-6[1m],claude-sonnet-4-6[1m]"
            && values.join() === ["", ...account.map(a => a[0]), "claude-opus-4-6[1m]", "claude-sonnet-4-6[1m]", OTHER].join() && values.filter((v: string) => v.endsWith("[1m]")).length === 2
            && !values.some((v: string) => ["default", "opus", "sonnet", "haiku", "Fable", "opusplan"].includes(v)) && first.value === "claude-opus-4-6" && errs.length === 0 && (await csp()).length === 0, { first, errs });
        }
      } else {
        // 3: choosing another model writes its (medium) slug; the effort field follows with that model's levels.
        const shown = texts.filter((t: string) => !["Other…", "其他…"].includes(t) && !/^(inherit|CLI)/.test(t));
        await page.selectOption("#ag-model", "gemini-3.8-flash-medium"); await page.waitForTimeout(1500);
        const after = await page.evaluate(`(async () => ({ model: document.querySelector("#ag-model").value, effort: [...(document.querySelector("#ag-effort")?.options ?? [])].map((o) => o.textContent.trim()),
          api: await (await fetch("/ui/effort-options?instance=${name}&model=gemini-3.8-flash-medium")).text() }))()`) as any;
        await shot("3-chosen");
        check(`${cn}:agy`, first.value === "claude-opus-5-5-high" && first.groups.length === 0 && shown.some((t: string) => t.startsWith("Claude Opus 5.5") && !/\((Low|Medium|High)\)/i.test(t))
          && first.options.filter((o: any) => /-(low|medium|high)$/.test(o.value)).length === 6 && after.model === "gemini-3.8-flash-medium" && after.effort.join().includes("low,medium,high") && errs.length === 0, { first, after, errs });
        r[`${cn}:agy:detail`] = { first: texts, after };
      }
      r[`${cn}:${step}:list`] = first.groups.length ? first.groups : first.options.map((o: any) => o.text);
      await ctx.close();
    }
  }
  // SKEW (desk-light-en). (a) a new page on an OLD daemon (/ui/models without groups or merged levels): the list is flat, no error.
  // (b) a tab kept across the upgrade: the OLD shared shell (/assets) under these modules. (c) an old tab's cached settings-catalog /
  // settings-dialogs modules reading the NEW daemon's list (its extra `group` / `aliases` fields): no error, every model listed once,
  // a saved antigravity level not in the merged list shows marked as the current value.
  if (!BASE) {
    writeFileSync(claudeFile, JSON.stringify({ backend: "claude-code", probedAt: Date.now(), models: aliases, apiModels }));
    const { execFileSync } = await import("node:child_process");
    const REPO = process.env.REPO!, OLD = process.env.OLD_REF ?? "origin/improve/effort-dropdown-settings";
    const old = (f: string) => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD}:src/ui/${f}`], { encoding: "utf8", maxBuffer: 64 << 20 }); } catch { return null; } };
    for (const [way, name] of [["old-daemon", claude], ["old-shell", claude], ["old-modules", claude], ["old-modules-agy", agy]] as const) {
      const c = matrix("desk-light-en")[0]!;
      const { ctx, page } = await fx.page(c, { path: `/ui/fleet/agent/${encodeURIComponent(name)}?cat=runtime` });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      const served = new Set<string>();
      if (way === "old-daemon") await page.route(/\/ui\/models\?/, (route: any) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ backend: "claude-code", models: [...aliases, ...apiModels] }) }));
      if (way === "old-shell") await page.route("**/assets/**", (route: any) => { const f = new URL(route.request().url()).pathname.replace(/^\/assets\//, ""); const body = old(`shared/${f}`);
        if (body === null) return route.continue(); served.add(f); return route.fulfill({ status: 200, contentType: f.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body }); });
      if (way.startsWith("old-modules")) await page.route(/\/ui\/js\/settings-(catalog|dialogs)\.js/, (route: any) => { const f = new URL(route.request().url()).pathname.split("/").pop()!; served.add(f);
        return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: old(f)! }); });
      await page.goto(`${fx.base}/ui/fleet/agent/${encodeURIComponent(name)}?cat=runtime`); await page.waitForSelector("#ag-model", { timeout: 15000 });
      await page.waitForFunction(`document.querySelectorAll("#ag-model option").length > 3`, null, { timeout: 15000 }); await page.waitForTimeout(700);
      const card = page.locator("section.card", { has: page.locator("#ag-model") });
      await page.evaluate(`(() => { const s = document.querySelector("#ag-model"); s.size = Math.min(s.options.length + s.querySelectorAll("optgroup").length, 40); })()`);
      await card.scrollIntoViewIfNeeded(); await card.screenshot({ path: shotPath(SMOKE, `skew-${way}`, `${LABEL}-card`) });
      const got = await page.evaluate(`(() => { const s = document.querySelector("#ag-model"); return { value: s.value, groups: s.querySelectorAll("optgroup").length, options: [...s.options].map((o) => o.value) }; })()`) as any;
      const once = new Set(got.options).size === got.options.length;
      check(`skew-${way}`, errs.length === 0 && once && got.options.length > 4 && (way === "old-shell" ? got.groups === 1 && !got.options.some((v: string) => v === "opus") && served.size > 0 : way === "old-daemon" ? got.groups === 0 && got.options.includes("claude-opus-4-5-20251101[1m]") && got.options.includes("opus")
        : got.groups === 0 && served.size === 2) && (way === "old-modules-agy" ? got.value === "claude-opus-5-5-high" : true), { got: { ...got, options: got.options.length }, served: [...served], errs });
      r[`skew-${way}:detail`] = { groups: got.groups, value: got.value, options: got.options.length, served: [...served] };
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

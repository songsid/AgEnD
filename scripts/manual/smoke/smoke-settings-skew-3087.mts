// #3087 review (SKEW acceptance): Settings → Shared agent settings in a tab kept open across an upgrade, both ways.
//   fresh        — this checkout's UI as served (the baseline: every control, tooltip and save works).
//   stale-shell  — a tab opened before the upgrade: the OLD shell (app.js, app-shell.js, app-stream.js, app.css and
//                  instance-nav.js, plus every shell file this branch changed, from BASE) that then lazily loads the NEW
//                  Settings panel. Same method as smoke-settings-stale-2978.mts.
//   old-page     — the other way: the NEW shell with the OLD lazy Settings modules (every /ui/js file this branch changed that
//                  exists at BASE, from BASE), as when the browser kept an earlier copy of the lazy chunk.
// Matrix: en and zh-TW × desk and phone × the three modes (12 cases). Per case (new page: fresh, stale-shell):
//   the page and its groups render in the right language; "partly custom" on the dashboard pill and the hover that lists who
//   sets which item; the ⓘ tooltip opens inside the window and closes on Escape; the pill hover names the ClassicBot rooms
//   that follow the model; an edit to auto-pause names the rooms it restarts (and the note goes away when the field is put
//   back); no raw translation key or unfilled {0} anywhere on the page; saving tool progress sends exactly its own body and
//   asks nobody; saving a project folder goes through the confirmation path (202 pending_confirmation, a request to follow) and sends exactly its own body;
//   no page error. old-page: the old page really is the one served, and the same two saves keep their bodies and confirmation.
// The stale and old copies are proven, not assumed: stale-shell asserts the loaded stylesheet lacks a rule the branch added;
// every swapped URL must be requested at least once in its case (swapped-urls-requested), so a file list that goes stale — a file
// renamed, a swap the page never loads — fails the case instead of passing without testing anything; the counts are in the receipt.
// A receipt (receipt.md + result.json) names the commit, whether the tree was clean, the command, the swapped files and each case.
// The old copies are read straight from git (`git show BASE:src/ui/…`), so BASE must be fetched; BASE defaults to the branch's base,
// upstream/release/2.3.5-alpha (v2.3.5-alpha.4). Run it on a clean checkout of the commit to be judged. CASES=<names> runs a subset.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [BASE=<ref>] [CASES=desk-en-fresh,…] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//     npx --prefix <checkout> tsx scripts/manual/smoke/smoke-settings-skew-3087.mts
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-settings-skew-3087";
const REPO = process.env.REPO ?? process.cwd();
const BASE = process.env.BASE ?? "upstream/release/2.3.5-alpha";
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
const head = git("rev-parse", "HEAD").trim(), baseSha = git("rev-parse", BASE).trim();
const dirty = git("status", "--porcelain").trim();
const atBase = (p: string) => spawnSync("git", ["-C", REPO, "cat-file", "-e", `${BASE}:${p}`]).status === 0;
const oldBody = (p: string) => git("show", `${BASE}:${p}`);
const newBody = (p: string) => readFileSync(join(REPO, p), "utf8");

// ── Which files are old in which direction ──
const SHELL_ALWAYS = ["app.js", "app-shell.js", "app-stream.js", "app.css", "instance-nav.js"].map(f => `src/ui/shared/${f}`);
const changed = git("diff", "--name-only", BASE, "HEAD", "--", "src/ui").split("\n").filter(Boolean).filter(p => /^src\/ui\/(shared\/)?[a-z0-9._-]+\.(js|css)$/.test(p));
const shared = (p: string) => p.startsWith("src/ui/shared/");
const urlOf = (p: string) => (shared(p) ? `/assets/${p.slice("src/ui/shared/".length)}` : `/ui/js/${p.slice("src/ui/".length)}`);
const staleShell = [...new Set([...SHELL_ALWAYS, ...changed.filter(shared)])].filter(atBase);
const oldPage = changed.filter(p => !shared(p) && atBase(p));
const MODES = { fresh: [] as string[], "stale-shell": staleShell, "old-page": oldPage } as const;
type Mode = keyof typeof MODES;
// A rule the branch added to app.css: the stale shell's stylesheet must not have it (that is what makes it stale).
const addedClass = [...new Set(newBody("src/ui/shared/app.css").match(/\.s-[a-z0-9-]+/g) ?? [])].find(c => !oldBody("src/ui/shared/app.css").includes(c));

// ── What the page says ──
const X = {
  en: { title: "Shared agent settings", hangSub: "except the hang detector, which an agent can also set for itself", partly: /partly custom/, office: /Office/, rooms: /ClassicBot room\(s\) follow this value too/,
    roomNote: /4 ClassicBot room\(s\)/, confirmTick: /confirmed first/ },
  "zh-TW": { title: "Agent 共用設定", hangSub: "只有卡住偵測可以另外在個別 Agent 設定", partly: /部分自訂/, office: /辦公室/, rooms: /ClassicBot 房間也沿用這個值/,
    roomNote: /4 個 ClassicBot 房間/, confirmTick: /先確認/ },
} as const;
const RAW_KEY = /\bsettings\.[A-Za-z][A-Za-z0-9_]*|\{\d+\}|\bundefined\b|\[object Object\]/;

const fx = await bootFixture({ port: Number(process.env.HP ?? 48957), classic: true, instances: 3 });
const fm = fx.fm as any;
const token = fm.getDashboardAccess().token as string;
const hostCode = async () => (await (await fetch(`${fx.base}/auth/issue-code`, { method: "POST", headers: { "x-agend-token": token, origin: fx.base } })).json()).code as string;
{
  const file = join(fx.dir, "fleet.yaml"), yaml = readFileSync(file, "utf8");
  // An explicit `defaults:` (the fixture's file has none, and a defaults save into a file without one is refused as sharing a
  // value with the instances) and one agent that sets only the Office switch.
  writeFileSync(file, `defaults:\n  backend: claude-code\n  tool_progress: standard\n  auto_pause_after: 30\n${yaml.replace(/^(    working_directory: .*)$/m, "$1\n    office_access: true")}`);
  fm.loadConfig(file);                                   // the page reads the raw config the fleet loaded
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Check = { ok: boolean; detail?: string };
interface CaseResult { name: string; lang: string; device: string; mode: Mode; ok: boolean; checks: Record<string, Check>; swappedHits: Record<string, number>; writes: Array<{ method: string; path: string; status: number | null; body: unknown; response: string }> }
const results: CaseResult[] = [];
let rootSeq = 0;

for (const lang of ["en", "zh-TW"] as const) for (const dev of [{ device: "desk", width: 1366, height: 900 }, { device: "phone", width: 390, height: 844 }] as const) for (const mode of Object.keys(MODES) as Mode[]) {
  const name = `${dev.device}-${lang}-${mode}`, x = X[lang];
  if (process.env.CASES && !process.env.CASES.split(",").includes(name)) continue;   // CASES=desk-en-fresh,phone-zh-TW-old-page: a subset while iterating
  const checks: Record<string, Check> = {};
  const check = (k: string, ok: boolean, detail?: string) => { checks[k] = { ok, ...(detail === undefined ? {} : { detail }) }; };
  // Language and theme are host preferences: set them on the host, as the fixture's own page() does.
  fm.webPrefs.write("operator", new Map<string, unknown>([...Object.keys(fm.webPrefs.read("operator").values ?? {}).map(k => [k, null] as [string, null]), ["theme", "light"], ["lang", lang]]));
  const ctx = await fx.browser.newContext({ viewport: { width: dev.width, height: dev.height }, isMobile: dev.device === "phone", hasTouch: dev.device === "phone", locale: lang === "zh-TW" ? "zh-TW" : "en-US" });
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done","1"); localStorage.setItem("agend_firstrun_dismissed","1"); localStorage.setItem("agend_lang","${lang}"); } catch {}` });
  const page = await ctx.newPage(), errors: string[] = [], hits: Record<string, number> = {};
  const writes: CaseResult["writes"] = [];
  page.on("pageerror", (e: any) => errors.push(String(e)));
  page.on("console", (m: any) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on("response", async (r: any) => {
    const q = r.request(), u = new URL(r.url());
    if (q.method() !== "GET" && /^\/(api\/settings|ui\/config)/.test(u.pathname)) writes.push({ method: q.method(), path: u.pathname, status: r.status(), body: (() => { try { return JSON.parse(q.postData() ?? "null"); } catch { return q.postData(); } })(), response: (await r.text().catch(() => "")).slice(0, 300) });
  });
  for (const p of MODES[mode]) {
    const url = urlOf(p), body = oldBody(p); hits[url] = 0;
    await page.route(`**${url}*`, (r: any) => { hits[url]++; r.fulfill({ status: 200, contentType: url.endsWith(".css") ? "text/css" : "text/javascript", body }); });
  }
  const t = (sel: string) => page.locator(sel);
  const field = (id: string) => t(`#${id}`).locator("xpath=ancestor-or-self::*[contains(concat(' ', normalize-space(@class), ' '), ' field ')][1]");
  try {
    await page.goto(`${fx.base}/signin`); await page.waitForSelector("#code");
    await page.fill("#code", await hostCode()); await page.click("#go"); await page.waitForURL(`${fx.base}/ui`);
    if (mode === "stale-shell" && addedClass) {
      const has = await page.evaluate((c: string) => [...document.styleSheets].some(s => { try { return [...s.cssRules].some((r: any) => (r.selectorText ?? "").includes(c)); } catch { return false; } }), addedClass);
      check("shell-is-stale", !has, `loaded app.css ${has ? "HAS" : "lacks"} ${addedClass} (a rule the branch added)`);
    } else if (mode === "fresh" && addedClass) {
      const has = await page.evaluate((c: string) => [...document.styleSheets].some(s => { try { return [...s.cssRules].some((r: any) => (r.selectorText ?? "").includes(c)); } catch { return false; } }), addedClass);
      check("shell-is-new", has, `loaded app.css ${has ? "has" : "LACKS"} ${addedClass}`);
    }
    // In-page navigation: a tab keeps the shell it loaded and fetches the Settings panel lazily.
    await page.evaluate((path: string) => { history.pushState(null, "", path); dispatchEvent(new PopStateEvent("popstate")); }, "/settings/agent-defaults");
    await page.waitForSelector(".p-settings #g-model", { timeout: 20000 });
    await sleep(600);
    const newPage = (await t(".p-settings .s-shared").count()) === 1;
    check(mode === "old-page" ? "old-page-is-served" : "new-page-renders", mode === "old-page" ? !newPage : newPage, newPage ? ".s-shared present" : ".s-shared absent");
    check("no-error-state", (await t(".p-settings .error-state, .p-settings [role=alert].error").count()) === 0);
    await page.screenshot({ path: shotPath(SMOKE, name, "page"), fullPage: true });

    if (newPage) {
      check("language", ((await t(".p-settings .s-group h3").first().textContent()) ?? "").trim() === x.title, x.title);
      await t("details.drawer > summary").click();
      check("advanced-subtitle", ((await t(".s-group p.note").last().textContent()) ?? "").includes(x.hangSub), x.hangSub);
      // "Partly custom": one agent sets only the Office switch — the pill says so and the hover lists who sets which item.
      const dashPill = t("#g-dash .s-use .s-tipbtn");
      const pillText = ((await dashPill.textContent()) ?? "").trim();
      check("dashboard-partly-custom", x.partly.test(pillText), pillText);
      await dashPill.click();
      const dashTip = ((await t("#g-dash .s-use .s-tipbody").textContent()) ?? "").trim();
      check("dashboard-hover-per-item", x.office.test(dashTip) && (await t("#g-dash .s-use .s-tipbody").isVisible()), dashTip);
      await page.keyboard.press("Escape");
      // The ⓘ tooltip opens inside the window and closes on Escape.
      const info = field("g-be").locator(".s-i .s-tipbtn");
      await info.scrollIntoViewIfNeeded(); await info.click();
      const body = field("g-be").locator(".s-i .s-tipbody");
      const box = await body.boundingBox(), vis = await body.isVisible();
      const inside = !!box && box.x >= 0 && box.x + box.width <= dev.width + 1;
      await page.screenshot({ path: shotPath(SMOKE, name, "tooltip") });
      await page.keyboard.press("Escape");
      check("tooltip", vis && inside && !(await body.isVisible()), `visible=${vis} inside=${inside} box=${box ? `${Math.round(box.x)},${Math.round(box.width)}` : "none"} closedOnEscape=${!(await body.isVisible())}`);
      // The pill hover on the model names the ClassicBot rooms that follow it.
      const modelPill = field("g-model").locator(".s-use .s-tipbtn");
      await modelPill.scrollIntoViewIfNeeded(); await modelPill.click();
      const roomTip = ((await field("g-model").locator(".s-use .s-tipbody").textContent()) ?? "").trim();
      check("pill-names-rooms", x.rooms.test(roomTip), roomTip);
      await page.keyboard.press("Escape");
      // An edit to auto-pause: agents take it at once, the rooms restart — the note names them; putting it back removes the note.
      const auto = t("#g-auto"), was = await auto.inputValue();
      await auto.fill(String(Number(was) + 15));
      await sleep(300);
      const note = ((await field("g-auto").locator(".s-note").textContent().catch(() => "")) ?? "").trim();
      const bar = ((await t(".s-pending .note").textContent().catch(() => "")) ?? "").trim();
      check("room-forecast-note", x.roomNote.test(note) && x.roomNote.test(bar), `note: ${note} | bar: ${bar}`);
      await page.screenshot({ path: shotPath(SMOKE, name, "room-note"), fullPage: dev.device === "desk" });
      await auto.fill(was); await sleep(300);
      check("note-gone-when-put-back", (await field("g-auto").locator(".s-note").count()) === 0 && (await t(".s-pending").count()) === 0);
    }
    const pageText = (await t(".p-settings").textContent()) ?? "";
    check("no-raw-keys", !RAW_KEY.test(pageText), RAW_KEY.exec(pageText)?.[0] ?? "none");

    // Save a field that applies at once: its own body, no confirmation.
    const cur = await t("#g-tp").evaluate((e: Element) => (e.tagName === "SELECT" ? (e as HTMLSelectElement).value : (e.querySelector("input:checked") as HTMLInputElement | null)?.value ?? ""));
    const target = cur === "verbose" ? "standard" : "verbose";
    if ((await t("#g-tp").evaluate((e: Element) => e.tagName)) === "SELECT") await t("#g-tp").selectOption(target);
    else await t("#g-tp .s-seg-opt").filter({ has: page.locator(`input[value="${target}"]`) }).click();
    await t(".s-pending .btn-primary").waitFor({ timeout: 5000 });
    const before = writes.length;
    await t(".s-pending .btn-primary").click();
    await page.waitForResponse((r: any) => r.request().method() === "PUT" && r.url().endsWith("/api/settings/fleet/defaults"), { timeout: 10000 }).catch(() => null);
    await sleep(800);
    const w1 = writes.slice(before).filter(w => w.path === "/api/settings/fleet/defaults");
    check("save-hot-body", w1.length === 1 && JSON.stringify(w1[0].body) === JSON.stringify({ tool_progress: target }), JSON.stringify(w1));
    check("save-hot-no-confirmation", w1.length === 1 && w1[0].status === 200 && (await t(".pending-card, [data-pending]").count()) === 0, `status ${w1[0]?.status ?? "none"}; pending cards ${await t(".pending-card, [data-pending]").count()}`);

    // Save a field that needs a fleet admin's OK (project folders): its own body, held — never applied by the click.
    const root = `/srv/skew-${++rootSeq}`;
    if (await t("details#project-roots").count()) await t("details#project-roots > summary").click();   // the old page keeps it in a closed disclosure
    const chip = t("#g-roots input[type=text]");
    await chip.scrollIntoViewIfNeeded(); await chip.fill(root); await chip.press("Enter").catch(() => {});
    if (!(await t("#g-roots").textContent())?.includes(root)) await t("#g-roots button").filter({ hasText: /Add|新增|加入/ }).first().click();
    await sleep(300);
    // The new page says it under the field; the old page says what saving costs on the Save bar only.
    const confirmNote = ((await t(newPage ? "#g-roots .s-note" : ".s-pending .note").first().textContent().catch(() => "")) ?? "").trim();
    check("confirm-note-shown", confirmNote.length > 0, confirmNote);
    const before2 = writes.length;
    await t(".s-pending .btn-primary").click();
    await page.waitForResponse((r: any) => r.request().method() === "POST" && r.url().endsWith("/ui/config"), { timeout: 10000 }).catch(() => null);
    await sleep(1200);
    const w2 = writes.slice(before2).filter(w => w.path === "/ui/config");
    const sentRoots = ((w2[0]?.body as any)?.project_roots ?? []) as string[];
    check("save-confirm-body", w2.length === 1 && Object.keys((w2[0].body as object) ?? {}).join() === "project_roots" && sentRoots.includes(root), JSON.stringify(w2));
    // The confirmation path: the server answers 202 pending_confirmation with a request to follow (this host session is a verified
    // admin, so it confirms itself and the change goes on to apply — what matters is that the click did not write it directly).
    const held = w2.length === 1 && w2[0].status === 202 && /"result":"pending_confirmation"/.test(w2[0].response) && /"pending_change":\{"id":"[0-9a-f]+"/.test(w2[0].response);
    check("save-confirm-flow", held, `status ${w2[0]?.status ?? "none"}; ${w2[0]?.response.slice(0, 110) ?? ""}`);
    await page.screenshot({ path: shotPath(SMOKE, name, "saved"), fullPage: false });
    check("no-page-errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) { check("case-ran", false, String(e).slice(0, 400)); check("no-page-errors", errors.length === 0, errors.slice(0, 3).join(" | ")); }
  // A swap that nobody requests tests nothing: every URL replaced in this mode must have been asked for at least once.
  if (MODES[mode].length) {
    const asked = MODES[mode].map(urlOf), missing = asked.filter(u => !(hits[u] > 0));
    check("swapped-urls-requested", missing.length === 0, missing.length ? `never requested: ${missing.join(", ")}` : asked.map(u => `${u} ×${hits[u]}`).join(", "));
  }
  const ok = Object.values(checks).every(c => c.ok);
  results.push({ name, lang, device: dev.device, mode, ok, checks, swappedHits: hits, writes });
  const bad = Object.entries(checks).filter(([, c]) => !c.ok).map(([k, c]) => `${k}${c.detail ? ` (${c.detail.slice(0, 120)})` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${bad.length ? " — " + bad.join("; ") : ""}`);
  await ctx.close();
}

// ── The receipt ──
// The command as it was run, with the environment it needs (PW_DIR, and LD_LIBRARY_PATH where Chromium's libraries live in a user directory).
const cmd = [...["PW_DIR", "LD_LIBRARY_PATH", "FONTCONFIG_FILE", "HP", "CASES"].filter(k => process.env[k]).map(k => `${k}=${process.env[k]}`),
  `REPO=${REPO}`, `OUT=${process.env.OUT ?? "/tmp/smoke-out"}`, `BASE=${BASE}`, `npx --prefix ${REPO} tsx scripts/manual/smoke/smoke-settings-skew-3087.mts`].join(" ");
const allChecks = [...new Set(results.flatMap(r => Object.keys(r.checks)))];
const hitsOf = (mode: Mode) => (MODES[mode] as readonly string[]).map(p => `\`${urlOf(p)}\` ×${results.filter(r => r.mode === mode).reduce((n, r) => n + (r.swappedHits[urlOf(p)] ?? 0), 0)}`).join(", ") || "—";
const receipt = [
  `# Settings SKEW receipt — Shared agent settings`,
  ``,
  `- Commit: \`${head}\` (${dirty ? "**working tree NOT clean**" : "clean working tree"})`,
  `- Base (the old assets): \`${BASE}\` = \`${baseSha}\``,
  `- Command: \`${cmd}\``,
  `- Result: **${results.filter(r => r.ok).length}/${results.length} cases pass**${results.every(r => r.ok) ? "" : " — see FAIL rows"}`,
  ``,
  `## Which files are old, per direction`,
  `- **stale-shell** (old shell + new Settings page) serves from BASE: ${staleShell.map(p => `\`${urlOf(p)}\``).join(", ")}. Requests served: ${hitsOf("stale-shell")}. Proof it is stale: ${addedClass ? `the loaded stylesheet lacks \`${addedClass}\`, a rule this branch added` : "(no class added)"}.`,
  `- **old-page** (new shell + old Settings page) serves from BASE: ${oldPage.map(p => `\`${urlOf(p)}\``).join(", ")}. Requests served: ${hitsOf("old-page")}. Proof it is old: no \`.s-shared\` on the page.`,
  `- Changed under src/ui on this branch: ${changed.map(p => `\`${p}\`${atBase(p) ? "" : " (new)"}`).join(", ")}. New files have no old copy; nothing requests them in old-page.`,
  ``,
  `## Cases`,
  `| case | ${allChecks.join(" | ")} |`,
  `|---|${allChecks.map(() => "---").join("|")}|`,
  ...results.map(r => `| ${r.ok ? "✅" : "❌"} ${r.name} | ${allChecks.map(k => (r.checks[k] ? (r.checks[k].ok ? "✓" : "✗") : "–")).join(" | ")} |`),
  ``,
  `(– = not applicable in that mode: the old page has none of the new controls.)`,
  ``,
  `## Failures`,
  ...(results.some(r => !r.ok) ? results.filter(r => !r.ok).flatMap(r => Object.entries(r.checks).filter(([, c]) => !c.ok).map(([k, c]) => `- ${r.name} / ${k}: ${c.detail ?? ""}`)) : ["none"]),
  ``,
].join("\n");
writeFileSync(join(OUT, "receipt.md"), receipt);
writeFileSync(join(OUT, "result.json"), JSON.stringify({ commit: head, clean: !dirty, base: BASE, baseSha, command: cmd, staleShell, oldPage, changed, addedClass, results }, null, 2));
console.log(receipt.split("\n").slice(0, 12).join("\n"));
await fx.close();
process.exit(results.every(r => r.ok) ? 0 : 1);

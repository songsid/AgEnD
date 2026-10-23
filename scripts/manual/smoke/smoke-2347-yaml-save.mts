// #2347 item 4 from defaults (fleet decision a78ebdc5), through visible UI: the fleet.yaml editor (Settings → Advanced)
// saves with the Save bar. An agent's description edited in the editor → Apply: "1 unsaved change(s)" in the bar, the
// editor says so, nothing written. Agents then: its list off under the note with "Open the editor", the setup wizard
// off. Back in Advanced the edit is still there; Save writes it (one PATCH, then the apply). The other way: a change in
// Agent defaults left unsaved → the editor's Edit is off with its note; Discard → Edit is back.
// The writes are answered in the browser (page.route), never by the fixture's fleet: an apply there would start CLIs.
// Cases: desk light en, desk dark zh-TW, phone light en.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2347-yaml-save.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "2347-yaml-save", LABEL = process.env.LABEL ?? "after";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = /^(Viewport argument key "interactive-widget" not recognized and ignored\.|Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.|(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/[a-z-]+|auth\/session|api\/[a-z/-]+)(\?\S*)? due to access control checks\.)/;
const pageErrors = (errors: string[]) => errors.filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.test(e)));
const fx = await bootFixture({ port: Number(process.env.HP ?? 48838), instances: 3 });
fx.fm.getInstanceStatus = () => "running";
const r: any = { engine: ENGINE, label: LABEL, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
const T = (c: { lang: string }, en: string, zh: string) => (c.lang === "zh-TW" ? zh : en);
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c as any, { path: "/settings/advanced" }).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page } = p;
  const shot = (step: string) => page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-${step}`) });
  const writes: Array<{ method: string; path: string; body: any }> = [];
  await page.route("**/api/settings/**", async (route: any) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() === "GET" && path !== "/api/settings/apply/job-smoke") return route.continue();
    if (req.method() !== "GET") writes.push({ method: req.method(), path, body: req.postData() ? JSON.parse(req.postData()) : null });
    const body = path === "/api/settings/apply" || path === "/api/settings/apply/job-smoke" ? { id: "job-smoke", status: "done", targets: [] } : { ok: true };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  // Through the nav (a reload would drop what is staged). On a phone a section is shown on its own (§7): "‹ Settings"
  // goes back to the list of sections first.
  const go = async (section: string) => {
    const back = page.locator(".p-settings .s-back");
    if (await back.isVisible().catch(() => false)) { await back.click(); await page.waitForTimeout(500); }
    const sel = section === "agents" ? ".seg-item[href='/settings'], .seg-item[href='/settings/agents']" : `.seg-item[href='/settings/${section}']`;
    await page.locator(".p-settings > .s-nav").locator(sel).first().click();
    await page.waitForTimeout(900);
  };
  try {
    ok(res, "mounted", await mounted(page));
    const dev = page.locator(".s-dev");
    await dev.waitFor({ timeout: 15000 });
    await dev.locator("button", { hasText: "JSON" }).click();
    await dev.locator("button", { hasText: T(c, "Edit", "編輯") }).click();
    const ta = page.locator("textarea.s-yaml");
    const model = JSON.parse(await ta.inputValue());
    const name = Object.keys(model.instances)[0];
    model.instances[name].description = "Edited in fleet.yaml";
    await ta.fill(JSON.stringify(model, null, 2));
    await dev.locator("button.btn-primary").click(); await page.waitForTimeout(600);
    const bar = page.locator(".s-pending");
    ok(res, "apply:inTheBar", (await bar.textContent().catch(() => "") ?? "").includes(T(c, "1 unsaved change(s)", "1 項變更未儲存")));
    ok(res, "apply:editorSays", ((await dev.textContent()) ?? "").includes(T(c, "In the Save bar: 1 change(s) to fleet.yaml", "已加入儲存列：fleet.yaml 的 1 項變更")));
    ok(res, "apply:nothingWritten", writes.length === 0, writes);
    await shot("1-applied");
    // Agents: the list is off under its note; the wizard is off.
    await go("agents");
    const lock = await page.evaluate(`(() => { const f = document.querySelector(".s-yaml-lock"), n = f && f.querySelector(".s-yaml-lock-note");
      const w = [...document.querySelectorAll(".panel-actions button")].find((b) => /Setup wizard|設定精靈/.test(b.textContent));
      const rowBtn = f && f.querySelector(".s-row button");
      return { disabled: !!f && f.disabled, note: n ? n.textContent : null, link: n && n.querySelector("a") ? n.querySelector("a").getAttribute("href") : null,
        wizard: w ? w.disabled : null, rowBtnOff: !!rowBtn && rowBtn.matches(":disabled") }; })()`) as any;
    res.measured = { lock };
    ok(res, "agents:locked", lock.disabled && lock.rowBtnOff && (lock.note ?? "").includes(T(c, "An unsaved fleet.yaml edit", "有一份未儲存的 fleet.yaml 編輯")) && lock.link === "/settings/advanced", lock);
    ok(res, "agents:wizardOff", lock.wizard === true || (c.device === "phone" && lock.wizard !== false), lock.wizard);
    await shot("2-agents-locked");
    // Back: the edit is still in the editor; Save writes it.
    await page.locator(".s-yaml-lock-note a").click(); await page.waitForTimeout(900);
    ok(res, "back:editKept", ((await page.locator("textarea.s-yaml").inputValue().catch(() => "")) ?? "").includes("Edited in fleet.yaml"));
    await bar.locator("button.btn-primary").click();
    await page.waitForTimeout(2500);
    ok(res, "save:writesTheEdit", writes.map((w) => `${w.method} ${w.path}`).join(",") === `PATCH /api/settings/fleet/instances/${encodeURIComponent(name)},POST /api/settings/apply`
      && writes[0]?.body?.description === "Edited in fleet.yaml", writes);
    ok(res, "save:barGone", await page.locator(".s-pending").count() === 0);
    await shot("3-saved");
    // The other way: a form's change unsaved holds the editor.
    writes.length = 0;
    await go("agent-defaults");
    await page.locator("#g-tp").waitFor({ timeout: 15000 });
    await page.selectOption("#g-tp", { index: 1 }); await page.waitForTimeout(500);
    await go("advanced");
    const held = await page.evaluate(`(() => { const d = document.querySelector(".s-dev"), e = d && [...d.querySelectorAll("button")].find((b) => /^(Edit|編輯)$/.test(b.textContent.trim()));
      const n = d && d.querySelector(".s-dev-blocked"); return { editOff: !!e && e.disabled, note: n ? n.textContent : null }; })()`) as any;
    ok(res, "forms:holdTheEditor", held.editOff && (held.note ?? "").includes(T(c, "Save or discard the unsaved changes", "請先儲存或捨棄")), held);
    await shot("4-editor-held");
    await page.locator(".s-pending button", { hasText: T(c, "Discard", "捨棄") }).click(); await page.waitForTimeout(800);
    ok(res, "discard:editorBack", await page.evaluate(`(() => { const e = [...document.querySelectorAll(".s-dev button")].find((b) => /^(Edit|編輯)$/.test(b.textContent.trim())); return !!e && !e.disabled; })()`) as boolean);
    ok(res, "discard:nothingWritten", writes.length === 0, writes);
    ok(res, "noPageErrors", pageErrors(p.errors).length === 0, pageErrors(p.errors));
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await shot("error").catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((x: any) => !x.failed);
writeFileSync(shotPath(SMOKE, `result-${LABEL}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, v.failed ?? []])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);

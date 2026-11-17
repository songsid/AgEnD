// M-3286 (#4104) from defaults (fleet decision a78ebdc5), through visible navigation: Fleet → Org chart → Office →
// Edit offices → Add office (Cozy), tick "Idle people stay in their own area", Save; the office opens; Edit offices again
// shows the box ticked; the host keeps it beside the list in web-offices.json (never in the office's entry).
// Cases: desk light en, desk dark zh-TW.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [HP=48886] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-m3286-office-stay-in-area.mts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "m3286-office-stay-in-area";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48886), classic: false });
const fm = fx.fm, dir = fm.dataDir ?? fx.dir;
const names = ["general", "atlas", "quill", "sage", "orbit", "ember"];
fm.fleetConfig.instances = Object.fromEntries(names.map((name, i) => [name, { working_directory: dir, backend: ["claude-code", "codex", "kiro-cli"][i % 3], ...(name === "general" ? { general_topic: true } : {}) }]));
fm.getInstanceStatus = () => "running";
const r: any = { cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
const LABEL = { en: "Idle people stay in their own area", "zh-TW": "待命只在自己的區域走動" } as const;
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c as any).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page, base } = p;
  try {
    ok(res, "mounted", await mounted(page, 30000));
    await page.setViewportSize({ width: 1600, height: 960 });
    await page.goto(`${base}/ui/fleet/org`);
    await page.locator(".oc-tools .seg-inline button", { hasText: c.lang === "en" ? "Office" : "辦公室" }).click();
    await page.waitForSelector(".oo-canvas", { timeout: 15000 }); await page.waitForTimeout(600);
    await page.locator(".oo-edit").click();
    await page.waitForSelector(".oe-list, #oeNone", { timeout: 10000 });
    const rows0 = await page.locator(".oe-row").count();
    await page.locator("#oeAdd").click();
    const row = page.locator(".oe-row").nth(rows0);
    await row.locator(".oe-name").fill(c.lang === "en" ? "Tavern" : "酒館");
    await row.locator(".oe-style").selectOption("cozy");
    const box = row.locator(".oe-stay-in-area");
    ok(res, "box:offByDefault", !(await box.isChecked()));
    ok(res, "box:label", (await row.locator(".oe-stay").innerText()).trim() === LABEL[c.lang], (await row.locator(".oe-stay").innerText()).trim());
    await box.check();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shotPath(SMOKE, tag, "1-edit-ticked") });
    await page.locator("#oeSave").click();
    await page.waitForSelector(".oe-list", { state: "detached", timeout: 10000 });
    const id = await page.evaluate(`fetch("/ui/offices").then((x) => x.json()).then((j) => j.offices.at(-1))`) as any;
    ok(res, "api:stayInArea", id && id.stayInArea === true, id && { name: id.name, skin: id.skin, stayInArea: id.stayInArea });
    const disk = JSON.parse(readFileSync(join(dir, "web-offices.json"), "utf8"));
    ok(res, "disk:beside", !!disk.stayInArea && disk.stayInArea[id.id] === true && disk.offices.every((o: any) => !("stayInArea" in o)), { stayInArea: disk.stayInArea });
    await page.locator("select.oo-office").selectOption(id.id);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: shotPath(SMOKE, tag, "2-office") });
    await page.locator(".oo-edit").click();
    await page.waitForSelector(".oe-list", { timeout: 10000 });
    ok(res, "reopen:ticked", await page.locator(`.oe-row[data-office="${id.id}"] .oe-stay-in-area`).isChecked());
    await page.screenshot({ path: shotPath(SMOKE, tag, "3-reopened") });
    // Untick, Save: the key is gone everywhere.
    await page.locator(`.oe-row[data-office="${id.id}"] .oe-stay-in-area`).uncheck();
    await page.locator("#oeSave").click();
    await page.waitForSelector(".oe-list", { state: "detached", timeout: 10000 });
    const off = await page.evaluate(`fetch("/ui/offices").then((x) => x.json()).then((j) => j.offices.find((o) => o.id === ${JSON.stringify(id.id)}))`) as any;
    const disk2 = JSON.parse(readFileSync(join(dir, "web-offices.json"), "utf8"));
    ok(res, "untick:gone", off && !("stayInArea" in off) && !disk2.stayInArea, { api: off && off.stayInArea, disk: disk2.stayInArea ?? null });
    ok(res, "noOverflow", !(await page.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)));
    ok(res, "noPageErrors", p.errors.length === 0, p.errors);
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await page.screenshot({ path: shotPath(SMOKE, tag, "error") }).catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((x: any) => !x.failed);
writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, v.failed ?? []])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);

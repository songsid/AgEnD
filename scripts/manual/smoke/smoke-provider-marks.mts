// S-24 (the user, hmsg-d0ee3254 / hmsg-d0747eb3): the CLI picker's provider marks — Grok's vector mark (no App Store
// JPEG), OpenCode and Muse with marks, Antigravity's press-kit icon, Claude / OpenAI / Kiro as before — in a real browser.
// New agent → this machine (WSL/Linux) → the backend picker, with every CLI listed as installed (GET /ui/backends answered by the smoke: the fixture
// host has none). Per case (desk 1366 / phone 390, light / dark): every option shows a mark (an <svg> with paths or an
// <img> that decoded), single-colour marks follow the text colour (light vs dark), no page error or CSP violation; a
// screenshot of the open picker. MODE=before shoots the base branch's picker for the comparison (no checks);
// MODE=tiles turns the takedown switch off (MARK_SWITCH.brandMarks = false, served rewritten) and checks every option
// shows its generic tile.
//   PW_DIR=… REPO=… OUT=… npx --prefix <checkout> tsx scripts/manual/smoke/smoke-provider-marks.mts
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-provider-marks";
const MODE = process.env.MODE === "before" ? "before" : process.env.MODE === "tiles" ? "tiles" : "after";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48800), classic: false, instances: 4 });
const ALL = ["claude-code", "codex", "opencode", "kiro-cli", "antigravity", "grok", "muse"];
const BACKENDS = { backends: ALL.map(name => ({ name, binary: name, installed: true, path: `/usr/local/bin/${name}`, deprecated: false, state: "usable" })), defaultBackend: "claude-code" };
const CASES = [
  { device: "desk", theme: "light", lang: "en" },
  { device: "desk", theme: "dark", lang: "en" },
  { device: "phone", theme: "light", lang: "zh-TW" },
  { device: "phone", theme: "dark", lang: "zh-TW" },
] as const;
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
const fills: Record<string, string> = {};
for (const c of CASES) {
  const failed: string[] = [];
  const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
  const p = await freshPage(fx, c as any, { account: "operator", beforeNavigate: async (ctx: any) => {
    if (MODE === "tiles") await ctx.route("**/provider-marks.js", async (r: any) => {
      const res = await r.fetch(), body = await res.text(), off = body.replace("brandMarks: true,", "brandMarks: false,");
      if (off === body) throw new Error("the switch line was not found");
      await r.fulfill({ response: res, body: off });
    });
    await ctx.route("**/ui/backends", (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BACKENDS) }));
  } });
  await mounted(p.page, 30000);
  if (c.device === "phone") { await p.page.locator("#sbOpen").tap(); await p.page.waitForTimeout(300); }
  await p.page.locator(".side-new").first().click();
  const wsl = p.page.locator('input[name="agent-runtime"][value="wsl"]');
  await wsl.waitFor({ state: "attached", timeout: 15000 });
  if (!(await wsl.isChecked())) await p.page.locator(".agent-runtime-choice").first().click();
  await p.page.waitForSelector(".cli-picker-trigger", { timeout: 15000 });
  await p.page.locator(".cli-picker-trigger").first().click();
  await p.page.waitForSelector('[role="menuitemradio"] [data-cli="grok"]', { timeout: 10000 }).catch(() => {});
  await p.page.waitForTimeout(500);
  // The open menu with a margin around it (it scrolls past six rows: a second shot at its end).
  const shoot = async (name: string) => {
    const box = (await p.page.locator('[role="menu"]').last().boundingBox())!, vp = p.page.viewportSize()!;
    const pad = 16, x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
    await p.page.screenshot({ path: shotPath(SMOKE, c as any, name), clip: { x, y, width: Math.min(vp.width - x, box.width + 2 * pad), height: Math.min(vp.height - y, box.height + 2 * pad) } });
  };
  await shoot(`${MODE}-picker`);
  if (MODE === "tiles") {
    const tiles = await p.page.evaluate(`(() => ${JSON.stringify(ALL)}.map((cli) => {
      const el = document.querySelector('[role="menuitemradio"] [data-cli="' + cli + '"]');
      return [cli, el && el.querySelector("svg.provider-tile text") ? el.querySelector("svg.provider-tile text").textContent : null, el ? el.querySelectorAll("img, svg:not(.provider-tile)").length : -1];
    }))()`) as Array<[string, string | null, number]>;
    need(tiles.every(([, letters, art]) => !!letters && art === 0), `every option a tile, no artwork: ${JSON.stringify(tiles)}`);
    need(p.errors.length === 0, `no page error or CSP violation: ${p.errors.slice(0, 2).join(" / ")}`);
  }
  if (MODE === "after") {
    const marks = await p.page.evaluate(`(() => Object.fromEntries(${JSON.stringify(ALL)}.map((cli) => {
      const el = document.querySelector('[role="menuitemradio"] [data-cli="' + cli + '"]');
      const img = el && el.querySelector("img"), svg = el && el.querySelector("svg");
      const ok = img ? img.complete && img.naturalWidth > 0 : !!svg && svg.querySelectorAll("path").length > 0;
      const fill = svg && !img ? getComputedStyle(svg.querySelector("path")).fill : null;
      return [cli, { ok, kind: img ? "img" : svg ? "svg" : "none", fill }];
    })))()`) as Record<string, { ok: boolean; kind: string; fill: string | null }>;
    for (const cli of ALL) need(marks[cli]?.ok === true, `${cli}: ${JSON.stringify(marks[cli])}`);
    for (const cli of ["grok", "opencode"]) fills[`${cli}-${c.theme}`] = marks[cli]?.fill ?? "";
    need(marks.grok?.kind === "svg" && marks.muse?.kind === "img" && marks.antigravity?.kind === "img", `kinds ${marks.grok?.kind}/${marks.muse?.kind}/${marks.antigravity?.kind}`);
    // The open menu: inside the viewport, every option reachable (all in view, or the menu scrolls to it).
    const fit = await p.page.evaluate(`(() => { const m = [...document.querySelectorAll('[role="menu"]')].pop(), r = m.getBoundingClientRect();
      const last = [...m.querySelectorAll('[role="menuitemradio"]')].pop(); last.scrollIntoView({ block: "nearest" });
      const l = last.getBoundingClientRect(), r2 = m.getBoundingClientRect();
      return { inViewport: r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.left >= 0 && r.right <= innerWidth + 0.5, lastShown: l.bottom <= r2.bottom + 0.5 && l.top >= r2.top - 0.5, scrolls: m.scrollHeight > m.clientHeight, bottom: r.bottom, vh: innerHeight }; })()`) as any;
    need(fit.inViewport && fit.lastShown, `menu fits: ${JSON.stringify(fit)}`);
    await p.page.waitForTimeout(200);
    await shoot(`${MODE}-picker-end`);
    need(p.errors.length === 0, `no page error or CSP violation: ${p.errors.slice(0, 2).join(" / ")}`);
  }
  results.push({ name: `${c.device}-${c.theme}-${c.lang}`, ok: !failed.length, failed });
  await p.ctx.close();
}
if (MODE === "after") {
  const differ = fills["grok-light"] !== fills["grok-dark"] && fills["opencode-light"] !== fills["opencode-dark"];
  results.push({ name: "single-colour marks follow the text colour (light ≠ dark)", ok: differ, failed: differ ? [] : [JSON.stringify(fills)] });
}
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
await fx.close();
process.exit(results.every(r => r.ok) ? 0 : 1);

// #2347 §7 ("Effect tags wrap under the label") from defaults (fleet decision a78ebdc5), through visible UI. On a phone
// every effect tag ("Applies now", "Restarts agents", "Restart AgEnD", "Needs an admin's OK") in Agent defaults, Chat &
// connections, Web dashboard and Access & security sits on its own line under its label's text, where that text starts,
// whole (one line) and inside the screen. On a desk they stay beside the label as before.
// Cases: phone light en, phone dark zh-TW, small (320×568) light en, desk light en. LABEL=before|after names the shots.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [LABEL=before] [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2347-impact-wrap.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "2347-impact-wrap", LABEL = process.env.LABEL ?? "after";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = /^(Viewport argument key "interactive-widget" not recognized and ignored\.|Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.|(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/[a-z-]+|auth\/sessions?|api\/[a-z/-]+)(\?\S*)? due to access control checks\.)/;
const pageErrors = (errors: string[]) => errors.filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.test(e)));
const fx = await bootFixture({ port: Number(process.env.HP ?? 48846), instances: 3 });
fx.fm.getInstanceStatus = () => "running";
const r: any = { engine: ENGINE, label: LABEL, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
// Each shown effect tag against its label's text: below it, at its start, one line, inside the screen.
const TAGS = `(() => { const vw = document.documentElement.clientWidth, seen = (e) => getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0;
  return [...document.querySelectorAll(".p-settings .panel-body .impact")].filter(seen).map((el) => {
    const host = el.closest("label"); let text = null;
    if (host && host.classList.contains("check")) { const s = host.querySelector(":scope > input + span"); if (s) { const rs = [...s.getClientRects()]; text = { l: rs[0].left, b: rs[rs.length - 1].bottom }; } }
    else if (host && host.firstChild && host.firstChild.nodeType === 3) { const rg = document.createRange(); rg.selectNodeContents(host.firstChild); const rs = [...rg.getClientRects()].filter((x) => x.width > 0); if (rs.length) text = { l: rs[0].left, b: rs[rs.length - 1].bottom }; }
    const b = el.getBoundingClientRect(), lh = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.4;
    return { tag: el.textContent.trim(), label: host ? host.textContent.trim().slice(0, 40) : null, below: !!text && b.top >= text.b - 1, atStart: !!text && Math.abs(b.left - text.l) <= 2,
      oneLine: el.getClientRects().length === 1 && b.height <= lh * 1.5, inside: b.right <= vw + 1 }; }); })()`;
const SECTIONS = ["agent-defaults", "chat", "web-dashboard", "access"];
// Cases: …and small (320×568) dark zh-TW, where the dialog's status-emoji tag broke mid-tag (#2512 review).
for (const c of [{ device: "phone", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en", small: true },
  { device: "phone", theme: "dark", lang: "zh-TW", small: true }, { device: "desk", theme: "light", lang: "en" }] as const) {
  const tag = `${"small" in c ? "small" : c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = { measured: {} });
  const p = await freshPage(fx, c as any, { path: "/settings/agent-defaults" }).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page } = p;
  try {
    ok(res, "mounted", await mounted(page));
    if ("small" in c) await page.setViewportSize({ width: 320, height: 568 });
    for (const section of SECTIONS) {
      await page.goto(new URL(`/settings/${section}`, page.url()).href);
      await page.locator(".p-settings .panel-body .impact").first().waitFor({ timeout: 15000 }); await page.waitForTimeout(700);
      // Drawers (Advanced) open, so every tag in the section is measured.
      await page.evaluate(`document.querySelectorAll(".p-settings .panel-body details").forEach((d) => { d.open = true; })`); await page.waitForTimeout(300);
      const tags = await page.evaluate(TAGS) as any[];
      res.measured[section] = { n: tags.length, off: tags.filter((t) => (c.device === "desk" ? t.below : !(t.below && t.atStart && t.oneLine && t.inside))) };
      await page.locator(".p-settings .panel-body .impact").first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-${section}`) });
      ok(res, `${section}:tags`, tags.length > 0, tags.length);
      if (c.device === "desk") ok(res, `${section}:besideOnDesk`, res.measured[section].off.length === 0, res.measured[section].off.slice(0, 4));
      else ok(res, `${section}:underTheLabel`, res.measured[section].off.length === 0, res.measured[section].off.slice(0, 4));
    }
    // An agent's dialog (#2512 review): its label tags under their labels; every tag, the status-emoji note's too, whole.
    await page.goto(new URL("/settings/agents", page.url()).href);
    await page.locator(".p-settings .s-row").first().waitFor({ timeout: 15000 });
    await page.locator(".p-settings .s-row").first().locator("button", { hasText: c.lang === "en" ? /^Settings$/ : /^設定$/ }).click();
    await page.locator(".p-settings dialog[open]").waitFor({ timeout: 8000 }); await page.waitForTimeout(500);
    await page.evaluate(`document.querySelectorAll(".p-settings dialog details").forEach((d) => { d.open = true; })`); await page.waitForTimeout(300);
    const dlg = await page.evaluate(`(() => { const vw = document.documentElement.clientWidth;
      return [...document.querySelectorAll(".p-settings dialog[open] .impact")].filter((e) => e.getBoundingClientRect().width > 0).map((el) => { const b = el.getBoundingClientRect(), lh = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.4;
        return { tag: el.textContent.trim(), inNote: !!el.closest(".note"), oneLine: el.getClientRects().length === 1 && b.height <= lh * 1.5, inside: b.right <= vw + 1 }; }); })()`) as any[];
    res.measured.dialog = { n: dlg.length, off: dlg.filter((t) => !(t.oneLine && t.inside)) };
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-agent-dialog`) });
    ok(res, "dialog:tagsWhole", dlg.length > 0 && res.measured.dialog.off.length === 0, res.measured.dialog);
    ok(res, "noOverflow", !(await page.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)));
    ok(res, "noPageErrors", pageErrors(p.errors).length === 0, pageErrors(p.errors));
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-error`) }).catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((x: any) => !x.failed);
writeFileSync(shotPath(SMOKE, `result-${LABEL}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, { failed: v.failed ?? [], n: Object.fromEntries(Object.entries(v.measured).map(([s, m]: any) => [s, `${m.n} tags, ${m.off.length} off`])) }])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);

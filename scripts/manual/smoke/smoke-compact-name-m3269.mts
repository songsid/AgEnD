// Real app/HTTP preferences; inert agents, scratch home, headless Linux Chromium. STAGE=before uses the pinned base.
// ui-gate: {"name": "Compact sidebar name choice (desktop and phone)", "hp": 19676}
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";
import { clearDensity } from "../smoke-fixture/faces.mts";

const before = process.env.STAGE === "before", smoke = `smoke-compact-name-m3269-${before ? "before" : "after"}`;
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49120), classic: false, roster: [
  { name: "general", displayName: "General", backend: "claude-code", general: true },
  { name: "agent-alpha", displayName: "Atlas", backend: "codex" },
  { name: "agent-beta", displayName: "Beacon", backend: "claude-code" },
  { name: "agent-gamma", backend: "codex" },
] });
const results: any[] = [];
const read = () => {
  const rows = [...document.querySelectorAll('#sidebar [data-agent-row] a.inst')].filter(el => el.getBoundingClientRect().width > 0);
  return rows.map(el => { const n = el.querySelector(".inst-name")!, r = n.getBoundingClientRect(); return {
    name: el.closest("[data-agent-row]")!.getAttribute("data-agent-row"), label: n.textContent,
    title: el.getAttribute("title"), aria: el.getAttribute("aria-label"), alt: el.querySelector(".inst-alt")?.textContent,
    height: el.getBoundingClientRect().height, nameHeight: r.height, lineHeight: parseFloat(getComputedStyle(n).lineHeight),
  }; });
};
async function drawer(page: any, phone: boolean) {
  if (phone && !(await page.locator(".shell").evaluate((el: Element) => el.classList.contains("sb-open")))) await page.locator("#sbOpen").tap();
  await page.waitForTimeout(350);
}
async function menu(page: any, phone: boolean) {
  await drawer(page, phone);
  const b = page.locator(phone ? "#sidebar .nav-sort-phone > .nav-sort-btn" : "#sidebar .inst-head .nav-sort-btn");
  if (!(await page.locator("#sidebar .nav-sort-menu").count())) await b.click();
}
async function pick(page: any, phone: boolean, group: string, value: string) {
  await menu(page, phone);
  await page.locator(`#sidebar input[name="${group}"][value="${value}"]`).check();
  await page.waitForTimeout(650);
  await page.locator(phone ? "#sidebar .nav-sort-phone > .nav-sort-btn" : "#sidebar .inst-head .nav-sort-btn").click();
}
try {
  for (const device of ["desk", "phone"] as const) {
    if (process.env.DEVICE && process.env.DEVICE !== device) continue;
    clearDensity(fx);
    const phone = device === "phone", c = { device, theme: phone ? "light" as const : "dark" as const, lang: phone ? "zh-TW" as const : "en" as const };
    const p = await freshPage(fx, c, { account: "operator", path: "/ui/fleet/org", beforeNavigate: async ctx => {
      await ctx.addInitScript({ content: "window.__name = (f) => f" });
    } });
    let checks = 0;
    const need = (ok: unknown, why: string) => { checks++; if (!ok) throw new Error(why); };
    try {
      need(await mounted(p.page, 30000), "app mounted"); await drawer(p.page, phone);
      await p.page.locator('#sidebar [data-agent-row="agent-alpha"] a.inst').waitFor({ state: "visible", timeout: 30000 });
      if (phone) await pick(p.page, phone, "nav-sort-density", "compact");
      const first = await p.page.evaluate(read), a = first.find(r => r.name === "agent-alpha")!;
      need(a.label === "Atlas", "unchanged default display name");
      need(a.title!.includes("agent-alpha"), "tooltip retains instance name");
      need(first.every(r => !r.alt && r.nameHeight <= r.lineHeight + 1), "one visible name line");
      if (process.env.CAPTURE !== "labels") await p.page.screenshot({ path: shotPath(smoke, device, "display-name") });
      if (!before) {
        await pick(p.page, phone, "nav-sort-compact-name", "instance");
        const second = await p.page.evaluate(read), b = second.find(r => r.name === "agent-alpha")!;
        need(b.label === "agent-alpha" && b.aria!.includes("Atlas"), "instance name plus accessible display name");
        need(second.every(r => !r.alt && r.nameHeight <= r.lineHeight + 1), "instance choice stays one line");
        if (process.env.CAPTURE !== "labels") await p.page.screenshot({ path: shotPath(smoke, device, "instance-name") });
        await menu(p.page, phone);
        const controls = p.page.locator('input[name="nav-sort-compact-name"]');
        need(await controls.count() === 2 && await controls.locator("xpath=..").count() === 2, "two exclusive options");
        need(await p.page.locator('input[name="nav-sort-compact-name"]:checked').count() === 1, "one checked option");
        const bounds = await p.page.locator("#sidebar .nav-sort-menu").boundingBox();
        need(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= p.page.viewportSize().width + 1 && bounds.y + bounds.height <= p.page.viewportSize().height + 1, "menu fits viewport");
        const selected = p.page.locator('input[name="nav-sort-compact-name"]:checked');
        await selected.scrollIntoViewIfNeeded();
        need(await selected.evaluate((el: HTMLInputElement) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el; }), "selected name option is not clipped or covered");
        await p.page.screenshot({ path: shotPath(smoke, device, "customize") });
        await p.page.goto(p.base + "/settings/preferences");
        await p.page.locator("#pref-compact-name").waitFor();
        need(await p.page.locator('#pref-compact-name input[value="instance"]').isChecked(), "Settings reads saved choice");
        await p.page.locator('#pref-compact-name input[value="nickname"]').check();
        need((await p.page.locator('#pref-compact-name input:checked').count()) === 1, "Settings single choice");
        await p.page.screenshot({ path: shotPath(smoke, device, "settings") });
        // Save uses the existing Settings bar. Discard is independently pinned in the focused DOM tests.
        const save = p.page.locator(".s-pending-actions button.btn-primary");
        await save.click();
        await p.page.waitForTimeout(500);
        const pref = fx.fm.webPrefs.readForViewer("operator");
        need(pref.values["nav.compactName"] === "nickname", "Settings saved to host");
      }
      need(p.errors.length === 0, "no page errors");
      results.push({ device, checks, ok: true });
    } finally { await p.ctx.close(); clearDensity(fx); }
  }
} finally {
  await fx.close();
  console.log(JSON.stringify({ stage: before ? "before" : "after", results }));
  writeFileSync(join(process.env.OUT!, `${smoke}.json`), JSON.stringify({ results }, null, 2) + "\n");
}

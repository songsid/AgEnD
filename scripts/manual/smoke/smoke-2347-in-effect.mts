// #2347 §10 on a fresh profile — desk light (en), desk dark (zh-TW), phone light (en). The fixture's fleet.yaml sets no
// defaults, so every Agent default is the built-in one. Checks: Agent defaults marks its fields "default"; Access's empty
// session and terminal fields say what is in effect (no grey placeholder); an agent's dialog says what each inherited
// field inherits, and its link goes to that field in Agent defaults with the Advanced drawer opened and the field
// focused; Advanced's read-only list shows defaults; nothing scrolls sideways, no page error.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-2347-in-effect.mts
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48861), instances: 2 });
fx.fm.getInstanceStatus = () => "running";
const results: Array<{ name: string; failed: string[] }> = [];
const W = { en: { settings: "Settings", inherited: "Inherited:", def: "default", effect: "In effect: 48 h" },
  "zh-TW": { settings: "設定", inherited: "沿用：", def: "預設", effect: "目前生效：48 小時" } } as const;
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" }] as const) {
  const name = `${c.device}-${c.theme}-${c.lang}`, failed: string[] = [], w = W[c.lang];
  const ok = (k: string, v: boolean) => { if (!v) failed.push(k); };
  const p = await freshPage(fx, c);
  const errors: string[] = [];
  p.page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  await mounted(p.page, 30000);
  // The section's own page (on a phone, §7, /settings is the list of sections and a section is shown alone).
  const go = async (path: string) => { await p.page.goto(new URL(path, p.page.url()).href); await p.page.locator(".p-settings .panel-body .col").waitFor({ state: "attached", timeout: 15000 }); await p.page.waitForTimeout(600); };
  const sideScroll = () => p.page.evaluate(`document.documentElement.scrollWidth > innerWidth`) as Promise<boolean>;

  await go("/settings/agent-defaults");
  const marks = await p.page.evaluate(`["g-locale", "g-be", "g-auto", "g-tp", "g-reply"].map((id) => !!document.getElementById(id).closest(".field, .check").querySelector(".s-default"))`) as boolean[];
  ok("defaultsMarked", marks.every(Boolean));
  ok("markText", (await p.page.locator("#g-auto").locator("xpath=ancestor::div[contains(@class,'field')][1]").locator(".s-default").textContent())?.trim() === w.def);
  ok("noSideScroll:defaults", !(await sideScroll()));
  await p.page.screenshot({ path: shotPath("2347ie", c as any, "1-agent-defaults") });

  await go("/settings/access");
  const eff = await p.page.evaluate(`["webSessionAbsolute", "webSessionIdle", "webTerminalTtl"].map((id) => { const i = document.getElementById(id);
    return [i.getAttribute("placeholder"), i.parentNode.querySelector(".s-effect")?.textContent.replace(/\\s+/g, " ").trim()]; })`) as Array<[string | null, string]>;
  ok("noPlaceholders", eff.every(([ph]) => ph === null));
  ok("inEffectShown", eff[0][1]?.startsWith(w.effect) && eff.every(([, t]) => !!t));
  ok("noSideScroll:access", !(await sideScroll()));
  await p.page.locator("#webSessionAbsolute").scrollIntoViewIfNeeded();
  await p.page.screenshot({ path: shotPath("2347ie", c as any, "2-access") });

  await go("/settings/advanced");
  await p.page.locator(".s-web-ro > div").first().waitFor({ timeout: 15000 });          // drawn once the configuration is in
  const ro = await p.page.evaluate(`[...document.querySelectorAll(".s-web-ro > div")].map((d) => !!d.querySelector(".s-default"))`) as boolean[];
  ok("readOnlyDefaults", ro.length === 13 && ro.filter(Boolean).length >= 10);

  await go("/settings/agents");
  await p.page.locator(".s-row .s-actions button", { hasText: w.settings }).first().click();
  await p.page.locator("dialog #ag-auto").waitFor({ timeout: 10000 });
  await p.page.locator("dialog details.drawer summary").first().click();
  await p.page.waitForTimeout(300);
  const lines = await p.page.evaluate(`[...document.querySelectorAll("dialog .s-inherited")].map((l) => l.textContent.replace(/\\s+/g, " ").trim())`) as string[];
  ok("inheritedLines", lines.length >= 7 && lines.every((l) => l.startsWith(w.inherited)));
  ok("inheritedMarked", lines.some((l) => l.includes(w.def)));
  const box = await p.page.evaluate(`(() => { const d = document.querySelector("dialog"), r = d.getBoundingClientRect(), wide = [...d.querySelectorAll(".s-inherited")].some((l) => l.scrollWidth > l.clientWidth + 1);
    return { fits: r.left >= -1 && r.right <= innerWidth + 1, wide }; })()`) as any;
  ok("dialogFits", box.fits);
  ok("linesWrap", !box.wide);
  await p.page.locator("dialog #ag-auto").scrollIntoViewIfNeeded();
  await p.page.screenshot({ path: shotPath("2347ie", c as any, "3-agent-dialog") });
  await p.page.locator("dialog #ag-hang").locator("xpath=ancestor::div[contains(@class,'field')][1]").locator(".s-inherited a").click();
  await p.page.waitForTimeout(1200);
  const landed = await p.page.evaluate(`(() => { const el = document.getElementById("g-hang"); return { path: location.pathname, open: !!el && el.closest("details").open,
    focused: document.activeElement && document.activeElement.id, dialog: !!document.querySelector("dialog[open]") }; })()`) as any;
  ok("linkLanded", landed.path === "/settings/agent-defaults" && landed.open && landed.focused === "g-hang" && !landed.dialog);
  await p.page.screenshot({ path: shotPath("2347ie", c as any, "4-linked-hang") });

  ok("noPageErrors", errors.length === 0);
  results.push({ name, failed });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? " " + failed.join(", ") : ""}${errors.length ? " errors=" + JSON.stringify(errors) : ""}`);
  await p.ctx.close();
}
console.log(results.some((r) => r.failed.length) ? "FAIL" : "PASS");
await fx.close();
process.exit(results.some((r) => r.failed.length) ? 1 : 0);

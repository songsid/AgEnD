/**
 * #3822 (SKEW): real Chromium on the real fleet web server (smoke fixture), signed in. A tab older than AgEnD keeps the
 * modules it loaded before an update; one it loads later will not link against them. Reproduced with real link failures:
 * - "outlet": /ui/js/credential-profile-select.js served as alpha.2's (497d56e10^, before #3771 added `accountCli`) — the
 *   exact #3822 error: the agent page's module does not link, so the app's Outlet must ask for a reload, not offer a Retry.
 * - "lazy": /ui/js/panel-settings.js served as a module importing a name its dependency lacks — the agent page itself
 *   loads, its Settings module (loaded when Basic info opens) does not: the reload prompt in place, never the skeleton.
 * Each leg "after" (this tree) and "before" (BASE_REF's app-shell.js and agent-details-settings.js, as the base draws it),
 * EN/zh-TW × desktop/phone × light/dark. Env: REPO, OUT, PW_DIR, BASE_REF (alpha before this fix), HP (port, optional).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { bootFixture, matrix, caseName, labelOf } from "./smoke-fixture/index.mts";

const repo = resolve(process.env.REPO!), out = resolve(process.env.OUT!), base = process.env.BASE_REF!;
if (!base) throw Error("BASE_REF is required");
mkdirSync(out, { recursive: true });
const show = (ref: string, path: string) => execFileSync("git", ["show", `${ref}:${path}`], { cwd: repo, encoding: "utf8" });
const OLD_SELECT = show("497d56e10^", "src/ui/credential-profile-select.js");
if (OLD_SELECT.includes("accountCli")) throw Error("the alpha.2 copy should lack accountCli");
const OLD_CSS = show(base, "src/ui/shared/app.css");   // what an older tab keeps (#3825 r1: no .stale-tab rule in it)
const BEFORE: Record<string, string> = { "/assets/app-shell.js": show(base, "src/ui/shared/app-shell.js"), "/ui/js/agent-details-settings.js": show(base, "src/ui/agent-details-settings.js") };
const UNLINKABLE = `import { notExported3822 } from "/assets/app-html.js";\nexport const x = notExported3822;\n`;
const JS = "text/javascript";

const fx = await bootFixture({ port: Number(process.env.HP ?? 54960), instances: 2, classic: false });
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, ...(detail ? { detail } : {}) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
let reloadChecked = false;
try {
  const agent = fx.instances[0]!.name;
  const cases = matrix(process.env.MATRIX ?? "full");
  const runs = [...cases.flatMap(c => (["lazy", "outlet"] as const).flatMap(leg => (["after", "before"] as const).map(variant => ({ c, leg, variant: variant as "after" | "before" | "after-oldcss" })))),
    // #3825 r1: an older tab keeps its OLD app.css; the Reload must still be a touch target on a phone.
    ...cases.filter(c => c.device === "phone" && c.theme === "light").flatMap(c => (["lazy", "outlet"] as const).map(leg => ({ c, leg, variant: "after-oldcss" as const })))];
  for (const { c, leg, variant } of runs) {
    const { ctx, page } = await fx.page(c);
    if (leg === "lazy") await page.route("**/ui/js/panel-settings.js", (r: any) => r.fulfill({ status: 200, contentType: JS, body: UNLINKABLE }));
    else await page.route("**/ui/js/credential-profile-select.js", (r: any) => r.fulfill({ status: 200, contentType: JS, body: OLD_SELECT }));
    if (variant === "before") for (const [path, body] of Object.entries(BEFORE)) await page.route(`**${path}`, (r: any) => r.fulfill({ status: 200, contentType: JS, body }));
    if (variant === "after-oldcss") await page.route("**/assets/app.css", (r: any) => r.fulfill({ status: 200, contentType: "text/css", body: OLD_CSS }));
    await page.goto(`${fx.base}/ui/fleet/agent/${encodeURIComponent(agent)}?cat=basic`);
    await page.waitForTimeout(4000);                                                        // a skeleton that never ends is the failure
    const prompt = await page.locator("[data-stale-tab]").count(), skeleton = await page.locator(".panel .skeleton, .ap-panel .skeleton, .skeleton").count();
    const retry = await page.locator(".error-state button").count(), name = `${caseName(c)} ${leg} ${variant}`;
    if (variant !== "before") {
      check(`${name}: the reload prompt in place, no skeleton`, prompt === 1 && skeleton === 0, `prompt=${prompt} skeleton=${skeleton}`);
      if (c.device === "phone" && prompt === 1) {
        const box = await page.locator("[data-stale-tab] button").boundingBox();
        check(`${name}: Reload is a touch target (≥ 44 px)`, !!box && box.height >= 44 && box.width >= 44, box ? `${Math.round(box.width)}×${Math.round(box.height)}` : "no box");
      }
      if (prompt === 1) check(`${name}: in the page's language`, (await page.locator("[data-stale-tab]").innerText()).includes(labelOf(c, { en: "This tab is older than AgEnD now.", zh: "這個分頁比 AgEnD 舊。" })));
    } else {
      check(`${name}: (base) no reload prompt — ${leg === "lazy" ? "the skeleton stays" : "a Retry that cannot help"}`, prompt === 0 && (leg === "lazy" ? skeleton > 0 : retry > 0), `skeleton=${skeleton} retry=${retry}`);
    }
    // The failure is the browser's own: importing the same module in this page is refused at link time.
    const linked = await page.evaluate((u: string) => import(u).then(() => "linked", (e: Error) => `${e.constructor.name}: ${e.message}`), leg === "lazy" ? "/ui/js/panel-settings.js" : "/ui/js/panel-details.js");
    check(`${name}: the browser really refused to link`, /^SyntaxError: .*does not provide an export named/.test(linked), linked.slice(0, 150));
    await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))); });
    await page.screenshot({ path: join(out, `${leg}.${variant}.${caseName(c)}.png`) });
    if (variant === "after" && prompt === 1 && !reloadChecked) {
      reloadChecked = true;
      const loaded = page.waitForEvent("load");
      await page.locator("[data-stale-tab] button").click();
      await loaded;
      check(`${name}: Reload reloads the tab`, true);
    }
    await ctx.close();
  }
} finally {
  writeFileSync(join(out, "receipt.json"), JSON.stringify({ base, oldSelect: "497d56e10^:src/ui/credential-profile-select.js", results }, null, 2));
  await fx.close();
}
const failed = results.filter(r => !r.ok).length;
console.log(JSON.stringify({ pass: failed === 0, checks: results.length, failed }));
process.exit(failed ? 1 : 0);

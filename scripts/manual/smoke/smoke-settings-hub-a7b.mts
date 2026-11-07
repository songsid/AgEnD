// alpha.6 feedback (#2): Settings → Hub, in a real browser on the shared fixture (the product's own web server from an
// in-process FleetManager, a scratch home, no fleet start; the Hub switches apply as at a fleet's start — unpaired, the
// member side composes nothing and sends nothing). Full matrix: desk/phone × light/dark × en/zh-TW. Per case:
//   1. Settings search "hub" lists the Hub settings (it listed nothing);
//   2. /settings/hub: the section, its lead, the membership switch; Access & security points to it;
//   3. switching membership on asks for confirmation (the pending card; how it is confirmed is B2's — recorded here);
//   4. confirmed (the fixture saves the switch as the host command would), a reload shows Connect to a Hub's form;
//   no page error, no CSP report, no horizontal scroll.
// LABEL=base: the before pictures only (where the section does not exist, search finds nothing and the card is a sentence).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [LABEL=base|branch] [MATRIX=…] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-settings-hub-a7b.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-settings-hub-a7b";
const LABEL = process.env.LABEL ?? "branch", BASE = LABEL === "base";
const r: Record<string, unknown> = { label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const fx = await bootFixture({ port: 47410, instances: 6 });
const fm = fx.fm as any;
fm.hubEffectsReady = true;                       // as at a fleet's start: the Hub switches apply from here on
const setMember = async (on: boolean) => { fm.saveFleetConfig([{ path: ["hub_member", "enabled"], value: on }]); await new Promise((res) => setTimeout(res, 400)); };
const tall = async (page: any, c: any) => {
  const extra = await page.evaluate(`(() => { const b = document.querySelector(".p-settings .panel-body"); return b ? b.scrollHeight - b.clientHeight : 0; })()`) as number;
  await page.setViewportSize({ width: VIEWPORTS[c.device as "desk" | "phone"].width, height: Math.min(VIEWPORTS[c.device as "desk" | "phone"].height + Math.max(0, extra) + 40, 6000) });
  await page.waitForTimeout(250);
};
try {
  for (const c of matrix()) {
    const cn = caseName(c), zh = c.lang === "zh-TW";
    await setMember(false);
    const { ctx, page, csp } = await fx.page(c, { path: "/settings/agents" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.waitForSelector(".s-section-layout", { timeout: 15000 });
    // 1. Search.
    let search: string[] = [];
    const box = page.locator("#settingsSearch");
    if (await box.count() && await box.isVisible()) {
      await box.fill("hub"); await page.waitForTimeout(500);
      search = await page.evaluate(`[...document.querySelectorAll("#s-find-results .s-find-label")].map((n) => n.textContent.trim())`) as string[];
      await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-1-search`) });
      await box.fill("");
    }
    // 2. The section (base: no such section — the route falls back).
    const res = await page.goto(`${fx.base}/settings/hub`);
    // Base: no such section — recorded (its status and what is drawn), not waited for.
    await page.waitForSelector(".s-section-layout", { timeout: BASE ? 4000 : 15000 }).catch((e: Error) => { if (!BASE) throw e; }); await page.waitForTimeout(900);
    if (BASE) r[`${cn}:status`] = res?.status();
    const section = await page.evaluate(`({ here: document.querySelector("[data-settings-section]")?.getAttribute("data-settings-section"), title: document.querySelector(".s-page-head h2, .page-head h2")?.textContent?.trim() ?? "", lead: document.querySelector(".s-page-lead")?.textContent?.trim() ?? "", toggle: !!document.querySelector("#hubMemberEnabled"), overflowX: document.documentElement.scrollWidth - innerWidth })`) as any;
    await tall(page, c); await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-2-hub-off`) }); await page.setViewportSize(VIEWPORTS[c.device]);
    if (BASE) { r[cn] = { search, section }; await ctx.close(); continue; }
    // Access & security points to it.
    await page.goto(`${fx.base}/settings/access`); await page.waitForSelector(".s-access-related", { timeout: 15000 });
    const pointer = await page.evaluate(`[...document.querySelectorAll(".s-access-related > button strong")].map((n) => n.textContent.trim())`) as string[];
    await page.locator(".s-access-related > button", { hasText: "Hub" }).click(); await page.waitForTimeout(600);
    const went = new URL(page.url()).pathname;
    // 3. Switch on → the pending card.
    await page.waitForSelector("#hubMemberEnabled", { timeout: 10000 });
    await page.click("#hubMemberEnabled"); await page.waitForSelector(".pending-card", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    const pending = await page.evaluate(`(() => { const card = document.querySelector(".pending-card"); return card ? { text: card.innerText.replace(/\\s+/g, " "), cmd: card.querySelector(".pending-cmd code")?.textContent ?? "", copy: [...card.querySelectorAll(".pending-cmd button")].map((b) => b.textContent.trim()) } : null; })()`) as any;
    await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-3-pending`) });
    // 4. Confirmed on the host (the fixture saves it), then a reload: Connect to a Hub.
    await setMember(true);
    await page.reload(); await page.waitForSelector(".s-section-layout", { timeout: 15000 });
    const connect = await page.waitForSelector("#hubAddress", { timeout: 10000 }).then(() => true, () => false);
    const connectText = await page.evaluate(`document.querySelector("#hub-connect")?.innerText.replace(/\\s+/g, " ").slice(0, 300) ?? ""`) as string;
    await tall(page, c); await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-4-connect`) }); await page.setViewportSize(VIEWPORTS[c.device]);
    const cspNow = await csp();
    const got = { search, section, pointer, went, pending, connect, connectText, errs, csp: cspNow };
    const searchOk = c.device === "phone" || search.some((s) => s === (zh ? "連線至 Hub" : "Connect to a Hub")) && search.some((s) => s === (zh ? "允許這個 Fleet 連線至 Hub" : "Allow this fleet to connect to a Hub"));
    check(cn, searchOk && section.here === "hub" && section.title === "Hub" && section.lead.length > 10 && !section.lead.includes("settingsLayout.") && section.toggle && section.overflowX <= 0
      && pointer.includes("Hub") && went === "/settings/hub"
      && !!pending
      && connect && errs.length === 0 && cspNow.length === 0, got);
    await ctx.close();
  }
  // SKEW (a tab kept across the upgrade), desk dark zh-TW, membership on:
  //   old-shell: the OLD /assets (its app-route.js has no "hub") with this branch's Settings modules — the Hub cards stay in
  //     Access & security (and nothing points to a section the tab cannot open);
  //   old-modules: this shell with the OLD lazy Settings modules this branch changed — the old Access still holds the cards.
  if (!BASE) {
    const { execFileSync } = await import("node:child_process");
    const REPO = process.env.REPO!, OLD = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha";
    const old = (f: string) => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD}:src/ui/${f}`], { encoding: "utf8", maxBuffer: 64 << 20 }); } catch { return null; } };
    const changed = execFileSync("git", ["-C", REPO, "diff", "--name-only", OLD, "--", "src/ui"], { encoding: "utf8" }).split("\n").filter(Boolean);
    r.skewChanged = changed;
    await setMember(true);
    const c = matrix("desk-dark-zh-TW")[0]!;
    for (const way of ["old-shell", "old-modules"]) {
      const { ctx, page } = await fx.page(c, { path: "/settings/agents" });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      const served = new Set<string>();
      if (way === "old-shell") await page.route("**/assets/**", (route: any) => {
        const f = new URL(route.request().url()).pathname.replace(/^\/assets\//, ""); const body = old(`shared/${f}`);
        if (body === null) return route.continue(); served.add(f);
        return route.fulfill({ status: 200, contentType: f.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body });
      });
      else await page.route(/\/ui\/js\/([a-z0-9-]+\.js)(\?.*)?$/, (route: any) => {
        const f = /\/ui\/js\/([a-z0-9-]+\.js)/.exec(route.request().url())![1]!; const body = changed.includes(`src/ui/${f}`) ? old(f) : null;
        if (body === null) return route.continue(); served.add(f);
        return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body });
      });
      await page.goto(`${fx.base}/settings/access`); await page.waitForSelector(".s-section-layout", { timeout: 15000 }); await page.waitForTimeout(1200);
      const got = await page.evaluate(`({ membership: !!document.querySelector(".hub-membership-settings input[type=checkbox]"), connect: !!document.querySelector("#hubAddress"), pointer: [...document.querySelectorAll(".s-access-related > button strong")].map((n) => n.textContent.trim()) })`) as any;
      await page.screenshot({ path: shotPath(SMOKE, `skew-${way}`, `${LABEL}-access`) });
      check(`skew-${way}`, served.size > 0 && got.membership && got.connect && !got.pointer.includes("Hub") && errs.length === 0, { served: [...served], ...got, errs });
      await ctx.close();
    }
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : BASE ? "RECORDED" : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}

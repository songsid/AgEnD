// M-3166 (the user's iPhone, keyboard closed, after the browser became ✓ Verified): inside an agent's pages there are no
// bottom tabs (M-3115), and ✓ Verified hides the line under the composer. Nothing then held the home-indicator inset, so the
// composer sat in the screen's rounded corners. The dock now keeps env(safe-area-inset-bottom) itself while the keyboard is down.
// A real Chrome on the shared fixture (in-process FleetManager, scratch home, loopback only), a phone with an iPhone's safe
// area emulated (top 47, bottom 34: CDP Emulation.setSafeAreaInsetsOverride). Per case, keyboard closed, in each of
// verified / not verified × idle / working: the composer's bottom edge is at least the inset above the screen's bottom.
// Then with the keyboard up (the shell's kb-open, as the visual viewport sets it), the dock goes back to its 8 px.
// Run it on the base too (REPO=<base checkout> SMOKE_NAME=…-before): the verified cases FAIL there.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] scripts/manual/smoke/run.sh smoke-dock-safe-area-m3166.mts
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-dock-safe-area-m3166";
const INSET = { top: 47, bottom: 34, left: 0, right: 0 };
const fx = await bootFixture({ port: Number(process.env.HP ?? 48790), instances: 3 });
const fm = fx.fm as any;
const name = fx.instances[1]!.name;
const cases = matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW,phone-dark-en,phone-light-zh-TW").filter((c) => c.device === "phone");
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
try {
  for (const c of cases) {
    const failed: string[] = [];
    const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
    let auth: "verified" | "none" = "none";
    const p = await freshPage(fx, c, { account: "operator", path: `/ui/chat/${encodeURIComponent(name)}`, beforeNavigate: async (ctx: any, page: any) => {
      const s = await ctx.newCDPSession(page);
      await s.send("Emulation.setSafeAreaInsetsOverride", { insets: INSET });
      await ctx.route("**/ui/authorization", async (r: any) => {
        if (r.request().method() !== "GET") return r.continue();
        return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(auth === "verified" ? { state: "verified", until: Date.now() + 3_600_000 } : { state: "none", reason: "no_account" }) });
      });
    } });
    const errs: string[] = []; p.page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await mounted(p.page, 30000);
    const inset = await p.page.evaluate(() => { const d = document.createElement("div"); d.style.paddingBottom = "env(safe-area-inset-bottom)"; document.body.append(d); const v = getComputedStyle(d).paddingBottom; d.remove(); return v; });
    need(inset === `${INSET.bottom}px`, `the emulated inset is in effect (${inset})`);
    for (const a of ["none", "verified"] as const) {
      auth = a;
      await p.page.goto(`${fx.base}/ui/chat/${encodeURIComponent(name)}`);
      await p.page.waitForSelector("#msgIn", { timeout: 20000 });
      await p.page.waitForSelector(`.webauth-row[data-state="${a}"]`, { state: "attached", timeout: 10000 }).catch(() => {});
      for (const exec of ["idle", "working"] as const) {
        await p.page.evaluate(async ([n, e]: [string, string]) => {
          const m = await import("/assets/app-store.js");
          m.appStore.set((s: any) => ({ ...s, exec: { ...s.exec, [n]: e } }));
        }, [name, exec]);
        await p.page.waitForTimeout(400);
        const m = await p.page.evaluate(() => {
          const box = document.querySelector(".composer") as HTMLElement, dock = box?.closest(".dock") as HTMLElement | null;
          return { gap: Math.round(innerHeight - box.getBoundingClientRect().bottom), pad: dock ? getComputedStyle(dock).paddingBottom : null,
            row: !!document.querySelector(".composer-row") && getComputedStyle(document.querySelector(".composer-row")!).display !== "none" };
        });
        need(m.gap >= INSET.bottom, `${a}/${exec}: the composer is ${m.gap}px above the screen's bottom (want ≥ ${INSET.bottom}; the line under it ${m.row ? "shown" : "hidden"})`);
        await p.page.screenshot({ path: shotPath(SMOKE, caseName(c), `${a}-${exec}`) });
      }
    }
    // Keyboard up: the dock goes back to its own 8 px (the keyboard covers the inset's area; the box sits on the keyboard).
    const kb = await p.page.evaluate(() => {
      const shell = document.querySelector(".shell")!, dock = document.querySelector(".dock") as HTMLElement;
      shell.classList.add("kb-open"); const v = getComputedStyle(dock).paddingBottom; shell.classList.remove("kb-open"); return v;
    });
    need(kb === "8px", `keyboard up: the dock's bottom padding is 8px (${kb})`);
    need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    results.push({ name: caseName(c), ok: failed.length === 0, failed });
    await p.ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length === cases.length && results.every((r) => r.ok) ? 0 : 1);

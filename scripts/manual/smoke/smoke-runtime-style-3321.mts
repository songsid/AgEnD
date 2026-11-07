// Ridge #3321 (Settings style review), the Runtime items, in a real browser on the shared fixture (the product's own web
// server, a scratch home, no fleet start). The Runtime reads answer a synthetic paired Windows computer ("Design workstation",
// one CLI); every write is refused and no pairing, install or rename happens. Desk light zh-TW, phone dark zh-TW, desk light en:
//   S05 — Connect a computer: the address and the pairing code are the shared field (≥ 40 px high, rounded, padded);
//   S06 — Install a CLI while the computer's setting is still being read: the loading state, no disabled buttons with empty
//         versions; once read, the list;
//   S09 — Other CLIs: labelled command cards with Copy;
//   S11 — Rename: a shared field in the body, Cancel and Save in the dialog's footer;
//   S17 — English counts: "1 computer", "1 CLI";
//   no page error, no CSP report, no horizontal scroll.
// LABEL=base: the before pictures and measures only.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [LABEL=base|branch] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-runtime-style-3321.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-runtime-style-3321";
const LABEL = process.env.LABEL ?? "branch", BASE = LABEL === "base";
const r: Record<string, unknown> = { label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const ID = "12345678-1234-4321-abcd-123456789012";
const cli = { id: "claude-code", path: "C:\\tools\\claude.exe", runnable: true, authenticated: true, version: "2.1.316 (Claude Code)", supports: { execution: true, resume: true, mcp: true }, models: [] };
const machine = { id: ID, name: "Design workstation", status: "online", platform: "win32", hostname: "DESKTOP-7Q2", lastSeenAt: Date.now(), inventoryUpdatedAt: Date.now(),
  runtimeInfo: { version: "2.3.5-alpha", buildId: "a".repeat(64), protocolVersions: [1], capabilities: ["exec", "mcp", "panes", "credential-profiles", "remote-setup", "cli-install"] },
  inventory: { home: "C:\\Users\\design", clis: [cli] } };
const setup = { capable: true, online: true, switches: { accounts: { on: false }, install: { on: false } }, job: null, catalog: [{ id: "claude-code", version: "2.1.316" }, { id: "codex", version: "0.165.0" }] };
const fx = await bootFixture({ port: 47450, instances: 4 });
const FIELD = `(sel) => { const el = document.querySelector(sel); if (!el) return null; const s = getComputedStyle(el); return { h: Math.round(el.getBoundingClientRect().height), radius: parseFloat(s.borderTopLeftRadius), padL: parseFloat(s.paddingLeft) }; }`;
try {
  for (const c of matrix("desk-light-zh-TW,phone-dark-zh-TW,desk-light-en")) {
    const cn = caseName(c);
    const { ctx, page, csp } = await fx.page(c, { path: "/settings/agents" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    let releaseSetup: (() => void) | null = null;
    const held = new Promise<void>((done) => { releaseSetup = done; });
    const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
    await page.route(/\/ui\/runtimes(\/.*)?(\?.*)?$/, async (route: any) => {
      const url = new URL(route.request().url()), method = route.request().method();
      if (url.pathname === "/ui/runtimes") return route.fulfill(json({ enabled: true, machines: [machine] }));
      if (url.pathname === "/ui/runtimes/pairing" && method === "POST") return route.fulfill(json({ pairingId: "smoke", code: "PAIR-SMOK-E123", expiresAt: Date.now() + 600_000 }));
      if (url.pathname.endsWith("/remote-setup")) { await held; return route.fulfill(json(setup)); }
      if (method !== "GET") return route.fulfill(json({ error: "refused by the smoke" }, 409));
      return route.continue();
    });
    await page.goto(`${fx.base}/settings/runtimes`);
    await page.waitForSelector(`[data-machine-id="${ID}"]`, { timeout: 15000 }); await page.waitForTimeout(600);
    // S06: the install card while its read is held.
    const loading = await page.evaluate(`(() => { const box = document.querySelector('[data-machine-id="${ID}"] .runtime-cli-install'); if (!box) return null;
      return { skeleton: !!box.querySelector(".skeleton, [aria-busy=true]"), installButtons: [...box.querySelectorAll("button")].filter((b) => !b.closest(".runtime-cli-install-others")).map((b) => b.textContent.trim()) }; })()`) as any;
    await page.locator(`[data-machine-id="${ID}"]`).screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-1-install-loading`) });
    releaseSetup!(); await page.waitForTimeout(700);
    const counts = await page.evaluate(`({ computers: document.querySelector(".runtime-computers-heading .note")?.textContent.trim() ?? "", card: document.querySelector('[data-machine-id="${ID}"] header p')?.textContent.trim() ?? "" })`) as any;
    // S09: Other CLIs.
    await page.evaluate(`document.querySelectorAll(".runtime-cli-install-others").forEach((d) => { d.open = true; })`); await page.waitForTimeout(300);
    const others = await page.evaluate(`[...document.querySelectorAll('.runtime-cli-install .runtime-command-card')].map((c) => ({ label: c.querySelector(".runtime-command-label")?.textContent ?? "", copy: !!c.querySelector("button") }))`) as any[];
    await page.locator(`[data-machine-id="${ID}"]`).screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-2-install-read`) });
    // S05: Connect a computer.
    await page.locator(".runtime-heading .btn-primary").click(); await page.waitForSelector(".runtime-pairing", { timeout: 10000 }); await page.waitForTimeout(500);
    const address = await page.evaluate(`(${FIELD})('.runtime-step input[type=url]')`), code = await page.evaluate(`(${FIELD})('.runtime-pair-code')`);
    await page.locator(".runtime-pairing").screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-3-connect`) });
    // S11: Rename.
    await page.locator(`[data-machine-id="${ID}"] .runtime-machine-menu > button`).click(); await page.waitForTimeout(200);
    await page.locator(`.runtime-machine-menu [role=menuitem]`, { hasText: c.lang === "zh-TW" ? "重新命名" : "Rename" }).click(); await page.waitForTimeout(500);
    const rename = await page.evaluate(`(() => { const d = [...document.querySelectorAll("dialog[open]")].pop(); if (!d) return null; const foot = d.querySelector(".dlg-actions, .dlg-foot, footer");
      return { footer: foot ? [...foot.querySelectorAll("button")].map((b) => b.textContent.trim()) : [], field: (${FIELD})("dialog[open] .runtime-rename input") }; })()`) as any;
    await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-4-rename`) });
    const got = { loading, counts, others, address, code, rename, errs, csp: await csp(), pageX: await page.evaluate("document.documentElement.scrollWidth - innerWidth") };
    if (BASE) { r[cn] = got; await ctx.close(); continue; }
    const field = (f: any) => !!f && f.h >= 40 && f.radius >= 6 && f.padL >= 8;
    const en = c.lang === "en";
    check(cn, !!loading && loading.skeleton && loading.installButtons.length === 0
      && (!en || counts.computers === "1 computer" && counts.card.endsWith("1 CLI"))
      && others.length >= 2 && others.every((o: any) => o.label && o.copy)
      && field(address) && field(code) && !!rename && rename.footer.length === 2 && field(rename.field)
      && errs.length === 0 && (got.csp as string[]).length === 0 && got.pageX <= 0, got);
    await ctx.close();
  }
  // SKEW (a tab kept across the upgrade), desk light en: the OLD /assets (shell, app.css, runtime-install.css) with these modules,
  // and this shell with the OLD panel-runtimes.js / runtime-cli-install.js. The Runtime page and the computer card still draw.
  if (!BASE) {
    const { execFileSync } = await import("node:child_process");
    const REPO = process.env.REPO!, OLD = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha";
    const old = (f: string) => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD}:src/ui/${f}`], { encoding: "utf8", maxBuffer: 64 << 20 }); } catch { return null; } };
    for (const way of ["old-shell", "old-modules"]) {
      const c = matrix("desk-light-en")[0]!;
      const { ctx, page } = await fx.page(c, { path: "/settings/agents" });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      const served = new Set<string>();
      await page.route(/\/ui\/runtimes(\/.*)?(\?.*)?$/, (route: any) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/ui/runtimes") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true, machines: [machine] }) });
        if (url.pathname.endsWith("/remote-setup")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(setup) });
        return route.request().method() === "GET" ? route.continue() : route.fulfill({ status: 409, contentType: "application/json", body: "{}" });
      });
      if (way === "old-shell") await page.route("**/assets/**", (route: any) => { const f = new URL(route.request().url()).pathname.replace(/^\/assets\//, ""); const body = old(`shared/${f}`);
        if (body === null) return route.continue(); served.add(f); return route.fulfill({ status: 200, contentType: f.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body }); });
      else await page.route(/\/ui\/js\/(panel-runtimes|runtime-cli-install)\.js(\?.*)?$/, (route: any) => { const f = /\/ui\/js\/([a-z-]+\.js)/.exec(route.request().url())![1]!; served.add(f);
        return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: old(f)! }); });
      await page.goto(`${fx.base}/settings/runtimes`);
      const drawn = await page.waitForSelector(`[data-machine-id="${ID}"] .runtime-cli-install`, { timeout: 15000 }).then(() => true, () => false);
      await page.waitForTimeout(600);
      await page.screenshot({ path: shotPath(SMOKE, `skew-${way}`, `${LABEL}-runtime`) });
      check(`skew-${way}`, drawn && served.size > 0 && errs.length === 0, { drawn, served: [...served], errs });
      await ctx.close();
    }
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : BASE ? "RECORDED" : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}

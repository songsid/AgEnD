// M-2682 part B: fleet Settings → Hub → "HTML previews on this Hub", on the shared Settings fixture (the product's web server
// from an in-process FleetManager, scratch home, loopback only). The fixture runs no Hub, so this page's read of fleet.yaml is
// given a `hub:` block in the browser, and /api/settings/hub/preview answers in the browser too (the server's checks:
// tests/hub-preview-settings*-m2682.test.ts). Pictures and checks, 8-case matrix: off with a suggested port; switched on;
// saved; a refused port shows its plain sentence; no sideways scroll; no page error, no CSP report. A phone's control sizes
// are recorded (the shared Settings .btn and .check, as on the retention card beside it).
//   PW_DIR=<dir> REPO=<checkout> OUT=<dir> [MATRIX=…] FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-hub-preview-settings-m2682.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix } from "../smoke-fixture/index.mts";

const OUT = join(process.env.OUT ?? "/tmp/smoke-out", "hub-preview-settings-m2682");
mkdirSync(OUT, { recursive: true });
const CASES = matrix(process.env.MATRIX ?? "full");
const HUB = { enabled: true, hubId: "4c3b2a19-0e8f-4d7c-9b6a-5f4e3d2c1b0a", name: "Team Hub", webOrigin: "https://hub.example.test:8444", memberOrigin: "https://hub.example.test:8443",
  webListen: { host: "0.0.0.0", port: 8444 }, memberListen: { host: "0.0.0.0", port: 8443 } };
const r: Record<string, unknown> = {}, fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const fx = await bootFixture({ port: 19470, instances: 4, classic: false });
try {
  for (const c of CASES) {
    const name = caseName(c), zh = c.lang === "zh-TW";
    const { ctx, page, csp } = await fx.page(c, { path: "/settings" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.route((u: URL) => u.pathname === "/api/settings/fleet/raw", async (route: any) => {
      const real = await route.fetch(); const body = await real.json();
      return route.fulfill({ status: real.status(), contentType: "application/json; charset=utf-8", body: JSON.stringify({ ...body, hub: HUB }) });
    });
    let view = { ok: true, hosted: true, enabled: false, port: null as number | null, suggested: 8445 }, refuse: string | null = null;
    const puts: unknown[] = [];
    await page.route((u: URL) => u.pathname === "/api/settings/hub/preview", async (route: any) => {
      const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
      if (route.request().method() === "GET") return json(200, view);
      const body = JSON.parse(route.request().postData() || "{}"); puts.push(body);
      if (refuse) return json(409, { ok: false, error: refuse });
      view = { ...view, enabled: body.enabled, port: body.enabled ? body.port : null };
      return json(200, view);
    });
    await page.goto(fx.base + "/settings/hub");
    await page.waitForSelector(".hub-preview-settings form", { timeout: 15000 });
    const card = async () => page.evaluate(`(() => { const c = document.querySelector(".hub-preview-settings"); c.scrollIntoView({ block: "center" }); const b = c.getBoundingClientRect();
      return { text: c.innerText, on: document.querySelector("#hubPreviewOn")?.checked, port: document.querySelector("#hubPreviewPort")?.value ?? null,
        over: [...c.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > b.right + 1).length, pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        button: (() => { const x = c.querySelector("button"); const r = x.getBoundingClientRect(); return { disabled: x.disabled, h: Math.round(r.height), w: Math.round(r.width) }; })(),
        toggle: (() => { const l = document.querySelector("#hubPreviewOn").closest("label").getBoundingClientRect(); return Math.round(Math.min(l.height, l.width)); })(),
        status: c.querySelector("[role=status]")?.textContent ?? null }; })()`) as Promise<any>;
    await page.waitForTimeout(300);
    const off = await card();
    await page.screenshot({ path: join(OUT, `${name}-off.png`) });
    check(`${name}:off`, off.on === false && off.port === null && off.button.disabled === true && off.text.includes(zh ? "這個 Hub 的 HTML 預覽" : "HTML previews on this Hub") && off.over === 0 && off.pageX <= 0, off);
    await page.click("#hubPreviewOn");
    const on = await card();
    await page.screenshot({ path: join(OUT, `${name}-on.png`) });
    check(`${name}:on`, on.on === true && on.port === "8445" && on.button.disabled === false && on.over === 0, on);
    // The shared Settings .btn and .check, at the same size as the retention card's beside it (the tap ratchet's baseline): recorded.
    if (c.device === "phone") r[`${name}:sizes`] = { button: on.button, toggle: on.toggle };
    refuse = "port_in_use";
    await page.click(".hub-preview-settings button[type=submit]"); await page.waitForSelector(".hub-preview-settings [role=status]", { timeout: 8000 });
    const refused = await card();
    await page.screenshot({ path: join(OUT, `${name}-refused.png`) });
    check(`${name}:refused`, refused.status === (zh ? "這台電腦上已經有程式在使用這個連接埠，請換一個。" : "Something on this computer is already using that port. Pick another."), refused);
    refuse = null;
    await page.fill("#hubPreviewPort", "9443");
    await page.click(".hub-preview-settings button[type=submit]"); await page.waitForTimeout(400);
    const saved = await card();
    await page.screenshot({ path: join(OUT, `${name}-saved.png`) });
    check(`${name}:saved`, JSON.stringify(puts.at(-1)) === JSON.stringify({ enabled: true, port: 9443 }) && saved.status === (zh ? "已儲存。Hub 會重新載入以套用。" : "Saved. The Hub reloads to apply it.") && saved.button.disabled === true, { puts, saved });
    check(`${name}:no-errors`, errs.length === 0 && (await csp()).length === 0, { errs, csp: await csp() });
    await ctx.close();
  }
} catch (e) { fail.push(`exception: ${(e as Error).message}`); r.exception = String((e as Error).stack || e).slice(0, 1000); }
finally {
  await fx.close?.();
  writeFileSync(join(OUT, "result.json"), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([, v]) => v !== "PASS")), null, 2));
  console.log(`${Object.values(r).filter((v) => v === "PASS" || (v as any)?.FAIL).length} checks; ` + (fail.length ? `FAIL ${fail.length}: ${fail.join(", ")}` : "ALL PASS"));
  process.exit(fail.length ? 1 : 0);
}

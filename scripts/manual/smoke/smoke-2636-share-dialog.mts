// #2636 part 3, through visible navigation: Office share links on the dashboard. A demo fleet with a stored office (HQ);
// the share service runs on a FAKE tunnel (no cloudflared, no network: the trycloudflare 429 lessons) that comes up at
// once, or refuses with a 429 when asked to. Fleet → Org chart → Office → Share…: pick HQ, 2 hours, status lines on,
// Create → the URL to copy; then a 429 says to try again later; then Settings → Access & security → Office share links
// lists the open ones, and Revoke all empties it. Cases: desk light en, desk dark zh-TW.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2636-share-dialog.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";
import { OfficeShareService } from "../../../src/office-share-service.js";

const SMOKE = "2636-share-dialog";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48877), classic: false });
const fm: any = fx.fm, dir = fm.dataDir ?? fx.dir;
const MEMBERS = ["atlas", "quill", "sage", "nova", "tide"];
fm.fleetConfig.instances = Object.fromEntries(["general", ...MEMBERS].map((name, i) => [name, { working_directory: dir, backend: ["claude-code", "codex"][i % 2], ...(name === "general" ? { general_topic: true } : {}) }]));
fm.fleetConfig.teams = { Core: { members: MEMBERS } };
fm.getInstanceStatus = () => "running";
fm.officeStore.replace([{ id: "hq", name: "HQ", skin: "studio", members: ["team:Core"] }, { id: "lab", name: "Lab", members: ["atlas"] }]);
let refuse = false, n = 0;
const said: string[] = [];
fm.notifyFleetError = (text: string) => { said.push(text); return true; };
fm.officeSharesInstance = new OfficeShareService({
  source: { status: () => fm.getUiStatus(), org: () => fm.orgChart(), offices: () => fm.officeStore.list(), acts: () => [], traffic: () => ({ now: "", items: [] }), needs: () => [], hidden: () => false },
  manager: {
    start: async (_p: unknown, ctx: { onCandidateHost?(h: string): void }) => {
      if (refuse) return { ok: false, errorKind: "rate-limited", message: "429 Too Many Requests", leaseHeld: false } as never;
      const host = `smoke-${++n}.trycloudflare.com`; ctx.onCandidateHost?.(host);
      return { ok: true, handle: { pageUrl: `https://${host}/ready`, onUnexpectedExit: () => () => {} } } as never;
    },
    stop: async () => ({ confirmed: true }) as never,
  },
  ensure: async () => ({ path: "/nonexistent/cloudflared" }), provider: () => ({}) as never,
  config: () => fm.fleetConfig?.web?.office_share, officeExists: (id: string) => fm.officeStore.list().offices.some((o: { id: string }) => o.id === id), ownerCurrent: () => true,
});
const r: any = { cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const en = c.lang === "en";
  const p = await freshPage(fx, c as any).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page, base } = p;
  const shot = (s: string) => page.screenshot({ path: shotPath(SMOKE, tag, s) });
  try {
    refuse = false;
    ok(res, "mounted", await mounted(page, 30000));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/ui/fleet/org`);
    await page.locator(".oc-tools .seg-inline button", { hasText: en ? "Office" : "辦公室" }).click();
    await page.waitForSelector(".oo-canvas", { timeout: 15000 }); await page.waitForTimeout(500);
    ok(res, "shareButton", (await page.locator(".oo-share").textContent())?.trim() === (en ? "Share…" : "分享…"));
    await page.locator(".oo-share").click(); await page.waitForSelector(".os-form");
    const [office, time] = await page.locator(".os-form select").all();
    await office.selectOption("hq"); await time.selectOption("120"); await page.locator(".os-form input[type=checkbox]").check();
    await shot("1-share-form");
    await page.locator("dialog.dlg[open] .dlg-actions button.btn-primary").click();
    await page.waitForSelector(".os-url", { timeout: 10000 });
    const url = await page.locator(".os-url").inputValue();
    ok(res, "url", /^https:\/\/smoke-\d+\.trycloudflare\.com\/o\/[A-Za-z0-9_-]{43}$/.test(url), url.replace(/\/o\/.*/, "/o/<token>"));
    await page.waitForSelector(".os-row", { timeout: 5000 }).catch(() => {});
    ok(res, "listed", (await page.locator(".os-row").count()) === 1, await page.locator(".os-row").count());
    await shot("2-share-made");
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    refuse = true;
    await fm.officeSharesInstance.revoke("all");   // the tunnel stops; the next link asks for a new one
    await page.waitForTimeout(100);
    await page.locator(".oo-share").click(); await page.waitForSelector(".os-form");
    await page.locator("dialog.dlg[open] .dlg-actions button.btn-primary").click();
    await page.waitForSelector(".os-form [role=alert]", { timeout: 10000 });
    const alert = (await page.locator(".os-form [role=alert]").textContent()) ?? "";
    ok(res, "rate", en ? alert.includes("Try again in a few minutes") : alert.includes("請過幾分鐘再試"), alert);
    await shot("3-rate-limited");
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    refuse = false;
    await fm.officeSharesInstance.create({ office: "hq", owner: "admin-session" });
    await fm.officeSharesInstance.create({ office: "all", owner: "admin-session", text: true, minutes: 30 });
    await page.goto(`${base}/settings/access`);
    await page.waitForSelector(".os-card", { timeout: 15000 });
    await page.locator(".os-card").scrollIntoViewIfNeeded();
    ok(res, "card", (await page.locator(".os-card .os-row").count()) === 2);
    await page.locator(".os-card").screenshot({ path: shotPath(SMOKE, tag, "4-settings-card") });
    await page.locator(".os-card .os-all").click(); await page.waitForTimeout(800);
    ok(res, "revokedAll", (await page.locator(".os-card .os-none").count()) === 1 && fm.officeSharesInstance.list().length === 0);
    ok(res, "noUrlInGeneral", said.every((t) => !t.includes("trycloudflare")), said.length);
    // The 429 case's own answer (503 from POST /ui/office-share) is the one error a browser logs here.
    const errors = p.errors.filter((e: string) => !/status of 503 .*\/ui\/office-share$/.test(e));
    ok(res, "errors", errors.length === 0, errors.slice(0, 5));
  } catch (err) { res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 300)}`]; }
  await p.ctx.close();
}
await fm.officeSharesInstance.close();
writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1));
await fx.close();
process.exit(Object.values(r.cases).some((c: any) => c.failed) ? 1 : 0);

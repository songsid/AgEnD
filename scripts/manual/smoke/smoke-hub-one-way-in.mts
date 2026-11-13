// P6 "one way in" (user decision 2aeecd58) and #3840 (the pairing-code form), in a real Chrome. The shared fixture
// (in-process FleetManager, scratch home, loopback; no Hub contacted): the company-join probe and the membership read are
// routed. Run with REPO at the change (AFTER=1, judged) and at its base (pictures only).
//   1. A Hub that answers it takes company sign-in: "Other ways" is gone (after) / still offered (before).
//   2. A Hub without company sign-in: "Other ways" open, a join code typed into the pairing-code field.
//   PW_DIR=… REPO=<checkout> OUT=<dir> [AFTER=1] [MATRIX=…] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-hub-one-way-in.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.env.REPO!, OUT = join(process.env.OUT!, "hub-one-way-in"), AFTER = process.env.AFTER === "1";
mkdirSync(OUT, { recursive: true });
const r: Record<string, unknown> = {}, fail: string[] = [];
const CASES = (process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW").split(",").map((s) => {
  const [device, theme, ...lang] = s.split("-"); return { device: device as "desk" | "phone", theme: theme as "light" | "dark", lang: lang.join("-") as "en" | "zh-TW" };
});
const tagOf = (c: (typeof CASES)[number]) => `${c.device}-${c.theme}-${c.lang}`;
const probe = (companyJoin: boolean) => ({ ok: true, hubName: "Acme Hub", webOrigin: "https://hub.example.test", companyJoin, identity: "new", separateHosts: true, suggestedLabel: "build-box", features: [] });

const { bootFixture } = await import(REPO + "/scripts/manual/smoke-fixture/index.mts");
const fx: any = await bootFixture({ port: Number(process.env.HP ?? 54980), instances: 1, classic: false });
for (const name of ["startInstance", "startInstanceUnattended", "restartInstance", "restartFleet", "stopInstance"]) fx.fm[name] = async () => { throw Error("Refused lifecycle " + name); };
try {
  for (const c of CASES) for (const step of [1, 2]) {
    const tag = tagOf(c), en = c.lang === "en";
    const { ctx, page } = await fx.page(c, { path: "/settings/hub" });
    await ctx.route("**/*", (route: any) => {
      const u = new URL(route.request().url()); if (u.origin !== fx.base) return route.abort();
      const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      if (u.pathname === "/api/hub/member/company-join/probe") return json(probe(step === 1));
      if (u.pathname === "/api/hub/member/pairing" && route.request().method() === "GET") return json({ pairing: { state: "unpaired" }, notices: [] });
      if (u.pathname === "/api/hub/member/exposures" && route.request().method() === "GET") return json({ exposures: [] });
      if (u.pathname === "/api/hub/member/company-join" && route.request().method() === "GET") return json({ ok: true, bound: false, operation: null, display: null });
      if (u.pathname === "/api/settings/hub/membership" && route.request().method() === "GET") return json({ ok: true, enabled: true, connectionCardV1: true, pairing: { state: "unpaired" } });
      return route.continue();
    });
    await page.reload();
    await page.waitForSelector("#hubCompanyAddress", { timeout: 20000 }).catch(async (e: Error) => { await page.screenshot({ path: join(OUT, `debug-${tagOf(c)}.png`), fullPage: true }); writeFileSync(join(OUT, "debug.txt"), await page.evaluate("document.body.innerText")); throw e; });
    await page.fill("#hubCompanyAddress", "hub.example.test"); await page.locator("#hubCompanyAddress").blur();
    await page.waitForTimeout(800);
    if (step === 2) {
      const other = page.locator("details.hub-connection-manual");
      if (await other.count()) { await other.locator("summary").click(); await page.waitForTimeout(300); }
      if (await page.locator("#hubCode").count()) {
        await page.fill("#hubAddress", "https://hub.example.test:19443"); await page.fill("#hubCode", "ABCD-EFGH"); await page.waitForTimeout(300);
      }
    }
    const facts = await page.evaluate(`(() => ({ other: !!document.querySelector("details.hub-connection-manual"),
      shape: document.querySelector(".hub-code-shape")?.textContent ?? null,
      hint: document.querySelector("#hubAddress")?.parentElement?.querySelector("small.note")?.textContent ?? null,
      submit: document.querySelector("form.hub-connect button[type=submit]")?.disabled ?? null }))()`) as any;
    const card = page.locator("section.card", { has: page.locator("#hubCompanyAddress") }).first();
    await card.scrollIntoViewIfNeeded().catch(() => {});
    const file = join(OUT, `${tag}-${step}-${step === 1 ? "company-hub" : "join-code-in-pairing-form"}.png`);
    if (step === 2 && c.device === "phone") { // the bottom bar covers the end of a tall card: show the code field and its line instead
      await page.evaluate(`document.querySelector("#hubCode")?.scrollIntoView({ block: "center" })`); await page.waitForTimeout(200); await page.screenshot({ path: file });
    } else await card.screenshot({ path: file }).catch(() => page.screenshot({ path: file, fullPage: true }));
    r[`${tag}-${step}`] = facts;
    if (AFTER) {
      const ok = step === 1 ? facts.other === false
        : facts.other === true && facts.submit === true && facts.shape === (en ? "This is a join code. In “Hub address” at the top of this card, type the address, a space, then this code." : "這是加入碼。請在這張卡片最上方的「Hub 位址」輸入位址、空一格，再輸入這組碼。")
          && facts.hint === (en ? "The address shown with the pairing code (it ends in a port). It is not the address of the Hub's pages." : "配對碼一起提供的位址（結尾有連接埠），不是 Hub 網頁的位址。");
      if (!ok) fail.push(`${tag}-${step}: ${JSON.stringify(facts)}`);
    }
    await ctx.close();
  }
} catch (e) { fail.push(String((e as Error).stack ?? e).slice(0, 800)); }
finally { await fx.close(); }
writeFileSync(join(OUT, "result.json"), JSON.stringify({ r, fail }, null, 2));
console.log(fail.length ? "FAIL\n" + fail.join("\n") : `PASS ${Object.keys(r).length} shots`);
process.exit(fail.length ? 1 : 0);

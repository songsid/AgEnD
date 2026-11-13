// M-3007: an agent the owner switched on, which the Hub refused by policy (no sharing permission), on Settings → Hub —
// in a real Chrome on the shared fixture (in-process FleetManager, scratch home, loopback only; no Hub, no fleet). This
// fixture is not a Hub member, so the Share card is mounted in the connection card's place on a page-local paired client
// whose list answers one published row the way the member's exposure list now marks it ("hub_refused"). Run with REPO at
// the change (AFTER=1, judged) and at its base (pictures only: the base ignores the mark and shows "Shared").
//   PW_DIR=… REPO=<checkout> OUT=<dir> [AFTER=1] [MATRIX=…] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-hub-share-refused-m3007.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.env.REPO!, OUT = join(process.env.OUT!, "hub-share-refused-m3007"), AFTER = process.env.AFTER === "1";
mkdirSync(OUT, { recursive: true });
const { bootFixture, matrix, caseName } = await import(REPO + "/scripts/manual/smoke-fixture/index.mts");
const r: Record<string, unknown> = {};
const fail: string[] = [];
const fx: any = await bootFixture({ port: Number(process.env.HP ?? 54950), instances: 2, classic: false });
for (const name of ["startInstance", "startInstanceUnattended", "restartInstance", "restartFleet", "stopInstance"]) fx.fm[name] = async () => { throw Error("Refused lifecycle " + name); };
const agent = fx.instances[0]!.name as string;
try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW")) {
    const tag = caseName(c), en = c.lang === "en";
    const { ctx, page } = await fx.page(c, { path: "/settings/hub" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.waitForSelector("#hub-connection", { timeout: 20000 });
    await page.evaluate(`(async () => {
      const m = await import("/ui/js/hub-client.js");
      const row = { agent: ${JSON.stringify(agent)}, display: ${JSON.stringify(agent)}, exposureId: "11111111-2222-4333-8444-555555555555", revision: 2,
        state: "published", policy: { dataView: "agent", tools: [] }, enforceable: true, reason: "hub_refused",
        choices: { dataViews: [{ id: "agent", label: "x" }], tools: [] }, pending: null };
      m.setHubClient({ stub: false, subscribe: () => () => {}, exposures: async () => [row], setExposed: async () => ({ ok: true, remote: "pending" }),
        pairing: async () => ({ state: "paired", hub: { hubId: "h", name: "Acme Hub", memberOrigin: "https://synthetic-hub.example.test", webOrigin: "https://synthetic-hub.example.test", fingerprint: { kind: "hub-key", digest: "a".repeat(64) } }, link: "online" }) });
      const { render, h } = await import("/assets/preact.module.js");
      const card = await import("/ui/js/settings-hub.js");
      const at = document.querySelector("#hub-connection"), host = document.createElement("div");
      at.parentElement.insertBefore(host, at); at.style.display = "none";
      render(h(card.HubConnectCard, {}), host);
    })()`);
    await page.waitForSelector(".hub-exposure input", { timeout: 15000 }); await page.waitForTimeout(500);
    const facts = await page.evaluate(`(() => { const box = document.querySelector(".hub-exposure input"), li = document.querySelector(".hub-exposure");
      return { checked: box.checked, disabled: box.disabled, text: li.innerText.replace(/\\s+/g, " ").trim(),
        allowLink: !!li.querySelector('a[href*="grant=1"]') }; })()`);
    await page.locator(".hub-exposures").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(OUT, `${tag}-refused-row.png`) });
    r[tag] = facts;
    if (AFTER) {
      const ok = !facts.checked && facts.disabled && !facts.allowLink && (en ? /Not shared: your Hub administrator hasn't allowed you to share agents/.test(facts.text) && /Don't share it/.test(facts.text) && !/Shared: Hub questions/.test(facts.text)
        : /未分享：Hub 管理員還沒有允許你分享 Agent/.test(facts.text) && /不要分享/.test(facts.text) && !/已分享：/.test(facts.text)) && errs.length === 0;
      if (!ok) fail.push(`${tag}: ${JSON.stringify({ facts, errs })}`);
    }
    await ctx.close();
  }
} catch (e) { fail.push("error " + String((e as Error).stack ?? e).slice(0, 1200)); }
finally {
  writeFileSync(join(OUT, "result.json"), JSON.stringify({ r, fail }, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL\n${fail.join("\n")}` : AFTER ? "ALL PASS" : "captured (before: not judged)");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}

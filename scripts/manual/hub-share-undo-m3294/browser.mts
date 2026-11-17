/** Real scratch Fleet dashboard → Settings API + local sharing journal/writer. Headless WSL; no live Fleet or Hub. */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { bootFixture, freshPage, mounted, shotPath, matrix, caseName } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49430), classic: false, host: true,
  roster: [{ name: "Docs", displayName: "Documents", backend: "codex" }, { name: "Planner", displayName: "Planning helper", backend: "claude-code" }] });
const [{ default: Database }, { HUB_EXPOSURE_MIGRATION, HubExposureStore }, { createHubMemberExposureApi },
  { HUB_MEMBER_SHARING_MIGRATION, HubMemberSharingJournal }, { HubMemberSharing }, { memberAgentCatalog }, { sharingNotice },
  { createHubAudit, HUB_AUDIT_MIGRATION }] = await Promise.all([
  import("better-sqlite3"), import("../../../src/hub/member/exposures.js"), import("../../../src/hub/member/exposure-api.js"),
  import("../../../src/hub/member/sharing-journal.js"), import("../../../src/hub/member/sharing.js"), import("../../../src/hub/member/agent-catalog.js"),
  import("../../../src/hub/member/sharing-result.js"), import("../../../src/hub/audit/index.js"),
]);
const db = new Database(join(fx.dir, "sharing.sqlite")); HUB_EXPOSURE_MIGRATION.up(db); HUB_MEMBER_SHARING_MIGRATION.up(db); HUB_AUDIT_MIGRATION.up(db);
let live = true, floor = 0;
const owner = { realm: "corp", objectId: randomUUID() }, fleetId = randomUUID(), token = "c".repeat(64);
const audit = createHubAudit({ db, contentKey: randomBytes(32) });
const store = new HubExposureStore(db, { views: new Map(), floor: { read: () => floor, raise: value => { floor = value; } }, binding: () => ({ owner, fleetId }), audit }); store.initialize();
const agents = () => { const e = store.list().find(row => row.agent === "Docs")?.committed?.exposure; return [{ exposure: e ? { id: e.id, revision: e.revision, state: e.state } : null, instance: "Docs", displayName: "Documents", description: "Document questions", avatar: null, kind: "agent" as const, general: false, shareable: true as const, incarnation: token }]; };
const api = createHubMemberExposureApi({ store, agents: () => [{ name: "Docs", display: "Documents" }], afterCommit: async () => {},
  readinessCandidate: candidate => ({ ok: true, policyDigest: candidate.exposure.policyDigest, exposureRevision: candidate.exposure.revision }) });
const journal = new HubMemberSharingJournal({ db, binding: "scratch-pairing", owner, fleetId, agentToken: () => token, current: () => live, now: Date.now });
const domain = new HubMemberSharing({ journal, store, api, current: () => live, now: Date.now,
  enabled: () => fx.fm.getRawFleetConfig().hub_member?.share_from_hub !== false, agents,
  catalog: () => memberAgentCatalog(true, agents(), true), snapshot: async () => {}, notice: record => fx.fm.recordHubSharingNotice(sharingNotice(record, "Demo Hub")) });
fx.fm.hubSharingController = { view: (key: string) => { const record = journal.byNotice(key); return record ? sharingNotice(record, "Demo Hub") : null; },
  undo: async (key: string, actor: string, authorized: () => boolean) => sharingNotice(await domain.undo(key, actor, authorized), "Demo Hub") };
const results: { name: string; checks: string[] }[] = [];
const configure = () => {
  const path = join(fx.dir, "fleet.yaml"), raw = yaml.load(readFileSync(path, "utf8")) as Record<string, unknown>;
  fx.fm.webNotices = null; rmSync(join(fx.dir, "web-notices.json"), { force: true });
  raw.hub_member = { enabled: true }; writeFileSync(path, yaml.dump(raw)); fx.fm.loadConfig(path);
  if (fx.fm.hubRuntime) throw Error("smoke must not mount a live Hub runtime");
};
try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,phone-dark-zh-TW")) {
    configure();
    const checks: string[] = [], check = (ok: unknown, text: string) => { if (!ok) throw Error(text); checks.push(text); };
    const at = Date.now(), requestId = randomUUID();
    await domain.apply(requestId, { by: owner, byName: "Owner", catalogRevision: memberAgentCatalog(true, agents(), true).revision, share: ["Docs"], stop: [], createdAt: at, expiresAt: at + 600_000 });
    const { ctx, page } = await freshPage(fx, c, { account: "operator", path: "/settings/hub", beforeNavigate: async context => {
      await context.addInitScript(() => { (window as any).__csp = []; document.addEventListener("securitypolicyviolation", event => (window as any).__csp.push(event.violatedDirective)); });
    } });
    const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
    try {
      check(await mounted(page, 30_000), "real app mounted");
      const other = page.locator(".hub-connection-manual");
      if (await other.count()) await other.evaluate((element: HTMLDetailsElement) => { element.open = true; });
      await page.locator("#hubShareFromHub").waitFor(); await page.waitForFunction(() => !(document.querySelector("#hubShareFromHub") as HTMLInputElement)?.disabled);
      const toggle = page.locator("#hubShareFromHub"), label = page.locator('label:has(#hubShareFromHub)');
      await label.scrollIntoViewIfNeeded();
      check(await toggle.isChecked(), "default-on raw setting");
      check((await label.innerText()).includes(c.lang === "en" ? "Let me share agents from the Hub page" : "允許我從 Hub 頁面分享 Agent"), "approved localized label");
      const bounds = await label.boundingBox(); check(bounds && (c.device === "desk" || bounds.width >= 44 && bounds.height >= 44), "phone switch tap target");
      await page.screenshot({ path: shotPath("hub-share-undo-m3294", c, "settings-on") });
      await toggle.click(); await page.waitForFunction(() => { const box = document.querySelector("#hubShareFromHub") as HTMLInputElement; return box && !box.disabled && !box.checked; });
      check(fx.fm.getRawFleetConfig().hub_member.share_from_hub === false, "actual Settings writer persisted off");
      check(api.list()[0].state === "published", "off leaves existing shares intact");
      await page.waitForTimeout(350); // Capture the settled checkbox transition, rather than its moving thumb.
      await page.screenshot({ path: shotPath("hub-share-undo-m3294", c, "settings-off") });
      await page.goto(fx.base + "/ui/notices"); await page.waitForSelector(".p-notices .n-item");
      const notice = page.locator(".p-notices .n-item").filter({ hasText: "Documents" }).first();
      check((await notice.innerText()).includes(c.lang === "en" ? "Nobody can ask" : "沒有人可以問"), "notice explains nobody may ask yet");
      const undo = notice.getByRole("button", { name: c.lang === "en" ? "Undo" : "復原", exact: true }); await undo.waitFor();
      await page.screenshot({ path: shotPath("hub-share-undo-m3294", c, "notice-shared") });
      await undo.click(); await page.waitForFunction((word: string) => document.querySelector(".p-notices")?.textContent?.includes(word), c.lang === "zh-TW" ? "不再分享" : "no longer shared");
      check(api.list()[0].state === "withdrawn", "real admin HTTP Undo used canonical withdrawal");
      check(fx.fm.webNoticeStore().view().items.filter((value: any) => value.hubSharing?.key === journal.read(requestId)!.noticeKey).length === 1, "one durable notice id");
      await page.screenshot({ path: shotPath("hub-share-undo-m3294", c, "notice-undone") });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow");
      check(errors.length === 0 && (await page.evaluate(() => (window as any).__csp || [])).length === 0, "no page or CSP errors");
      results.push({ name: caseName(c), checks });
    } finally { await ctx.close(); }
  }
} finally {
  live = false; fx.fm.hubSharingController = null; await fx.close(); db.close();
  console.log(JSON.stringify({ cases: results, scope: "Scratch real dashboard/Settings/Notices plus real local journal/writer. No live Hub, Fleet, AD, CLI, model or desktop windows." }));
}

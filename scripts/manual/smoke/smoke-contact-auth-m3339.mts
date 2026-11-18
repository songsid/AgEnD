// M-3339 (A2): the web side of contact authorizations in the real app — a real headless Chrome on the shared smoke fixture
// (the product's own web server from an in-process FleetManager, a scratch home, loopback only — no fleet start, no network).
// The contact authorization API (A1: /ui/api/instances/:name/contact-permissions, /ui/api/contact-authorizations…) is
// answered by the page's own route handler with the wire contract's shapes (src/contact-auth-types.ts) until A1's server
// is on this branch; everything else — the agent page, Fleet, Needs you, the chat and its stream — is the real app.
// Per case (desk/phone × light/dark × en/zh-TW):
//   1-room-permissions   a ClassicBot room's Permissions: legacy with the suggestion, what would stop, the guard (restart
//                         needed), public read and an MCP tool with its owner-account warning; Switch confirms → PUT
//   2-worker-permissions a worker's Permissions: approvers (Fleet admins only, the eligible picker), allowed contacts, history
//   3-authorizations     Fleet → Authorizations: the tab, waiting requests, Approve once → POST, "also allow" fields
//   4-needs              Needs you: a request (its details from the scoped route) and the suggestion's three buttons
//   5-chat-badges        the chat: 聯絡申請 #R12a4c8e0 on a held request, 已准轉交 #R12a4c8e0 on the forwarded copy (the real
//                         stream, through the server's history record: its ids are R + a UUID, read short)
// No page error, no CSP report.
//   PW_DIR=<playwright-core dir> REPO=<checkout> OUT=<dir> [MATRIX=…] npx tsx scripts/manual/smoke/smoke-contact-auth-m3339.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-contact-auth-m3339";
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
mkdirSync(OUT, { recursive: true });
const r: Record<string, unknown> = {};
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };

const fx = await bootFixture({ port: Number(process.env.HP ?? 48339), instances: 6 });
const ROOM = fx.instances[1]!.name, WORKER = fx.instances[2]!.name;
// The server's ticket ids: R + a UUID (contact-auth-api.ts, web-chat-history.ts contactBadge); the page reads them short (R + 8 hex).
const R12 = "R12a4c8e0-5b1d-4f6a-9c3e-0d2b7f8a1c12", R11 = "R11b5d9f1-6c2e-4a7b-8d4f-1e3c8a9b2d11";
const ALEX = { platform: "discord", adapterId: "dc-main", userId: "1001", label: "Alex" };
const OWNER = { platform: "host", adapterId: "host", userId: "operator", label: "Owner" };
const KIM = { platform: "telegram", adapterId: "tg-main", userId: "7", label: "Kim" };
const roomPerm = (o: any = {}) => ({ instance: ROOM, revision: 4, classicRoom: true, mode: "legacy", approvers: [], inheritedApprovers: true, eligibleApprovers: [],
  nativeGuard: { state: "restart-required", backend: "claude-code", version: "2.1.327" },
  roomTools: { publicRead: true, allowedMcpTools: [{ name: "mcp__drive__search", kind: "mcp", usesOwnerAccount: true }], wouldDisable: ["Bash", "mcp__drive__write"] },
  canManage: false, canSetMode: true, suggestRestricted: true, grants: [],
  history: [{ id: "h0", at: "2026-11-18T07:00:00Z", actor: OWNER, action: "policy", summary: "Public read on" }], ...o });
const workerPerm = { instance: WORKER, revision: 9, classicRoom: false, mode: "legacy", approvers: [OWNER], inheritedApprovers: false, eligibleApprovers: [OWNER, KIM],
  nativeGuard: { state: "not-covered", backend: "codex" }, roomTools: { publicRead: false, allowedMcpTools: [], wouldDisable: [] }, canManage: true, canSetMode: false, suggestRestricted: false,
  grants: [{ id: "g1", person: ALEX, source: ROOM, target: WORKER, verbs: ["send_to_instance", "request_information"], expiresAt: "2026-12-01T00:00:00Z", remainingUses: 3, createdBy: OWNER, createdAt: "2026-11-18T00:00:00Z" }],
  history: [{ id: "h1", at: "2026-11-18T08:00:00Z", actor: OWNER, action: "approve", ticketId: R12, summary: `${ROOM} → ${WORKER}` },
    { id: "h2", at: "2026-11-18T08:05:00Z", actor: OWNER, action: "grant-add", summary: "Alex" }] };
const ticket = (o: any = {}) => ({ id: R12, revision: 2, scope: "peer.dispatch", state: "pending", source: ROOM, target: WORKER, sourceGeneration: "s1", targetGeneration: "t1",
  verb: "send_to_instance", origin: { kind: "human", people: [ALEX], receiptIds: ["hmsg-1"], chain: [ROOM] }, message: "Please rerun the nightly report and post the summary here.",
  requestHash: "h", correlationId: "c", resultRecipient: ROOM, createdAt: "2026-11-18T08:00:00Z", expiresAt: "2026-11-19T08:00:00Z", canDecide: true, ...o });

/** The contract's routes, answered in the page (the calls are recorded). */
async function contactApi(ctx: any, calls: Array<[string, string, unknown]>) {
  let room = roomPerm();
  let r12 = ticket();
  await ctx.route("**/ui/api/**", async (route: any) => {
    const req = route.request(), u = new URL(req.url()), m = req.method(), body = req.postData() ? JSON.parse(req.postData()) : undefined;
    calls.push([m, u.pathname + u.search, body]);
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === `/ui/api/instances/${ROOM}/contact-permissions`) { if (m === "PUT") room = roomPerm({ revision: room.revision + 1, mode: body.mode ?? room.mode, suggestRestricted: false }); return json(room); }
    if (u.pathname === `/ui/api/instances/${WORKER}/contact-permissions`) return json(workerPerm);
    if (u.pathname === "/ui/api/contact-authorizations") return json({ items: [r12, ticket({ id: R11, revision: 1, verb: "delegate_task", state: "pending", canDecide: false, origin: { kind: "mixed", people: [ALEX, KIM], receiptIds: [], chain: [ROOM] }, message: "Open a task for the release notes." })], nextCursor: null });
    if (u.pathname === `/ui/api/contact-authorizations/${R12}/decision`) { r12 = ticket({ revision: 3, state: "delivered", canDecide: false, decidedAt: "2026-11-18T08:10:00Z", decidedBy: OWNER }); return json(r12); }
    if (u.pathname === `/ui/api/contact-authorizations/${R12}`) return json(r12);
    return json({ code: "missing" }, 404);
  });
}

const CASES = matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-zh-TW,phone-dark-en");
const started = Date.now();
// The badges' messages come over the live stream once each chat is open (history is A1's to carry: the field rides
// on its message records there).
let seq = 0;
const held = () => fx.fm.emitSseEvent("message", { instance: ROOM, sender: ROOM, role: "status", text: `Held for approval: ${WORKER} (${++seq})`, ts: new Date().toISOString(), contactTicket: { id: R12, state: "pending" } });
const forwarded = () => fx.fm.emitSseEvent("message", { instance: WORKER, sender: ROOM, role: "agent", text: `Please rerun the nightly report and post the summary here. (${++seq})`, ts: new Date().toISOString(), contactTicket: { id: R12, state: "delivered" } });
try {
  for (const c of CASES) {
    const cn = caseName(c), zh = c.lang === "zh-TW";
    const { ctx, page, csp } = await fx.page(c, { path: "/ui" });
    await page.addInitScript({ content: "window.__name = (f) => f;" });
    const calls: Array<[string, string, unknown]> = [];
    await contactApi(ctx, calls);
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    page.on("dialog", (d: any) => d.dismiss());
    const body = () => page.evaluate(() => document.body.innerText) as Promise<string>;
    // 1: a ClassicBot room's Permissions.
    await page.goto(`${fx.base}/ui/fleet/agent/${encodeURIComponent(ROOM)}?cat=permissions`);
    await page.waitForSelector(".contact-perm", { timeout: 20000 }); await page.waitForTimeout(400);
    const t1 = await body();
    await page.screenshot({ path: shotPath(SMOKE, cn, "1-room-permissions"), fullPage: false });
    check(`${cn}:room`, t1.includes(zh ? "建議將這個房間切換為受限模式。" : "We suggest switching this room to restricted mode.") && t1.includes("mcp__drive__write")
      && t1.includes(zh ? "需要重新啟動" : "Restart needed") && t1.includes(zh ? "使用擁有者的帳號" : "Uses the owner's account"), t1.slice(0, 600));
    await page.locator(".contact-mode button").click(); await page.waitForTimeout(300);
    await page.screenshot({ path: shotPath(SMOKE, cn, "1b-room-confirm") });
    await page.locator("[data-confirm=yes]").click(); await page.waitForTimeout(500);
    check(`${cn}:room-switch-put`, calls.some(([m, p, b]: any) => m === "PUT" && p.endsWith(`${ROOM}/contact-permissions`) && b?.mode === "restricted" && b?.revision === 4)
      && (await page.locator(".contact-mode .contact-pill").innerText()) === (zh ? "受限模式" : "Restricted"), calls);
    // 2: a worker's Permissions.
    await page.goto(`${fx.base}/ui/fleet/agent/${encodeURIComponent(WORKER)}?cat=permissions`);
    await page.waitForSelector(".contact-approvers", { timeout: 20000 }); await page.waitForTimeout(400);
    const t2 = await body();
    await page.screenshot({ path: shotPath(SMOKE, cn, "2-worker-permissions") });
    check(`${cn}:worker`, t2.includes(zh ? "目前核准人必須是 Fleet 管理員。" : "Approver must be a Fleet admin for now.") && t2.includes(zh ? "剩下 3 次" : "3 uses left")
      && (await page.locator(".contact-approver-add option").allInnerTexts()).some((x: string) => x.startsWith("Kim")), t2.slice(0, 600));
    // 3: Fleet → Authorizations.
    await page.goto(`${fx.base}/ui/fleet/authorizations`);
    await page.waitForSelector(".contact-ticket", { timeout: 20000 }); await page.waitForTimeout(400);
    const tabs = await page.locator('a[href="/ui/fleet/authorizations"]').count();
    await page.locator(`.contact-ticket[data-ticket="${R12}"] input[type=checkbox]`).check(); await page.waitForTimeout(200);
    await page.screenshot({ path: shotPath(SMOKE, cn, "3-authorizations") });
    await page.locator(`.contact-ticket[data-ticket="${R12}"] input[type=checkbox]`).uncheck();
    await page.locator(`.contact-ticket[data-ticket="${R12}"] .btn-primary`).click(); await page.waitForTimeout(500);
    check(`${cn}:authorizations`, tabs >= 1 && calls.some(([m, p, b]: any) => m === "POST" && p === `/ui/api/contact-authorizations/${R12}/decision` && b?.decision === "approve-once" && b?.revision === 2 && !b?.grant)
      && (await page.locator(`.contact-ticket[data-ticket="${R12}"]`).getAttribute("data-state")) === "delivered"
      && (await page.locator(`.contact-ticket[data-ticket="${R11}"] .btn-primary`).count()) === 0, calls);
    await page.screenshot({ path: shotPath(SMOKE, cn, "3b-authorizations-decided") });
    // 4: Needs you (the server's needs list, as the stream would deliver it).
    await page.goto(`${fx.base}/ui/needs`); await page.waitForTimeout(800);
    await page.evaluate(async ([room, worker, r12]: [string, string, string]) => {
      const m: any = await import("/assets/app-store.js");
      m.appStore.set({ needs: [
        { id: `contact:${r12}`, type: "contact", reason: "contact_request", instance: worker, since: Date.now() - 120000, contactTicket: { id: r12, source: room, target: worker } },
        { id: `contact-suggest:${room}`, type: "contact", reason: "contact_restricted_suggestion", instance: room, since: Date.now() - 60000, contactSuggestion: { instance: room } }] });
    }, [ROOM, WORKER, R12]);
    await page.waitForSelector(".contact-need", { timeout: 10000 }); await page.waitForTimeout(500);
    const t4 = await body();
    await page.screenshot({ path: shotPath(SMOKE, cn, "4-needs"), fullPage: c.device === "desk" });
    check(`${cn}:needs`, t4.includes(zh ? `${ROOM} 想聯絡 ${WORKER}` : `${ROOM} wants to contact ${WORKER}`) && t4.includes(zh ? "查看影響與常用轉交" : "See the impact and allowed contacts")
      && t4.includes(zh ? "稍後" : "Later"), t4.slice(0, 600));
    // 5: the chat's badges (the real stream's messages).
    await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(ROOM)}`); await page.waitForTimeout(1500); held();
    await page.waitForSelector(".msg .contact-badge", { timeout: 15000 }).catch(() => {});
    const b1 = await page.locator(".msg .contact-badge").allInnerTexts();
    await page.screenshot({ path: shotPath(SMOKE, cn, "5-chat-badge-room") });
    await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(WORKER)}`); await page.waitForTimeout(1500); forwarded();
    await page.waitForSelector(".msg .contact-badge", { timeout: 15000 }).catch(() => {});
    const b2 = await page.locator(".msg .contact-badge").allInnerTexts();
    await page.screenshot({ path: shotPath(SMOKE, cn, "5-chat-badge-worker") });
    check(`${cn}:badges`, b1.includes(zh ? "聯絡申請 #R12a4c8e0" : "Contact request #R12a4c8e0") && b2.includes(zh ? "已准轉交 #R12a4c8e0" : "Forwarded (approved) #R12a4c8e0"), { b1, b2 });
    check(`${cn}:no-errors`, errs.length === 0 && (await csp()).length === 0, { errs, csp: await csp() });
    await ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  r.seconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(join(OUT, "result.json"), JSON.stringify(r, null, 1));
  for (const f of fail.slice(0, 30)) console.log(`FAIL ${f}: ${JSON.stringify((r[f] as any)?.FAIL ?? r.error ?? "").slice(0, 700)}`);
  console.log(fail.length ? `M-3339 A2 smoke FAILED (${fail.length}) in ${r.seconds}s — ${OUT}` : `M-3339 A2 smoke passed in ${r.seconds}s (${Object.keys(r).length - 1} checks)`);
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}

/**
 * M-3736 J (S-228) real-app captures (owned web fixture; no Fleet/CLI starts, accounts, vendors or external services): the
 * one contact card on the web, driven through the REAL same-card server objects merged with #4492 (slice I) — a
 * DeliveryOutbox with the request-context barrier, its RequestContactGate holding scoped requests, the card service
 * (read / list / decide with the full snapshot CAS, Needs you's scoped items) and the HTTP routes, installed into the
 * fixture's FleetManager the way slice L will (`requestContactApi`). Nothing is delivered anywhere: the outbox is the
 * capture's own scratch database.
 * Two seams are stubbed, both disclosed in README.md: the principal (one recognized managing admin, verified or not per
 * frame — the fixture signs in with a host code, which has no chat identity), and GET/POST /ui/authorization in the
 * browser (so "Authorize this browser" can go not verified → waiting → verified without a Discord DM).
 *   1 Needs you, not verified: the same card, its buttons off, one line and Authorize this browser · 2 verified: the
 *   card read again, its buttons on, nothing decided · 3 one click: Continued · 4 Fleet → Authorizations (a guest's
 *   request and a legacy one, each detail line saying its scope), 4b a legacy request's details folded out ·
 *   5 Always allow… on the legacy request (its people from the card's grant candidates).
 * Desk light en, desk dark zh-TW, phone light en, phone dark zh-TW.
 *   CHROME=<chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/request-contact-card-s228/capture.mts
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, mounted } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail).slice(0, 400)}`}`); };
const shot = async (page: any, name: string) => {
  await page.waitForTimeout(400);
  const path = `s228-${name}.png`;
  await page.screenshot({ path: join(OUT, path) });
  receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
};

const fx = await bootFixture({ port: 0, classic: false, host: true, roster: [
  { name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" },
  { name: "front-desk", backend: "claude-code", displayName: "Front desk", status: "running" },
  { name: "billing", backend: "codex", displayName: "Billing", status: "running" },
  { name: "research", backend: "claude-code", displayName: "Research", status: "running" },
] });
const fm = fx.fm;

// ── The real same-card objects (slice I), on the capture's own outbox ──
const { DeliveryOutbox } = await import(REPO + "/src/delivery-outbox.ts");
const { ContactHeldError } = await import(REPO + "/src/contact-auth-service.ts");
const { requestContextDigest } = await import(REPO + "/src/request-context-store.ts");
const { permitWebContinuation } = await import(REPO + "/src/web-continuation.ts");
const box = new DeliveryOutbox(join(fx.dir, "capture-outbox.db"), "capture", { requestContextDispatchVersion: 1 });
box.activateRequestContextBarrier();
const NAMES = ["front-desk", "billing", "research"], LABEL: Record<string, string> = { "front-desk": "Front desk", billing: "Billing", research: "Research" };
const gens = new Map(NAMES.map((n) => [n, `${n}-v1`]));
const manager = { platform: "discord" as const, adapterId: "capture", userId: "demo-admin", label: "Demo admin" };
const host: any = {
  current: () => true, canManage: (_t: string, p: any) => p.userId === manager.userId, canDecide: (_t: string, p: any) => p.userId === manager.userId, adminOf: () => false,
  person: (a: any) => (a.kind === "person" && a.platform !== "hub" ? { platform: a.platform, userId: a.userId, adapterId: "capture", label: a.displayName ?? a.userId } : null),
  generation: (n: string) => gens.get(n) ?? null, roleRevision: () => "capture-roles-1", managedTargets: () => NAMES, label: (n: string) => LABEL[n] ?? n,
  deliveryState: (t: any) => (t.deliveryId ? box.get(t.deliveryId)?.state : undefined), legacyCurrent: () => true,
  admitLegacy: (r: any, id: string) => box.admit({ operationId: r.operationId, sourceKey: `contact:${id}`, sourceInstance: r.source, sourceDaemonBootId: "capture", targetInstance: r.target, kind: "fleet_inbound", payload: r.payload }).delivery.deliveryId,
  changed: (t: any) => { try { fm.emitSseEvent("contact-auth", { instance: t.target, ticketId: t.id, revision: t.revision }); fm.needsYou?.poke(); } catch { /* the page reads again on its own */ } },
};
const cards = box.requestContactCards(host), gate = box.requestContactGate(host);
let verified = false;
const principal = () => ({ person: manager, binding: "capture-session", verified, current: () => true });
fm.requestContactApi = {
  principal: () => principal(), needs: (a: any) => cards.needs(a),
  permitContinuation: (req: any, res: any) => permitWebContinuation(req, res, { webToken: fm.webToken, webSessions: fm.webSessions }),
  canRead: (c: any, a: any) => cards.canRead(c, a), read: (id: string, a: any) => cards.read(id, a), list: (f: any, a: any) => cards.list(f, a), decide: (id: string, i: any, a: any) => cards.decide(id, i, a),
};

/** A scoped request held by the real gate: `ingress`, who started it, from `source` to `target`. */
function holdScoped(ingress: string, actor: any, source: string, target: string, message: string) {
  const id = randomUUID();
  const ctx = { ref: { version: 1, contextId: id, rootContextId: id }, rootEvidenceRef: "capture", ingress, initiatingActor: actor,
    source: { instance: source, incarnation: gens.get(source)! }, sourceAudience: { kind: "room", ref: randomUUID() }, returnAudience: { kind: ingress === "guest" ? "web" : "room", ref: randomUUID() } };
  const operationId = randomUUID();
  const delivery = { operationId, sourceKey: operationId, sourceInstance: source, sourceDaemonBootId: "capture", targetInstance: target, kind: "fleet_inbound", payload: { content: message }, forwards: [] };
  const binding = { version: 1, operationId, contextId: id, rootContextId: id, source: ctx.source, target: { instance: target, incarnation: gens.get(target)! }, verb: "send_to_instance", payloadSha256: requestContextDigest(delivery.payload) };
  try { gate.admit(delivery as any, ctx as any, binding as any); throw new Error("expected a hold"); }
  catch (e) { if (!(e instanceof ContactHeldError)) throw e; return box.contactAuthorizations.get((e as any).result.authorization_id)!; }
}
/** A legacy request (today's engine) with two people in its history: Always allow lists both. */
function holdLegacy(source: string, target: string, message: string) {
  return box.contactAuthorizations.hold({ operationId: randomUUID(), source, target, sourceGeneration: gens.get(source)!, targetGeneration: gens.get(target)!, verb: "send_to_instance",
    origin: { kind: "mixed", people: [{ platform: "discord", adapterId: "capture", userId: "1001", label: "Alex" }, { platform: "telegram", adapterId: "capture", userId: "2002", label: "Robin" }], receiptIds: [], chain: [] },
    message, correlationId: randomUUID(), resultRecipient: source, payload: { content: message }, forwards: [] });
}
const state = (id: string) => box.contactAuthorizations.get(id)?.state;

const W = (zh: boolean, en: string, zhText: string) => (zh ? zhText : en);
const scroll = async (page: any) => page.evaluate(`({ w: innerWidth, s: document.documentElement.scrollWidth })`);
const cardText = async (page: any, id: string) => page.evaluate(`(document.querySelector('.rc-card[data-ticket="${id}"]') || {}).innerText || ""`) as Promise<string>;
const taps = async (page: any) => page.evaluate(`[...document.querySelectorAll(".rc-card .btn")].filter((e) => e.getBoundingClientRect().width).map((e) => Math.round(e.getBoundingClientRect().height))`) as Promise<number[]>;
const waitFor = async (page: any, expr: string, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await page.evaluate(expr)) return true; await page.waitForTimeout(150); } return false; };
const offOn = async (page: any, id: string) => page.evaluate(`[...document.querySelectorAll('.rc-card[data-ticket="${id}"] button[data-choice]')].map((b) => b.disabled)`) as Promise<boolean[]>;

async function walk(c: any) {
  const tag = caseName(c), zh = c.lang === "zh-TW", phone = c.device === "phone";
  verified = false;
  const A = holdScoped("restricted-room", { kind: "person", platform: "discord", userId: "1001", displayName: "Alex" }, "front-desk", "billing", W(zh, "Please refund order 1042 and tell the customer it's done.", "請退款訂單 1042，並告知客戶已完成。"));
  const B = holdScoped("guest", { kind: "person", platform: "telegram", userId: "3003", displayName: "Sam" }, "research", "billing", W(zh, "Can you share the March invoice total?", "可以提供三月的發票總額嗎？"));
  const C = holdLegacy("front-desk", "research", W(zh, "Summarize yesterday's support tickets.", "整理昨天的客服單。"));
  const base = box.listPending().length;                       // what earlier cases admitted: this case counts from here
  const { page, ctx } = await fx.page(c, { path: "/ui/needs" });
  // The browser's authorization (the one stub on the page side): not verified → waiting → verified.
  let auth: any = { state: "none", reason: "not_authorized" };
  await page.route("**/ui/authorization", (route: any) => route.request().method() === "POST"
    ? (auth = { state: "pending", expiresInMs: 300_000 }, route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, expiresInMs: 300_000 }) }))
    : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(auth) }));
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  try {
    // 1 Needs you, not verified
    await page.goto(fx.base + "/ui/needs"); check(`${tag}: mounted`, await mounted(page, 30000));
    check(`${tag} 1: the scoped card in Needs you`, await waitFor(page, `!!document.querySelector('.rc-card[data-ticket="${A.id}"]')`), null);
    await page.waitForTimeout(600);
    let t = await cardText(page, A.id);
    check(`${tag} 1: the standard item: the title names both Agents`, t.includes(W(zh, "Front desk wants to contact Billing", "Front desk 想聯絡 Billing")), t);
    check(`${tag} 1: one detail line: the reason, then this card's scope in a few words`, t.includes(W(zh, "This was sent while Front desk was working on Alex's request from a restricted room. Continue = this request and its follow-up contacts only.", "這是 Front desk 處理 Alex 在受限模式房間提出的請求時送出的。 繼續＝只放行這筆請求和它後續的聯絡。")), t);
    check(`${tag} 1: no raised card (an .n-item, not .card)`, await page.evaluate(`(() => { const e = document.querySelector('.rc-card[data-ticket="${A.id}"]'); return e.classList.contains("n-item") && !e.classList.contains("card") && getComputedStyle(e).boxShadow === "none"; })()`), null);
    check(`${tag} 1: Authorize this browser, inline, in one line`, t.includes(W(zh, "Authorize this browser to decide.", "授權這個瀏覽器後才能決定。")) && (await page.locator(`.rc-card[data-ticket="${A.id}"] .rc-auth-ask`).count()) === 1, t);
    check(`${tag} 1: the buttons are off until verified`, (await offOn(page, A.id)).length === 3 && (await offOn(page, A.id)).every(Boolean), await offOn(page, A.id));
    check(`${tag} 1: the long scope only in the details`, !t.includes(W(zh, "This does not approve what Agents do", "這不代表核准 Agent 的操作")), t);
    check(`${tag} 1: the guest's request too, worded as one`, (await cardText(page, B.id)).includes(W(zh, "This was sent while Research was working on a request from Sam, a guest.", "這是 Research 處理訪客 Sam 的請求時送出的。")), await cardText(page, B.id));
    check(`${tag} 1: no count-only verify line under the host`, (await page.locator(".contact-verify-need").count()) === 0, null);
    if (phone) check(`${tag} 1: 44 px buttons`, (await taps(page)).every((h) => h >= 44), await taps(page));
    const sc = await scroll(page); check(`${tag} 1: no sideways scroll`, sc.s <= sc.w, sc);
    await page.evaluate(`document.querySelector('.rc-card[data-ticket="${A.id}"]').scrollIntoView({ block: "start" })`);
    await shot(page, `${tag}-1-needs-unverified`);
    // 2 Authorize this browser → (the account confirms) → verified: the card is read again, its buttons on; nothing decided
    await page.locator(`.rc-card[data-ticket="${A.id}"] .rc-auth-ask`).click(); await page.waitForTimeout(300);
    verified = true; auth = { state: "verified", until: Date.now() + 3_600_000 };
    check(`${tag} 2: read again once verified: the buttons on`, await waitFor(page, `[...document.querySelectorAll('.rc-card[data-ticket="${A.id}"] button[data-choice]')].some((b) => !b.disabled)`), await offOn(page, A.id));
    t = await cardText(page, A.id);
    check(`${tag} 2: no verify line, no marked choice`, !t.includes(W(zh, "Authorize this browser to decide.", "授權這個瀏覽器後才能決定。")) && !/Your choice|你的選擇|✓/.test(t), t);
    check(`${tag} 2: every card on the page read again (one Authorize serves them all)`, await waitFor(page, `document.querySelectorAll(".rc-card .rc-verify").length === 0 && [...document.querySelectorAll('.rc-card[data-ticket="${B.id}"] button[data-choice="continue"]')].every((b) => !b.disabled)`), await page.evaluate(`document.querySelectorAll(".rc-card .rc-verify").length`));
    // The verb, the "=" and what follows it stay on one line (zh broke as 「繼續＝ / 只放行…」); a long English one may wrap later.
    check(`${tag} 2: the scope never breaks at its 「＝」/"="`, await page.evaluate(`[...document.querySelectorAll(".rc-card .rc-scope")].every((e) => { const n = e.firstChild, i = Math.max(n.data.indexOf("＝"), n.data.indexOf("=")); if (i < 0) return false;
      const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, Math.min(n.data.length, i + 4)); return new Set([...r.getClientRects()].filter((b) => b.width).map((b) => Math.round(b.top))).size === 1; })`), null);
    await page.keyboard.press("Enter"); await page.waitForTimeout(300);
    check(`${tag} 2: verifying (and Enter) decided nothing`, state(A.id) === "pending" && box.listPending().length === base, state(A.id));
    await shot(page, `${tag}-2-verified`);
    // 3 one click: Continued
    await page.locator(`.rc-card[data-ticket="${A.id}"] button[data-choice="continue"]`).click();
    check(`${tag} 3: one click continues it`, await waitFor(page, `((document.querySelector('.rc-card[data-ticket="${A.id}"]') || {}).innerText || "").includes(${JSON.stringify(W(zh, "Continued", "已繼續"))})`), await cardText(page, A.id));
    check(`${tag} 3: admitted once`, state(A.id) === "approved" && box.listPending().length === base + 1, { state: state(A.id), pending: box.listPending().length });
    check(`${tag} 3: no buttons after`, (await page.locator(`.rc-card[data-ticket="${A.id}"] button[data-choice]`).count()) === 0, null);
    await shot(page, `${tag}-3-continued`);
    // 4 Fleet → Authorizations: the guest's scoped request and a legacy one
    await page.goto(fx.base + "/ui/fleet/authorizations"); await mounted(page, 30000);
    check(`${tag} 4: the page lists the waiting ones (not the continued one)`, await waitFor(page, `document.querySelectorAll(".rc-page .rc-card").length === 2 && !!document.querySelector('.rc-card[data-ticket="${B.id}"]') && !!document.querySelector('.rc-card[data-ticket="${C.id}"]')`), await page.evaluate(`document.querySelectorAll(".rc-card").length`));
    const tc = await cardText(page, C.id);
    check(`${tag} 4: a legacy request's detail line says its own scope; its verb is Approve once`, tc.includes(W(zh, "Front desk's retained history includes non-admin input, so this contact needs approval. Approve once = this one request only.", "Front desk 保留的歷史含有非管理員輸入，因此這次聯絡需要核准。 核准這一次＝只轉交這一筆請求。")) && tc.includes(W(zh, "Approve once", "核准這一次")), tc);
    check(`${tag} 4: the guest's (new-model) request says Continue's scope`, (await cardText(page, B.id)).includes(W(zh, "Continue = this request and its follow-up contacts only.", "繼續＝只放行這筆請求和它後續的聯絡。")), await cardText(page, B.id));
    check(`${tag} 4: no Clear retained origin anywhere`, !(await page.evaluate(`document.body.innerText`) as string).includes(W(zh, "Clear retained origin", "清除保留的來源")), null);
    if (phone) check(`${tag} 4: 44 px buttons`, (await taps(page)).every((h) => h >= 44), await taps(page));
    const sc5 = await scroll(page); check(`${tag} 4: no sideways scroll`, sc5.s <= sc5.w, sc5);
    await shot(page, `${tag}-4-authorizations`);
    await page.locator(`.rc-card[data-ticket="${C.id}"] details.rc-more summary`).click(); await page.waitForTimeout(300);
    const folded = await cardText(page, C.id);
    check(`${tag} 4b: the details: the message, who asked, the times`, folded.includes(W(zh, "Summarize yesterday's support tickets.", "整理昨天的客服單。")) && folded.includes(W(zh, "No single known person asked", "不是單一已知的人提出的")) && folded.includes(W(zh, "Approve = forward this request once.", "核准＝只轉交這一次。")), folded);
    await page.evaluate(`document.querySelector('.rc-card[data-ticket="${C.id}"]').scrollIntoView({ block: "start" })`);
    await shot(page, `${tag}-4b-details`);
    // 5 Always allow… on the legacy request (the grant editor predates J; the leader cards its layout separately): its people, from the card's grant candidates
    await page.locator(`.rc-card[data-ticket="${C.id}"] button[data-choice="always"]`).click(); await page.waitForTimeout(500);
    const dlg = await page.evaluate(`(document.querySelector("dialog.contact-grant-dialog") || {}).innerText || ""`) as string;
    check(`${tag} 5: the rule lists the request's people`, dlg.includes("Alex") && dlg.includes("Robin"), dlg.slice(0, 300));
    check(`${tag} 5: nothing decided by opening it`, state(C.id) === "pending", state(C.id));
    await shot(page, `${tag}-5-always-allow`);
    check(`${tag}: no page errors`, errors.length === 0, errors);
  } finally {
    await ctx.close();
    // This case's requests are declined, so the next case's page shows only its own (through the same writer).
    verified = true;
    for (const tk of [B, C]) if (state(tk.id) === "pending") cards.decide(tk.id, { snapshot: cards.read(tk.id, principal()).snapshot, decision: "decline" }, principal());
  }
}

try {
  for (const c of matrix("desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW")) await walk(c);
} finally {
  await fx.close(); box.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}

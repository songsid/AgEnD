// Real Hub HTTPS + browser; fake directory/member/content storage, no fleet or model/account calls.
// REPO=<checkout> OUT=<evidence> PW_DIR=<playwright dir> CHROME=<binary> MODE=before|after npx tsx <this file>
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const { REPO, OUT, PW_DIR, CHROME, MODE = "after" } = process.env;
if (!REPO || !OUT || !PW_DIR || !CHROME) throw new Error("Set REPO, OUT, PW_DIR, CHROME");
const { s3bRig } = await import(REPO + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(REPO + "/src/hub/tls.ts");
const { buttonsDigest } = await import(REPO + "/src/hub/buttons-model.ts");
const { messageContentDigest } = await import(REPO + "/src/hub/identity.ts");
const pw = createRequire(PW_DIR + "/")("playwright-core");
mkdirSync(OUT, { recursive: true });
const keys = mkdtempSync(join(OUT, "private-keys-"));
const port = 49000 + Math.floor(Math.random() * 500), origin = `https://127.0.0.1:${port}`;
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const rig = await s3bRig({ webOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) }, (q, s) => {
  if (!rig.http.handle(q, s)) { s.writeHead(404); s.end(); }
});
await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
const browser = await pw.chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
const evidence: any[] = [];
const owner = rig.addPerson("owner", "Agent owner"); rig.addPerson("asker", "Alex");
const fleetId = randomUUID(), link = rig.link(fleetId, owner, 1, ["buttons-v1"]);
const exposures: any[] = [];
const o = await rig.signIn("owner"), a = await rig.signIn("asker");
async function answer(messageId: string, text: string, buttons?: any) {
  const answerId = randomUUID(), contentDigest = messageContentDigest("answer", text, { buttonsDigest: buttonsDigest(buttons) });
  const auth = await rig.http.receive(rig.frame("authorize.request", { messageId, operationId: randomUUID(), exposureRevision: 1, phase: "release-answer", answer: { answerId, contentDigest } }, link) as never, link) as any;
  if (!auth.payload.ok) throw new Error("Release refused");
  await rig.http.receive(rig.frame("answer", { messageId, answerId, text, contentDigest, ...(buttons ? { buttons } : {}), releaseLease: auth.payload.lease }, link) as never, link);
}
try {
  for (const device of ["desktop", "phone"]) for (const lang of ["en", "zh-TW"]) for (const theme of ["light", "dark"]) {
    const tag = `${MODE}${process.env.OLD_STORE ? "-skew" : ""}-${device}-${lang}-${theme}`, zh = lang === "zh-TW";
    if (process.env.ONLY && process.env.ONLY !== `${device}-${lang}-${theme}`) continue;
    const exposureId = randomUUID();
    exposures.push({ id: exposureId, fleetId, owner, displayName: "Planning assistant", revision: 1,
      state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
    await rig.http.receive(rig.frame("exposure.snapshot", { revision: exposures.length, exposures }, link) as never, link);
    const grant = (await rig.call(o, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "asker", days: 7 })).json.grant;
    const roomId = (await rig.call(a, "POST", "/hub/v1/rooms", { exposureId, grantId: grant.id })).json.room.id;
    const text = zh ? "請協助選擇活動日期。" : "Help us choose a date for the event.";
    const messageId = (await rig.call(a, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: randomUUID(), text })).json.receipt.messageId;
    const b = { id: randomUUID().replaceAll("-", ""), labels: zh ? ["星期六", "星期日"] : ["Saturday", "Sunday"], values: ["sat", "sun"],
      poll: { seconds: 300, multi: false, reveal: "close", showVoters: true, question: zh ? "哪一天比較方便？" : "Which day works best?" } };
    await answer(messageId, b.poll.question, b);
    const ctx = await browser.newContext({ viewport: device === "desktop" ? { width: 1366, height: 900 } : { width: 390, height: 844 },
      isMobile: device === "phone", hasTouch: device === "phone", locale: zh ? "zh-TW" : "en-US", colorScheme: theme, ignoreHTTPSErrors: true });
    const session = await rig.signIn("asker"), [name, value] = session.cookie.split("=");
    await ctx.addCookies([{ name, value, url: origin, httpOnly: true, secure: true }]);
    await ctx.addInitScript((c: any) => { localStorage.setItem("agend_lang", c.lang); localStorage.setItem("agend_theme", c.theme); localStorage.setItem("agend_tour_done", "1"); }, { lang, theme });
    const page = await ctx.newPage(), errors: string[] = [];
    if (process.env.OLD_STORE) await page.route("**/ui/js/hub-chat-store.js", (route: any) => route.fulfill({ contentType: "application/javascript", body: readFileSync(process.env.OLD_STORE!, "utf8") }));
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await page.goto(`${origin}/ui/hub?room=${roomId}`);
    await page.locator(".rb-row.poll .rb-btn").first().click({ timeout: 15000 });
    await page.waitForFunction(() => !!document.querySelector(".rb-row.poll button:disabled"), undefined, { timeout: 30000 });
    const generated = rig.db.prepare("SELECT result_message_id FROM hub_answer_buttons WHERE id=?").get(b.id) as any;
    const delivered = rig.sent.find((s: any) => s.frame.type === "question" && s.frame.payload.identity.messageId === generated.result_message_id) as any;
    if (!delivered?.frame.payload.text.startsWith("[poll results]")) throw new Error("No unchanged agent result delivery");
    // Wait for the ordinary paced read to see the result entry, not just the local click state.
    await page.waitForFunction(async () => {
      const m = await import("/ui/js/panel-hub.js"); await m.refreshRooms(); return true;
    });
    await page.waitForTimeout(11000);
    const body = await page.locator(".hub-thread").count() ? await page.locator(".hub-thread").innerText() : await page.locator(".hub-chat-main").innerText();
    const leaked = body.includes("[poll results]");
    if (leaked !== (MODE === "before")) throw new Error(`${tag}: unexpected prompt visibility`);
    if (MODE !== "before" && /corp\/|AgEnD only counts votes|\d+ ms/.test(body)) throw new Error(`${tag}: internal details visible`);
    await page.locator(".rb-row.poll").scrollIntoViewIfNeeded();
    const geometry = await page.evaluate(() => Object.fromEntries(["#msgIn", ".hub-dock", ".hub-scroller", ".rb-row.poll", ".hub-chat-main"].map(s => {
      const e = document.querySelector(s), r = e?.getBoundingClientRect();
      return [s, r ? { top: r.top, bottom: r.bottom, height: r.height, display: getComputedStyle(e!).display } : null];
    })));
    await page.screenshot({ path: join(OUT, `${tag}.png`), fullPage: true });
    await answer(generated.result_message_id, zh ? "已收到結果，活動將安排在星期六。" : "Thanks for voting. We will schedule the event for Saturday.");
    await page.waitForFunction((t: string) => document.body.textContent!.includes(t), zh ? "已收到結果" : "Thanks for voting", { timeout: 30000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (errors.length || overflow) throw new Error(JSON.stringify({ tag, errors, overflow }));
    evidence.push({ tag, leaked, agentResultDelivered: true, replyVisible: true, overflow, errors, geometry });
    await ctx.close();
  }
} finally {
  await browser.close(); await new Promise<void>(r => server.close(() => r())); await rig.close(); rmSync(keys, { recursive: true });
  writeFileSync(join(OUT, `${MODE}${process.env.OLD_STORE ? "-skew" : ""}.json`), JSON.stringify(evidence, null, 2));
}

/**
 * M-3117: the same conversation in AgEnD's Fleet chat and in a Hub room, side by side (the user's rule, decision 38e2ea2d:
 * the Hub's conversation window is the Fleet chat, copied in every detail). One transcript — my question to an agent, its
 * answer (a reply to it: Markdown, a table, code), a second question and answer, and (Hub only) a colleague's line — drawn
 * by each product on its own fixture:
 *   fleet.<case>.png   — the Fleet chat (scripts/manual/smoke-fixture: a scratch FleetManager, the real dashboard), its
 *                        chat panel on a desk (the sidebar is the fixture's, not the conversation);
 *   room.<case>.png    — a Hub room (the real Hub listener, tests/support/hub-rooms-fixture.ts with this transcript), its
 *                        conversation column on a desk;
 *   parity.<case>.png  — the two next to each other, Fleet on the left;
 *   menu.<case>.png    — S-152: the room's message menu (a desk's right-click, a phone's long press).
 * Cases: the smoke fixture's matrix (MATRIX=quick: desk-light-en + phone-dark-zh-TW). No account, no network, no fleet.
 *   PW_DIR=<dir whose node_modules has playwright-core> REPO=$PWD OUT=<dir> [MATRIX=quick] npx tsx scripts/manual/hub-rooms/parity.mts
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { bootFixture, caseName, matrix, VIEWPORTS, type MatrixCase } from "../smoke-fixture/index.mts";

const repo = resolve(process.env.REPO ?? "."), out = resolve(process.env.OUT ?? join(repo, ".artifacts/hub-rooms-parity"));
mkdirSync(out, { recursive: true });
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();

// ── One transcript ────────────────────────────────────────────────────────────────────────────────────────────────────
const AGENT = "project-helper", OWNER = "林小華", ME = "王經理";
const T = Date.parse("2026-11-13T02:00:00Z");
type Line = { who: "me" | "agent" | "other"; text: string; at: number; replyTo?: number };
const LINES: Line[] = [
  { who: "me", at: 0, text: `@${AGENT} 幫我整理這週部署檢查的重點` },
  { who: "agent", at: 1, replyTo: 0, text: "這週部署檢查的重點：\n\n1. **自動測試**全部通過\n2. 文件還有兩份待確認\n3. 下週二前完成正式環境切換\n\n| 項目 | 狀態 | 負責 |\n|---|---|---|\n| 自動測試 | ✅ 通過 | 林小華 |\n| 文件確認 | ⏳ 待確認 | 陳主任 |\n| 正式環境 | 🗓 下週二 | 吳小安 |" },
  { who: "other", at: 3, text: "文件那兩份我今天下午看完" },
  { who: "me", at: 4, text: `@${AGENT} 再給我切換時要跑的指令` },
  { who: "agent", at: 5, replyTo: 3, text: "切換前先確認版本，再重新啟動：\n\n```sh\nagend --version\nagend fleet restart\n```\n\n完成後在 Fleet 頁面確認每個 Agent 都是「執行中」。" },
];

// ── The Fleet chat ────────────────────────────────────────────────────────────────────────────────────────────────────
const fx = await bootFixture({ port: Number(process.env.PORT || 49812), instances: 3, classic: false });
// The agent of the transcript, by the same name in both (a fixture instance's own name stays out of the pictures).
const fleetName = AGENT, config = structuredClone(fx.fm.fleetConfig);
config.instances[fleetName] = { ...structuredClone(config.instances[fx.instances[1]!.name]), backend: "claude-code", model: "sonnet" };
delete config.instances[fleetName].display_name;
writeFileSync(join(fx.dir, "fleet.yaml"), JSON.stringify(config));
fx.fm.loadConfig(join(fx.dir, "fleet.yaml"), { remember: false });
const recorded: Array<{ boot: string; id: number; sender: string; text: string } | null> = [];
for (const l of LINES) {
  if (l.who === "other") { recorded.push(null); continue; }   // a Fleet chat is one person's: no colleague's line
  const quote = l.replyTo !== undefined ? recorded[l.replyTo] : null;
  const m = fx.fm.webChatHistory.record({ instance: fleetName, sender: l.who === "me" ? ME : fleetName, role: l.who === "me" ? "user" : "agent", text: l.text,
    ts: new Date(T + l.at * 60_000).toISOString(), ...(quote ? { replyTo: { boot: quote.boot, id: quote.id, sender: quote.sender, text: quote.text.slice(0, 160) } } : {}) });
  recorded.push({ boot: m.boot, id: m.id, sender: m.sender, text: m.text });
}

// ── The Hub room ──────────────────────────────────────────────────────────────────────────────────────────────────────
const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
const { createHubRoomsFixture, FIXTURE_ME } = await import(repo + "/tests/support/hub-rooms-fixture.ts");
const keys = mkdtempSync(join(out, ".keys-")), hport = 49600 + Math.floor(Math.random() * 200), horigin = `https://127.0.0.1:${hport}`;
const rig = await s3bRig({ webOrigin: horigin });
await provisionHubIdentity({ home: keys, memberOrigin: horigin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>(done => server.listen(hport, "127.0.0.1", done));
const ROOM = "room-weekly";
const roomMessages = () => {
  const out: any[] = [], ids = LINES.map((_, i) => `msg-p${i + 1}`);
  LINES.forEach((l, i) => {
    const author = l.who === "me" ? { kind: "person", id: FIXTURE_ME.id, name: FIXTURE_ME.name } : l.who === "other" ? { kind: "person", id: "person-chen", name: "陳主任" }
      : { kind: "agent", id: "exp-01", name: AGENT, owner: { name: OWNER } };
    const asks = l.who === "me" && LINES[i + 1]?.who === "agent";
    out.push({ id: ids[i], roomId: ROOM, at: T + l.at * 60_000, sequence: i + 1, author, text: l.text, mentions: l.who === "me" ? ["exp-01"] : [],
      ...(asks ? { ask: { total: 1, answered: 1, working: 0, later: 0 } } : {}),
      ...(l.who === "agent" && l.replyTo !== undefined ? { answerTo: ids[l.replyTo], stage: "answered" } : {}) });
  });
  return out;
};

// tsx names its functions through a `__name` helper the page lacks: one devtools evaluate defines it (a single call, not a
// polled string, so the CSP has nothing to refuse).
const SHIM = "globalThis.__name = globalThis.__name || ((f) => f)";
// ── What each draws, measured (computed styles of the same parts) ──────────────────────────────────────────────────────
const MEASURE = (root: string) => {
  const q = (s: string) => document.querySelector(`${root} ${s}`) as HTMLElement | null;
  const st = (el: HTMLElement | null, keys: string[]) => { if (!el) return null; const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return Object.fromEntries([...keys.map((k) => [k, cs.getPropertyValue(k)]), ["width", Math.round(r.width)], ["height", Math.round(r.height)]]); };
  const msgs = [...document.querySelectorAll(`${root} .thread .msg:not(.status-line)`)] as HTMLElement[];
  const gaps = msgs.slice(1).map((m, i) => Math.round(m.getBoundingClientRect().top - msgs[i]!.getBoundingClientRect().bottom));
  return {
    composerBox: st(q(".composer-box"), ["background-color", "border-top-width", "border-top-color", "border-radius", "box-shadow"]),
    textarea: st(q(".composer textarea"), ["font-size", "line-height", "padding-top"]),
    dock: st(q(".dock"), ["padding-left", "padding-bottom"]), dockCol: st(q(".dock-col"), ["max-width"]),
    composerRow: st(q(".composer-row"), ["font-size", "color", "display"]),
    thread: st(q(".thread"), ["max-width", "padding-left", "padding-top"]),
    userBody: st(q(".msg.user .body"), ["background-color", "border-radius", "padding-left", "font-size"]),
    agentBody: st(q(".msg.agent .body"), ["background-color", "font-size", "line-height"]),
    meta: st(q(".msg .meta, .msg .who"), ["font-size", "font-family", "color"]),
    gaps,
  };
};

// ── Shots ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain").split("\n").filter(Boolean), cases: {}, pictures: [] };
const keep = (name: string) => receipt.pictures.push({ path: name, sha256: sha(readFileSync(join(out, name))) });
try {
  for (const c of matrix() as MatrixCase[]) {
    const tag = caseName(c), errors: string[] = [];
    (await import(repo + "/src/locale.ts")).setLocale(c.lang);
    // The Fleet chat.
    const { page, ctx, csp } = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(fleetName)}` });
    page.on("pageerror", (e: any) => errors.push(`fleet: ${e}`));
    await page.waitForFunction(() => document.querySelectorAll(".p-chat .thread .msg").length >= 4, undefined, { timeout: 20000 });
    await page.evaluate(async () => { await document.fonts.ready; }); await page.waitForTimeout(500);
    await (c.device === "desk" ? page.locator(".p-chat").first() : page).screenshot({ path: join(out, `fleet.${tag}.png`) }); keep(`fleet.${tag}.png`);
    await page.evaluate(SHIM); const fleetLook = await page.evaluate(MEASURE, ".p-chat");
    const fleetCsp = await csp(); await ctx.close();
    // The Hub room.
    const hfx = createHubRoomsFixture({ features: ["rooms-v1"] });
    const hctx = await fx.browser.newContext({ viewport: VIEWPORTS[c.device], colorScheme: c.theme, ignoreHTTPSErrors: true, locale: c.lang === "en" ? "en-US" : "zh-TW",
      isMobile: c.device === "phone", hasTouch: c.device === "phone" });
    await hctx.addInitScript(() => { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); });
    await hctx.route("**/hub/v1/**", async (q: any) => {
      const req = q.request(), u = new URL(req.url()), path = u.pathname + u.search;
      if (u.pathname.endsWith("/events")) return q.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "retry: 600000\n\n" });
      if (u.pathname === `/hub/v1/rooms/${ROOM}/messages` && req.method() === "GET") return q.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: roomMessages(), more: false }) });
      const raw = req.postData(), answer = hfx.handle({ method: req.method(), path, headers: req.headers(), body: raw ? JSON.parse(raw) : undefined });
      return q.fulfill({ status: answer?.status ?? 200, contentType: "application/json", body: JSON.stringify(answer?.body ?? {}) });
    });
    const hp = await hctx.newPage();
    hp.on("pageerror", (e: Error) => errors.push(`hub: ${e.message}`));
    await hp.goto(`${horigin}/ui/hub?room=${ROOM}`);
    await hp.waitForFunction(() => document.querySelectorAll(".hub-room-page .thread .msg").length >= 5, undefined, { timeout: 20000 });
    await hp.evaluate(async () => { await document.fonts.ready; }); await hp.waitForTimeout(500);
    await (c.device === "desk" ? hp.locator(".hub-chat-main").first() : hp).screenshot({ path: join(out, `room.${tag}.png`) }); keep(`room.${tag}.png`);
    await hp.evaluate(SHIM); const roomLook = await hp.evaluate(MEASURE, ".hub-room-page");
    // S-152: the room's message menu — a desk's right-click, a phone's long press (a real touch, 700 ms) on an answer's
    // header (its words would be the browser's text selection): Reply and Copy text, as the Fleet chat's menu.
    const head = hp.locator(".hub-room-page .thread .msg.agent .meta").last(), box = await head.boundingBox();
    if (c.device === "desk") await head.click({ button: "right" });
    else {
      const cdp = await hctx.newCDPSession(hp), at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] }); await hp.waitForTimeout(700);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await hp.waitForSelector(".msg-menu", { timeout: 5000 });
    const menuItems = await hp.locator(".msg-menu button").allTextContents();
    await hp.screenshot({ path: join(out, `menu.${tag}.png`) }); keep(`menu.${tag}.png`);
    await hctx.close();
    // Side by side.
    const v = VIEWPORTS[c.device], sctx = await fx.browser.newContext({ viewport: { width: v.width * 2 + 24, height: v.height + 40 } }), sp = await sctx.newPage();
    const dims = (n: string) => { const b = readFileSync(join(out, n)); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
    const img = (n: string) => `data:image/png;base64,${readFileSync(join(out, n)).toString("base64")}`;
    await sp.setContent(`<body style="margin:0;background:#888;font:14px sans-serif;display:flex;gap:24px">${[["Fleet chat", `fleet.${tag}.png`], ["Hub room", `room.${tag}.png`]]
      .map(([t, n]) => `<figure style="margin:0"><figcaption style="height:40px;line-height:40px;color:#fff;font-weight:600;padding-left:8px">${t}</figcaption><img src="${img(n)}" width="${dims(n).w}" height="${dims(n).h}"></figure>`).join("")}</body>`);
    await sp.screenshot({ path: join(out, `parity.${tag}.png`), fullPage: true }); keep(`parity.${tag}.png`); await sctx.close();
    receipt.cases[tag] = { errors, fleetCsp, menuItems, look: { fleet: fleetLook, room: roomLook } };
    console.log(`${errors.length || fleetCsp.length ? "FAIL" : "PASS"} ${tag}`, errors.length ? JSON.stringify(errors) : "");
  }
} finally {
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  server.close(); await fx.close();
}
process.exit(Object.values(receipt.cases).some((x: any) => x.errors.length || x.fleetCsp.length) ? 1 : 0);

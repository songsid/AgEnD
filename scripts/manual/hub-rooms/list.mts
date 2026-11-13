/**
 * M-3092 browser acceptance: the Hub's conversation list on the Fleet roster's rows (docs/design/hub-rooms-ux.md §2) and a
 * room on the Fleet chat's thread with its composer (§3–§4, §10).
 * The real Hub listener (tests/helpers/hub-s3b-rig.ts) serves the workspace shell and its modules over HTTPS on loopback;
 * every /hub/v1/* call is answered by the rooms fixture (tests/support/hub-rooms-fixture.ts) — no fleet, CLI or account.
 * Variants, EN/zh-TW × desktop/phone × light/dark (MATRIX=quick: desktop-en-light, phone-zh-TW-dark):
 *   before        — BASE_REF's panel-hub.js, hub-client.js and hub-chat.css served in place of this tree's; today's chats;
 *   after-live    — this tree; a Hub with rooms (the fixture: rooms, chats, the Hub assistant, unread, @, presence);
 *   after-limited — this tree; a Hub without rooms yet (today's chats in the new rows: waiting, closed);
 *   skew          — this tree's panel with BASE_REF's hub-client.js (an open tab after an upgrade): the same list, no error.
 * Room pages: `room-before.*` (a chat on BASE_REF's modules: today's room view), `room-after.*` (研一主管週會: authors, the
 * @all progress line, the room's own lines without tools), `menu-after.*` (the @ menu), and on the quick cases
 * `assistant-after.*` (the Hub assistant's one-to-one: 「問 Hub 助理」, never its stored English name).
 * Writes PNGs and receipt.json (sourceHead, baseRef, inputs' digests, every check, every PNG's sha256) to OUT.
 *   PW_DIR=<playwright-core root> REPO=$PWD OUT=<dir> [BASE_REF=origin/release/2.3.5-alpha] [MATRIX=full|quick] npx tsx scripts/manual/hub-rooms/list.mts
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const repo = resolve(process.env.REPO ?? "."), out = resolve(process.env.OUT ?? join(repo, ".artifacts/hub-rooms-list"));
const base = process.env.BASE_REF ?? "origin/release/2.3.5-alpha";
mkdirSync(out, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
const { createHubRoomsFixture } = await import(repo + "/tests/support/hub-rooms-fixture.ts");

const keys = mkdtempSync(join(out, ".keys-")), port = 49400 + Math.floor(Math.random() * 200), origin = `https://127.0.0.1:${port}`;
const r = await s3bRig({ webOrigin: origin });
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!r.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>(done => server.listen(port, "127.0.0.1", done));

const BASE_FILES: Record<string, string> = { "**/ui/js/panel-hub.js": "src/ui/panel-hub.js", "**/ui/js/hub-client.js": "src/ui/hub-client.js", "**/assets/hub-chat.css": "src/ui/shared/hub-chat.css" };
const baseOf = (path: string) => git("show", `${base}:${path}`);
/** Today's chats (a Hub without rooms), from the fixture's chats: one waiting, one closed. */
const LEGACY = [
  { id: "11111111-1111-4111-8111-111111111111", asker: {}, exposureId: "e1", ownerAtCreation: {}, grantId: "g1", state: "active", exposureName: "project-helper", exposureState: "published", ownerName: "林小華", grantExpiresAt: Date.now() + 6 * 86_400_000, lastAt: Date.now() - 60_000, waiting: true, features: [] },
  { id: "22222222-2222-4222-8222-222222222222", asker: {}, exposureId: "e2", ownerAtCreation: {}, grantId: "g2", state: "active", exposureName: "report-bot", exposureState: "published", ownerName: "吳小安", grantExpiresAt: Date.now() + 6 * 86_400_000, lastAt: Date.now() - 3_600_000, waiting: false, features: [] },
  { id: "33333333-3333-4333-8333-333333333333", asker: {}, exposureId: "e3", ownerAtCreation: {}, grantId: "g3", state: "closed", exposureName: "old-helper", exposureState: "published", ownerName: "林小華", grantExpiresAt: 0, lastAt: Date.now() - 5 * 86_400_000, waiting: false, features: [] },
];

const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core");
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), baseRef: git("rev-parse", base), dirty: git("status", "--porcelain").split("\n").filter(Boolean),
  inputs: [...Object.values(BASE_FILES).map(p => ({ path: p, base: sha(baseOf(p)) })),
    ...["src/ui/panel-hub.js", "src/ui/hub-client.js", "src/ui/hub-room-list.js", "src/ui/hub-room-strings.js", "src/ui/hub-room-thread.js", "src/ui/hub-room-composer.js", "src/ui/shared/chat-thread.js", "src/ui/shared/hub-chat.css", "tests/support/hub-rooms-fixture.ts"].map(p => ({ path: p, sha256: sha(readFileSync(join(repo, p))) }))],
  checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); };
const cases = (process.env.MATRIX ?? "full") === "quick"
  ? [["desktop", "en", "light"], ["phone", "zh-TW", "dark"]]
  : ["desktop", "phone"].flatMap(d => ["en", "zh-TW"].flatMap(l => ["light", "dark"].map(t => [d, l, t])));
const VIEW: Record<string, { width: number; height: number }> = { desktop: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } };

async function open(variant: "before" | "after-live" | "after-limited" | "skew", [device, lang, theme]: string[]) {
  const live = variant === "after-live", fx = createHubRoomsFixture({ features: live ? ["rooms-v1"] : [] });
  const ctx = await browser.newContext({ viewport: VIEW[device], colorScheme: theme, ignoreHTTPSErrors: true, locale: lang === "en" ? "en-US" : "zh-TW", isMobile: device === "phone", hasTouch: device === "phone" });
  await ctx.addInitScript(() => { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); });
  // Every Hub call is the fixture's (today's chats for a Hub without rooms); a call it does not serve answers empty.
  await ctx.route("**/hub/v1/**", async (q: any) => {
    const req = q.request(), u = new URL(req.url()), path = u.pathname + u.search;
    if (!live && u.pathname === "/hub/v1/rooms" && req.method() === "GET") return q.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rooms: LEGACY }) });
    if (u.pathname.endsWith("/events")) return q.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "retry: 600000\n\n" });
    const raw = req.postData(), answer = fx.handle({ method: req.method(), path, headers: req.headers(), body: raw ? JSON.parse(raw) : undefined });
    return q.fulfill({ status: answer?.status ?? 200, contentType: "application/json", body: JSON.stringify(answer?.body ?? {}) });
  });
  const routed: Record<string, string> = variant === "before" ? BASE_FILES : variant === "skew" ? { "**/ui/js/hub-client.js": "src/ui/hub-client.js" } : {};
  for (const [glob, path] of Object.entries(routed)) await ctx.route(glob, (q: any) => q.fulfill({ status: 200, contentType: path.endsWith(".css") ? "text/css" : "text/javascript", body: baseOf(path) }));
  const p = await ctx.newPage(), errors: string[] = [];
  p.on("pageerror", (e: Error) => errors.push(e.message));
  p.on("console", (m: any) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  await p.goto(`${origin}/ui/hub`);
  const list = device === "phone" ? ".hub-home-list .hub-side-rooms" : "#sidebar .hub-side-rooms";
  await p.waitForSelector(`${list} li`, { timeout: 15000 });
  await p.waitForTimeout(400);
  return { ctx, p, errors, list };
}
const shotPage = async (p: any, name: string) => {
  const file = join(out, name); await p.screenshot({ path: file });
  receipt.pictures.push({ path: name, sha256: sha(readFileSync(file)) });
};
const shot = async (p: any, sel: string, name: string) => {
  const file = join(out, name); await p.locator(sel).first().screenshot({ path: file });
  receipt.pictures.push({ path: name, sha256: sha(readFileSync(file)) });
};

try {
  for (const c of cases) {
    const tag = c.join("-");
    for (const variant of ["before", "after-live"] as const) {
      const { ctx, p, errors, list } = await open(variant, c);
      const names = await p.locator(`${list} .inst-name, ${list} .hub-room-text .t`).allTextContents();
      if (variant === "after-live") {
        const groups = await p.locator(`${list} .hub-room-group .side-label`).allTextContents();
        check(`${tag} after-live: 「房間」 then 「Agent」, six rows in the spec's order; unread and @ shown; no page error`,
          groups.length === 2 && names.length === 6 && names[0] === "研一主管週會" && await p.locator(`${list} .nav-count`).count() >= 1 && errors.length === 0, { groups, names, errors });
      } else check(`${tag} before: today's list (three chats, alpha's own rows); no page error`, names.length === 3 && errors.length === 0, { names, errors });
      await shot(p, device(c) === "phone" ? ".hub-home-list" : "#sidebar", `list.${variant}.${tag}.png`);
      // The room page: today's chat on the base's modules, or a room of a Hub with rooms on the shared thread.
      if (variant === "before") {
        await p.goto(`${origin}/ui/hub?room=${LEGACY[1]!.id}`);
        await p.waitForSelector(".hub-chat-main", { timeout: 15000 }); await p.waitForTimeout(400);
        check(`${tag} room-before: today's chat page opens; no page error`, errors.length === 0, { errors });
        await shotPage(p, `room-before.${tag}.png`);
      } else {
        await p.goto(`${origin}/ui/hub?room=room-weekly`);
        await p.waitForFunction(() => document.querySelectorAll(".hub-room-page .thread .msg").length > 5, undefined, { timeout: 15000 }); await p.waitForTimeout(400);
        const bareOk = await p.evaluate(() => [...document.querySelectorAll(".hub-room-page .thread .status-line")].every((el) => !el.querySelector(".msg-tools")));
        const progress = await p.locator(".hub-room-page .thread .status-line").allTextContents();
        check(`${tag} room-after: the room's header, its progress line, its own lines without tools; no page error`,
          bareOk && progress.some((x) => /6|已回答|Answered/.test(x)) && errors.length === 0, { bareOk, progress: progress.slice(0, 4), errors });
        await shotPage(p, `room-after.${tag}.png`);
        await p.locator(".hub-room-page #msgIn").fill("@");
        await p.locator(".hub-room-page #msgIn").press("End");
        await p.waitForSelector(".hub-room-page .cmd-palette li", { timeout: 5000 }).catch(() => {});
        const menu = await p.locator(".hub-room-page .cmd-palette .cmd-name").allTextContents();
        check(`${tag} menu-after: the @ menu leads with @All agents and the room assistant`, menu.length >= 2 && /All agents|所有 Agent/.test(menu[0] || "") && /assistant|房間助理/.test(menu[1] || ""), { menu: menu.slice(0, 3) });
        await shotPage(p, `menu-after.${tag}.png`);
      }
      await ctx.close();
    }
  }
  for (const c of [["desktop", "en", "light"], ["phone", "zh-TW", "dark"]]) {
    const tag = c.join("-"), { ctx, p, errors } = await open("after-live", c);
    await p.goto(`${origin}/ui/hub?room=room-assistant`);
    await p.waitForSelector(".hub-room-page .hub-assistant-empty", { timeout: 15000 }); await p.waitForTimeout(300);
    const ph = await p.locator(".hub-room-page .composer-ph").textContent(), body = await p.locator(".hub-room-page").textContent();
    check(`${tag} assistant-after: 「Hub 助理」 by its flag, its own prompt, never the stored English name; no page error`,
      /問 Hub 助理|Ask the Hub assistant/.test(ph || "") && (c[1] === "en" || !String(body).includes("Hub assistant")) && errors.length === 0, { ph, errors });
    await shotPage(p, `assistant-after.${tag}.png`);
    await ctx.close();
  }
  for (const c of [["desktop", "en", "light"], ["phone", "zh-TW", "dark"]]) {
    const tag = c.join("-");
    for (const variant of ["after-limited", "skew"] as const) {
      const { ctx, p, errors, list } = await open(variant, c);
      const names = await p.locator(`${list} .inst-name`).allTextContents(), busy = await p.locator(`${list} .av-dot.busy`).count();
      const lines = await p.locator(`${list} .inst-alt`).allTextContents();
      check(`${tag} ${variant}: today's chats in the new rows — 「Agent」 only, the waiting one with the working dot, the closed one said; no page error`,
        names.length === 3 && busy === 1 && lines.some(l => /Closed|已結束|已關閉|關閉/.test(l)) && errors.length === 0, { names, busy, lines, errors });
      await shot(p, c[0] === "phone" ? ".hub-home-list" : "#sidebar", `list.${variant}.${tag}.png`);
      await ctx.close();
    }
  }
} catch (e) { check("the run finished", false, String(e)); }
finally {
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  await browser.close(); server.close(); await r.close?.();
}
function device(c: string[]) { return c[0]; }
const failed = receipt.checks.filter((x: any) => !x.ok).length;
console.log(JSON.stringify({ pass: failed === 0, checks: receipt.checks.length, failed, pictures: receipt.pictures.length }));
process.exit(failed ? 1 : 0);

/**
 * #3226 D2 browser acceptance: the Hub chat (B) with attachments (D), real Hub HTTP + session over HTTPS on loopback,
 * S5's agreed fakes (tests/helpers/hub-s3b-rig.ts) with the real attachment store; the member is played through the
 * Hub's own receive path (attachment.put, the release lease, the answer). No fleet, tmux, CLI or account.
 * Per case (desktop en light, phone zh-TW dark):
 *   before — a room whose fleet link did not negotiate attachments-v1: no Attach, a line saying files can't be sent yet;
 *   after  — Attach a PNG and a CSV (uploaded at once, listed), Send names them; the agent answers with a CSV; the thread
 *            shows the asker's image inline and both files; downloads are attachment/nosniff/sandboxed.
 *   PW_DIR=… [OUT=docs/screenshots/hub-attachments-d2] REPO=$PWD npx tsx scripts/manual/hub-attachments/accept-chat.mts
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

const repo = resolve(process.env.REPO ?? "."), out = resolve(process.env.OUT ?? "docs/screenshots/hub-attachments-d2");
const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
const { messageContentDigest } = await import(repo + "/src/hub/identity.ts");
const { HUB_ATTACHMENT_CHUNK } = await import(repo + "/src/hub/protocol.ts");
mkdirSync(out, { recursive: true });
const keys = mkdtempSync(join(out, ".keys-")), port = 49200 + Math.floor(Math.random() * 200), origin = `https://127.0.0.1:${port}`;
const r = await s3bRig({ webOrigin: origin, attachments: true });
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!r.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>(done => server.listen(port, "127.0.0.1", done));
const owner = r.addPerson("owner", "Olivia"); r.addPerson("asker", "Alex");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
// A 320×180 bar-chart PNG and a CSV, as a person would attach them.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAAC9klEQVR42u3WQQ2AMBREwV5whAIs1AwG8IIIZHHrARTQCyFhm3lZBU0mv+WSFFvxBBLAkgCWBLAEsCSAJQEsCWAJYEkASwJYAlgSwJIAlgSwBLAkgCUBLAlgCWDpsXZMcQNYAhhgAQwwwAIYYAlggAUwwAALYIABFsAASwADLIABBlgAAywBDLAEMMACGGCABTDAEsAAC2CAARbAAAMsgAGWAAZYAAMMsAAGWAIYYAEMMMACGGCABTDAEsAAC2CAARbAAEsAA6x+817jBjDAAhhggAEGGGCAAQYYYAEMMMAAAwwwwAADDLAABhhgAQwwwAADDDDAAAMMsAAGGGABDDDAAAMMMMAAAwywAAYYYIABBhhggAEGWAADDLAABhhggAEGGGCAAQZYAAMMMMAAAwwwwAADDDDAAAMsgAEGGGCAAQYYYIABFsAAAyyAAQYYYIABBhhggAEWwAADDDDAAAMMMMAAowUwwAALYIABBhhggAEGGGCAv23ZzrgBDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAAAMMMMCjAV4lvS7yAksK/kJLAlgCWBLAkgCWBLAEsCSAJQEsCWAJYEkASwJYAlgSwJIAlgSwBLCkX3YDxTN0Z27yuHsAAAAASUVORK5CYII=", "base64");
const ASKER_CSV = Buffer.from("month,target\nJul,40\nAug,41\nSep,42\n"), AGENT_CSV = Buffer.from("region,sales\nnorth,18\nsouth,14\nwest,10\n");
const tmp = mkdtempSync(join(out, ".files-")); writeFileSync(join(tmp, "q3-chart.png"), PNG); writeFileSync(join(tmp, "targets.csv"), ASKER_CSV);

async function world(features: string[]) {
  const link = r.link(randomUUID(), owner, 1, ["welcome-caps-v1", ...features]), exposureId = randomUUID();
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId: link.fleetId, owner,
    displayName: "Atlas", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link), link);
  const o = await r.signIn("owner"), a = await r.signIn("asker");
  const grant = (await r.call(o, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "asker", days: 7 })).json.grant;
  const room = (await r.call(a, "POST", "/hub/v1/rooms", { exposureId, grantId: grant.id })).json.room;
  return { link, room };
}
/** The member answers the newest question with a CSV: chunks first, then the answer under its release lease. */
async function answerWithFile(link: any, messageId: string) {
  const ref = { id: randomUUID(), name: "q3-by-region.csv", size: AGENT_CSV.length, mime: "text/csv", sha256: sha(AGENT_CSV) };
  for (let offset = 0; offset < AGENT_CSV.length; offset += HUB_ATTACHMENT_CHUNK)
    await r.http.receive(r.frame("attachment.put", { id: ref.id, offset, total: ref.size, sha256: ref.sha256, data: AGENT_CSV.subarray(offset, offset + HUB_ATTACHMENT_CHUNK).toString("base64") }, link), link);
  const text = "Q3 was 42 against a target of 42. The breakdown by region is attached.", answerId = randomUUID(), contentDigest = messageContentDigest("answer", text, { attachments: [ref] });
  const lease = (await r.http.receive(r.frame("authorize.request", { messageId, operationId: randomUUID(), exposureRevision: 1, phase: "release-answer", answer: { answerId, contentDigest } }, link), link) as any).payload.lease;
  await r.http.receive(r.frame("answer", { messageId, answerId, text, contentDigest, releaseLease: lease, attachments: [ref] }, link), link);
}

const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core");
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const results: unknown[] = [];
try {
  for (const c of [{ device: "desktop", lang: "en", theme: "light", viewport: { width: 1366, height: 900 } },
    { device: "phone", lang: "zh-TW", theme: "dark", viewport: { width: 390, height: 844 } }]) {
    const zh = c.lang === "zh-TW", prefix = `${c.device}-${c.lang}`;
    const open = async (roomId: string) => {
      const context = await browser.newContext({ viewport: c.viewport, colorScheme: c.theme, ignoreHTTPSErrors: true });
      await context.addInitScript(({ lang }) => { localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_tour_done", "1"); }, { lang: c.lang });
      const p = await context.newPage(), errors: string[] = [], foreign: string[] = [], csp: string[] = [];
      p.on("pageerror", (e: Error) => errors.push(e.message));
      p.on("request", (q: any) => { if (new URL(q.url()).origin !== origin) foreign.push(q.url()); });
      await p.exposeFunction("captureCsp", (value: string) => csp.push(value));
      await p.addInitScript(() => document.addEventListener("securitypolicyviolation", e => (window as any).captureCsp(e.violatedDirective)));
      await p.goto(`${origin}/ui/hub?room=${roomId}`);
      await p.fill("#hubLogin", "asker"); await p.fill("#hubPassword", "pw-asker"); await p.click(".hub-signin button[type=submit]");
      await p.waitForSelector(".hub-chat-main #msgIn");
      return { context, p, errors, foreign, csp };
    };
    // Before: a fleet whose link did not negotiate files.
    const old = await world([]);
    const b = await open(old.room.id);
    assert.equal(await b.p.locator("#attachBtn").count(), 0);
    assert.equal((await b.p.locator(".hub-files-off").innerText()).trim(), zh ? "這個代理目前還不能接收檔案。" : "This agent can't receive files yet.");
    assert(await b.p.locator(".hub-files-off").isVisible(), "the line shows on this device");
    await b.p.screenshot({ path: join(out, `${prefix}-before.png`), fullPage: true });
    assert.deepEqual([b.errors, b.foreign, b.csp], [[], [], []]); await b.context.close();
    // After: a fleet that takes files.
    const w = await world(["attachments-v1"]);
    const a = await open(w.room.id);
    assert.equal(await a.p.locator("#attachBtn").count(), 1);
    await a.p.setInputFiles('.hub-chat-main input[type="file"]', [join(tmp, "q3-chart.png"), join(tmp, "targets.csv")]);
    await a.p.waitForFunction(() => document.querySelectorAll('.hub-pending-files .file-chip[data-state="ready"]').length === 2, null, { timeout: 20_000 });
    await a.p.fill("#msgIn", zh ? "第三季達標了嗎？圖表和目標都附上了。" : "Did Q3 hit the target? Chart and targets attached.");
    await a.p.screenshot({ path: join(out, `${prefix}-after-composer.png`), fullPage: true });
    const sent = a.p.waitForResponse((q: any) => q.url().endsWith("/messages") && q.request().method() === "POST");
    await a.p.click("#sendBtn");
    const receipt = (await (await sent).json()).receipt;
    assert.equal((await a.p.locator(".hub-pending-files").count()), 0);
    await answerWithFile(w.link, receipt.messageId);
    await a.p.waitForFunction(() => document.querySelectorAll(".msg.agent .att-file").length >= 1 && !!document.querySelector(".msg.user .att-img img"), null, { timeout: 30_000 });
    const src = await a.p.locator(".msg.user .att-img img").getAttribute("src");
    assert.match(src!, new RegExp(`^/hub/v1/rooms/${w.room.id}/files/[0-9a-f-]{36}/inline$`));
    await a.p.waitForFunction(() => { const i = document.querySelector(".msg.user .att-img img") as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth > 0; }, null, { timeout: 10_000 });
    const names = await a.p.locator(".msg .att-file").allInnerTexts();
    assert(names.some(n => n.includes("targets.csv")) && names.some(n => n.includes("q3-by-region.csv")), JSON.stringify(names));
    await a.p.screenshot({ path: join(out, `${prefix}-after-thread.png`), fullPage: true });
    // The answer's file, downloaded as the page links it: an attachment, never sniffed or run.
    const href = await a.p.locator(".msg.agent .att-file").first().getAttribute("href");
    const dl = await a.p.evaluate(async (u: string) => { const res = await fetch(u); return { status: res.status, cd: res.headers.get("content-disposition"), nosniff: res.headers.get("x-content-type-options"), csp: res.headers.get("content-security-policy"), body: await res.text() }; }, href!);
    assert.equal(dl.status, 200); assert.equal(dl.body, AGENT_CSV.toString()); assert.match(dl.cd!, /^attachment;/); assert.equal(dl.nosniff, "nosniff"); assert.equal(dl.csp, "default-src 'none'; sandbox");
    assert(await a.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual([a.errors, a.foreign, a.csp], [[], [], []]);
    results.push({ ...c, before: { noAttach: true, offLine: true }, after: { uploaded: 2, sentWithFiles: true, answerFile: true, imageInline: true, downloadHeaders: true }, errors: a.errors, foreign: a.foreign, csp: a.csp });
    await a.context.close();
  }
  console.log(JSON.stringify({ cases: results.length, pngs: results.length * 3, out, results }));
} finally {
  await browser.close(); await new Promise<void>(done => server.close(() => done())); await r.close();
  rmSync(keys, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true });
}

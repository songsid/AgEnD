/**
 * M-3125 PR1b browser acceptance: files in a group room, on the real Hub HTTP/SQLite and attachment store (tests/helpers/hub-s3b-rig.ts),
 * served by the actual Hub shell over HTTPS on loopback. No fleet, CLI or account.
 * A manager has posted an image; Alex opens the room, uses the composer's Attach (left of the box), sees the chips inside the box,
 * sends with text, and the post shows its files on the thread (image inline, the other file as a card).
 * Writes PNGs and receipt.json (sourceHead, checks, every PNG's sha256, the /hub/v1 requests) to OUT.
 *   PW_DIR=<playwright-core root> OUT=<dir> npx tsx scripts/manual/hub-rooms/room-files.mts
 */
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { provisionHubIdentity } from "../../../src/hub/tls.js";
import { personKeyString } from "../../../src/hub/identity.js";

const repo = process.cwd(), out = resolve(process.env.OUT ?? ".artifacts/hub-room-files");
mkdirSync(out, { recursive: true });
const keys = mkdtempSync(join(out, "keys-")), port = 49900 + Math.floor(Math.random() * 90), origin = `https://127.0.0.1:${port}`;
const r = await s3bRig({ webOrigin: origin, attachments: true }), alex = r.addPerson("alex", "Alex");
const admin = await r.signIn("admin"), actor = await r.signIn("alex");
const png = readFileSync(join(repo, "docs/evidence/hub-rooms-integration-r3/phone-zh-TW-dark-thread.png"));
const room = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Pilot weekly", people: [personKeyString(alex)] });
if (room.status !== 200) throw Error("room seed");
const roomId = room.json.room.id as string;
const seed = await fetch(`${r.base}/hub/v1/rooms/${roomId}/files`, { method: "POST", body: png,
  headers: { Origin: origin, Cookie: admin.cookie, "X-AgEnD-Hub-CSRF": admin.csrf, "X-File-Name": "thread-before.png" } });
const seeded = await seed.json() as any;
if ((await r.call(admin, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: crypto.randomUUID(), text: "Last week's thread, for reference.", files: [seeded.file.id] })).status !== 200) throw Error("post seed");
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) }, (req, res) => {
  if (!r.http.handle(req, res)) { res.writeHead(404); res.end(); }
});
await new Promise<void>(yes => server.listen(port, "127.0.0.1", yes));
const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core"), browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const receipt: any = { sourceHead: execFileSync("git", ["-c", "gc.auto=0", "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: execFileSync("git", ["status", "--porcelain", "--", "src"], { encoding: "utf8" }).trim().split("\n").filter(Boolean), checks: [], pictures: [], requests: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); };
try {
  for (const [device, lang, theme] of [["desktop", "en", "light"], ["desktop", "zh-TW", "dark"], ["phone", "en", "light"], ["phone", "zh-TW", "dark"]]) {
    const tag = `${device}-${lang}-${theme}`, errors: string[] = [], context = await browser.newContext({ viewport: device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, locale: lang, colorScheme: theme, ignoreHTTPSErrors: true, hasTouch: device === "phone", isMobile: device === "phone" });
    const at = actor.cookie.indexOf("=");
    await context.addCookies([{ name: actor.cookie.slice(0, at), value: actor.cookie.slice(at + 1), url: origin, httpOnly: true, secure: true, sameSite: "Strict" }]);
    await context.addInitScript(({ lang, theme }) => { localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_theme", theme); localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); }, { lang, theme });
    await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const p = await context.newPage(); p.on("pageerror", (e: Error) => errors.push(e.message));
    p.on("response", (response: any) => { const u = new URL(response.url()); if (u.pathname.startsWith("/hub/v1/rooms/")) receipt.requests.push({ tag, method: response.request().method(), path: u.pathname, status: response.status() }); });
    const shot = async (name: string) => { const path = `${tag}-${name}.png`; await p.screenshot({ path: join(out, path) }); receipt.pictures.push({ path, sha256: sha(readFileSync(join(out, path))) }); };
    await p.goto(`${origin}/ui/hub?room=${roomId}`); await p.locator(".hub-room-page #msgIn").waitFor();
    await p.locator(".hub-room-page .thread img").first().waitFor({ timeout: 10000 }).catch(() => {});
    check(tag + " the manager's image shows inline on the thread", await p.locator(".hub-room-page .thread img").count() >= 1);
    check(tag + " Attach shows left of the box", await p.locator(".hub-room-page #attachBtn").isVisible());
    await p.locator('.hub-room-page input[type="file"]').setInputFiles([
      { name: "plan.png", mimeType: "image/png", buffer: png },
      { name: "minutes.txt", mimeType: "text/plain", buffer: Buffer.from(lang === "en" ? "Minutes: ship the files slice." : "會議紀錄：檔案功能上線。") }]);
    await p.locator(".hub-room-page .hub-pending-files .file-chip[data-state=ready]").nth(1).waitFor();
    check(tag + " two chips inside the composer box, both ready", await p.locator(".hub-room-page .composer-box .hub-pending-files .file-chip[data-state=ready]").count() === 2);
    await p.locator(".hub-room-page #msgIn").fill(lang === "en" ? "The plan and the minutes" : "計畫和會議紀錄"); await shot("attach-pending");
    await p.locator(".hub-room-page #sendBtn").click();
    await p.locator(".hub-room-page .hub-pending-files").waitFor({ state: "detached" });
    await p.waitForTimeout(800);
    const body = await p.locator(".hub-room-page .thread").innerText();
    check(tag + " the post shows its text file as a card", body.includes("minutes.txt"));
    check(tag + " the post's image shows inline", await p.locator(".hub-room-page .thread img").count() >= 2);
    await shot("posted");
    check(tag + " no horizontal overflow", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    check(tag + " no page error", errors.length === 0, errors);
    await context.close();
  }
} catch (error) { check("run completed", false, String(error)); }
finally {
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2)); await browser.close();
  await r.http.close(); await new Promise<void>(yes => server.close(() => yes())); await r.close(); rmSync(keys, { recursive: true, force: true });
}
console.log(JSON.stringify({ checks: receipt.checks.length, failed: receipt.checks.filter((x: any) => !x.ok).length, pictures: receipt.pictures.length }));
process.exitCode = receipt.checks.some((x: any) => !x.ok) ? 1 : 0;

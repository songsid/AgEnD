/**
 * M-3308: Ctrl+V in a Hub room's composer, in a real browser on a real Hub (HTTPS + SQLite; a synthetic directory; no agent,
 * Fleet, native process or account). A paste is what the browser hands the page: a ClipboardEvent whose clipboardData carries
 *   screenshot — a PNG with the name Chrome gives a screen capture ("image.png"), as Win+Shift+S / PrintScreen leave it;
 *   unnamed    — the same picture with no name (another browser's clipboard image);
 *   file       — a copied file (notes.txt);
 *   long       — 5,000 characters of text (the Fleet chat attaches it as a text file past 4,000).
 * Judged per case: the file chips under the box (names, all uploaded), then Send: the Hub's stored message has that many files,
 * and the picture is drawn in the thread. BASELINE=1 (the base, SMOKE_NAME=…-before): expects no chip (the bug).
 * Cases: desk light en, desk dark zh-TW, phone light zh-TW, phone dark en. Pictures: <case>-<step>.png.
 *   REPO=<checkout> OUT=<dir> PW_DIR=<dir with playwright-core> [CHROME=<path>] npx tsx scripts/manual/smoke/smoke-hub-room-paste-m3308.mts
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
const repo = process.env.REPO!, out = process.env.OUT!, pwDir = process.env.PW_DIR!, baseline = process.env.BASELINE === "1";
if (!repo || !out || !pwDir) throw Error("REPO/OUT/PW_DIR required");
mkdirSync(out, { recursive: true });
const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
const { freeHubPort } = await import(repo + "/tests/helpers/hub-rig.ts");
const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
const { personKeyString } = await import(repo + "/src/hub/identity.ts");
const port = await freeHubPort(), origin = `https://127.0.0.1:${port}`;
const rig = await s3bRig({ webOrigin: origin, attachments: true });   // rooms that take files (attachments-v1)
const keys = mkdtempSync(join(out, "owned-keys-")); chmodSync(keys, 0o700);
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>((r, j) => { server.once("error", j); server.listen(port, "127.0.0.1", r); });
const pw = createRequire(pwDir + "/")("playwright-core");
const browser = await pw.chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const receipt: any = { source: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), baseline, cases: [], pageErrors: [], foreign: [] };
const check = (ok: unknown, msg: string) => { if (!ok) throw Error(msg); };
const shot = async (p: any, n: string) => { await p.evaluate(() => document.fonts.ready); await p.screenshot({ path: join(out, n + ".png"), fullPage: false }); };
const admin = await rig.signIn("admin");
const cases = [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "zh-TW" }, { device: "phone", theme: "dark", lang: "en" }];
// A real 64×40 PNG (a "screenshot"): drawn in the page, so its bytes are an image the Hub's checks accept.
const PASTES = [
  { key: "screenshot", files: [{ name: "image.png", png: true }] },
  { key: "unnamed", files: [{ name: "", png: true }] },
  { key: "file", files: [{ name: "notes.txt", text: "copied file contents\n" }] },
  { key: "long", text: "x".repeat(5000) },
];
try {
  for (const [i, c] of cases.entries()) {
    const tag = `${c.device}-${c.theme}-${c.lang}`, row: any = { tag, steps: {} }; receipt.cases.push(row);
    const login = "alex" + i, alex = rig.addPerson(login, "Alex"); await rig.signIn(login);
    const room = (await rig.call(admin, "POST", "/hub/v1/rooms", { name: `Paste ${tag}`, people: [personKeyString(alex)] })).json.room.id as string;
    const ctx = await browser.newContext({ viewport: c.device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, isMobile: c.device === "phone",
      hasTouch: c.device === "phone", locale: c.lang === "en" ? "en-US" : "zh-TW", colorScheme: c.theme, ignoreHTTPSErrors: true });
    await ctx.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});` });
    await ctx.route("**/*", (route: any) => { const u = new URL(route.request().url()); if (u.origin !== origin) { receipt.foreign.push(u.origin); return route.abort(); } return route.continue(); });
    const p = await ctx.newPage(); p.setDefaultTimeout(15000);
    p.on("pageerror", (e: any) => receipt.pageErrors.push(`${tag}: ${String(e)}`));
    try {
      await p.goto(origin + "/ui/hub"); await p.fill("#hubLogin", login); await p.fill("#hubPassword", "pw-" + login);
      await p.locator(".hub-signin button[type=submit]").click(); await p.locator(".hub-session-row").first().waitFor({ state: "attached" });
      await p.goto(`${origin}/ui/hub?room=${room}`); await p.locator("#msgIn").waitFor();
      // The room takes files: its Attach shows once the room's detail (its features) is read.
      row.attach = await p.locator(".p-hub .composer-box #attachBtn").waitFor({ timeout: 10000 }).then(() => true, () => false);
      check(row.attach, "the room takes files (its Attach is there)");
      for (const paste of PASTES) {
        await p.locator("#msgIn").click();
        const dispatched = await p.evaluate(async (paste: any) => {
          const dt = new DataTransfer();
          for (const f of paste.files || []) {
            let body: Blob;
            if (f.png) { const cv = document.createElement("canvas"); cv.width = 64; cv.height = 40; const g = cv.getContext("2d")!; g.fillStyle = "#3a7"; g.fillRect(0, 0, 64, 40); g.fillStyle = "#fff"; g.fillRect(8, 8, 30, 10);
              body = await new Promise<Blob>((r) => cv.toBlob((b) => r(b!), "image/png")); }
            else body = new Blob([f.text], { type: "text/plain" });
            dt.items.add(new File([body], f.name, { type: f.png ? "image/png" : "text/plain" }));
          }
          if (paste.text) dt.setData("text/plain", paste.text);
          const box = document.querySelector("#msgIn") as HTMLElement;
          const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
          box.dispatchEvent(ev);
          return { prevented: ev.defaultPrevented };
        }, paste);
        await p.waitForTimeout(1500);
        const chips = await p.evaluate(() => [...document.querySelectorAll(".hub-pending-files .file-chip")].map((c) => ({ name: c.querySelector(".nm")?.textContent || "", state: c.getAttribute("data-state") })));
        const step: any = { prevented: dispatched.prevented, chips }; row.steps[paste.key] = step;
        await shot(p, `${tag}-${paste.key}-1-pasted`);
        if (baseline) { check(chips.length === 0, `baseline ${paste.key}: expected no chip`); continue; }
        check(chips.length === 1 && chips[0]!.state === "ready" && chips[0]!.name, `${paste.key}: one uploaded chip (${JSON.stringify(chips)})`);
        if (paste.key === "screenshot" || paste.key === "unnamed") check(/\.png$/.test(chips[0]!.name), `${paste.key}: an image's name (${chips[0]!.name})`);
        if (paste.key === "long") check(/\.txt$/.test(chips[0]!.name), `long: a text file (${chips[0]!.name})`);
        const posted = async () => ((await rig.call(admin, "GET", `/hub/v1/rooms/${room}/messages`)).json.messages as any[]).filter((m: any) => m.author?.kind === "person");
        const before = (await posted()).length;
        await p.locator("#sendBtn").click();
        const end = Date.now() + 10000; let stored: any = null;
        while (Date.now() < end) { const mine = await posted(); if (mine.length > before) { stored = mine.at(-1); break; } await new Promise(r => setTimeout(r, 200)); }
        check(stored && stored.files?.length === 1 && stored.files[0].name === chips[0]!.name, `${paste.key}: the sent message carries that file (${JSON.stringify(stored?.files)})`);
        step.stored = stored.files.map((f: any) => ({ name: f.name, mime: f.mime, size: f.size }));
        if (paste.key === "screenshot") { await p.locator(".msg img").last().waitFor({ timeout: 8000 }); step.drawn = true; }
        await p.waitForTimeout(500); await shot(p, `${tag}-${paste.key}-2-sent`);
      }
      row.status = baseline ? "BASELINE_REPRODUCED" : "PASS";
    } catch (e: any) { row.status = "FAIL"; row.error = String(e?.stack || e).slice(0, 800); await shot(p, `${tag}-FAIL`).catch(() => {}); }
    finally { await ctx.close(); }
  }
} finally {
  await browser.close(); await new Promise<void>(r => server.close(() => r())); await rig.close(); rmSync(keys, { recursive: true, force: true });
  receipt.status = receipt.cases.length === cases.length && receipt.cases.every((x: any) => x.status === (baseline ? "BASELINE_REPRODUCED" : "PASS")) && !receipt.pageErrors.length ? "PASS" : "FAIL";
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ source: receipt.source, baseline, status: receipt.status, cases: receipt.cases.map((x: any) => ({ tag: x.tag, status: x.status, error: x.error, steps: x.steps })), pageErrors: receipt.pageErrors, foreign: receipt.foreign }));
}
process.exitCode = receipt.status === "PASS" ? 0 : 1;

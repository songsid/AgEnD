/**
 * M-3311 (1): files dropped onto a Hub room's conversation (and the long-paste notice), as in the Fleet chat. Before that, M-3308: Ctrl+V in a Hub room's composer, in a real browser on a real Hub (HTTPS + SQLite; a synthetic directory; no agent,
 * Fleet, native process or account). A paste is what the browser hands the page: a ClipboardEvent whose clipboardData carries
 *   screenshot — a PNG with the name Chrome gives a screen capture ("image.png"), as Win+Shift+S / PrintScreen leave it;
 *   unnamed    — the same picture with no name (another browser's clipboard image);
 *   file       — a copied file (notes.txt);
 *   long       — 5,000 characters of text (the Fleet chat attaches it as a text file past 4,000).
 * Judged per case: the file chips under the box (names, all uploaded), then Send: the Hub's stored message has that many files,
 * and the picture is drawn in the thread. BASELINE=1 (the base): expects no drop card and no chip (the gap). Steps: a screenshot dragged over the conversation (the drop card, mid-drag),
 * dropped (its chip, then Send: the Hub stores it); a markdown file dropped; 5,000 characters pasted (the chip and the notice).
 * Cases: desk light en, desk dark zh-TW, phone light zh-TW, phone dark en. Pictures: <case>-<step>.png.
 *   REPO=<checkout> OUT=<dir> PW_DIR=<dir with playwright-core> [CHROME=<path>] npx tsx scripts/manual/smoke/smoke-hub-room-drop-m3311.mts
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
try {
  for (const [i, c] of cases.entries()) {
    const tag = `${c.device}-${c.theme}-${c.lang}`, row: any = { tag, steps: {} }; receipt.cases.push(row);
    const login = "alex" + i, alex = rig.addPerson(login, "Alex"); await rig.signIn(login);
    const room = (await rig.call(admin, "POST", "/hub/v1/rooms", { name: `Drop ${tag}`, people: [personKeyString(alex)] })).json.room.id as string;
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
      row.attach = await p.locator(".p-hub .composer-box #attachBtn").waitFor({ timeout: 10000 }).then(() => true, () => false);
      check(row.attach, "the room takes files (its Attach is there)");
      const chips = () => p.evaluate(() => [...document.querySelectorAll(".hub-pending-files .file-chip")].map((c) => ({ name: c.querySelector(".nm")?.textContent || "", state: c.getAttribute("data-state") })));
      const posted = async () => ((await rig.call(admin, "GET", `/hub/v1/rooms/${room}/messages`)).json.messages as any[]).filter((m: any) => m.author?.kind === "person");
      const sendAndStored = async (name: string) => {
        const before = (await posted()).length; await p.locator("#sendBtn").click();
        const end = Date.now() + 10000; while (Date.now() < end) { const mine = await posted(); if (mine.length > before) return mine.at(-1); await new Promise(r => setTimeout(r, 200)); }
        throw Error(`${name}: not sent`);
      };
      // A drag, as the browser hands it to the page: DragEvents whose dataTransfer carries the files (a real PNG drawn here).
      const dragTo = (phase: string, which: string) => p.evaluate(async ({ phase, which }: any) => {
        const dt = new DataTransfer();
        if (which === "png") { const cv = document.createElement("canvas"); cv.width = 64; cv.height = 40; const g = cv.getContext("2d")!; g.fillStyle = "#37a"; g.fillRect(0, 0, 64, 40);
          const b = await new Promise<Blob>((r) => cv.toBlob((x) => r(x!), "image/png")); dt.items.add(new File([b], "capture.png", { type: "image/png" })); }
        else dt.items.add(new File(["# plan\n- one\n"], "plan.md", { type: "text/markdown" }));
        const target = (document.querySelector(".hub-room-page .msg") || document.querySelector(".hub-room-page .hub-chat-main")) as HTMLElement;
        const fire = (type: string) => { const ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }); target.dispatchEvent(ev); return ev.defaultPrevented; };
        if (phase === "over") { fire("dragenter"); return { over: fire("dragover"), card: !!document.querySelector(".hub-chat-main.dragging .drop-overlay") && getComputedStyle(document.querySelector(".hub-chat-main .drop-overlay")!).display !== "none" }; }
        return { dropped: fire("drop") };
      }, { phase, which });
      const over = await dragTo("over", "png"); row.steps.over = over; await shot(p, `${tag}-1-dragging`);
      if (baseline) { check(!over.card, "baseline: expected no drop card"); }
      else check(over.card && over.over, `the drop card while a file is dragged over (${JSON.stringify(over)})`);
      const dropped = await dragTo("drop", "png"); await p.waitForTimeout(1500); const c1 = await chips(); row.steps.dropPng = { ...dropped, chips: c1 };
      await shot(p, `${tag}-2-dropped`);
      if (baseline) { check(c1.length === 0, "baseline: expected no chip"); row.status = "BASELINE_REPRODUCED"; continue; }
      check(c1.length === 1 && c1[0]!.name === "capture.png" && c1[0]!.state === "ready", `the dropped picture's chip (${JSON.stringify(c1)})`);
      const s1 = await sendAndStored("png"); check(s1?.files?.[0]?.name === "capture.png", `stored (${JSON.stringify(s1?.files)})`);
      await p.locator(".msg img").last().waitFor({ timeout: 8000 }); await p.waitForTimeout(400); await shot(p, `${tag}-3-sent`);
      await dragTo("drop", "md"); await p.waitForTimeout(1500); const c2 = await chips(); row.steps.dropMd = c2;
      check(c2.length === 1 && c2[0]!.name === "plan.md", `the dropped file's chip (${JSON.stringify(c2)})`);
      await sendAndStored("md");
      // 5,000 characters pasted: a text-file chip and the Fleet chat's notice (a toast).
      await p.locator("#msgIn").click();
      await p.evaluate(() => { const dt = new DataTransfer(); dt.setData("text/plain", "y".repeat(5000)); document.querySelector("#msgIn")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
      await p.waitForTimeout(1500); const c3 = await chips(), toastText = await p.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent || "").join(" | "));
      row.steps.long = { chips: c3, toast: toastText };
      check(c3.length === 1 && /^pasted-\d{14}\.txt$/.test(c3[0]!.name), `the long paste's chip (${JSON.stringify(c3)})`);
      check(/5,000/.test(toastText), `the notice (${toastText})`);
      await shot(p, `${tag}-4-long-paste`);
      row.status = "PASS";
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

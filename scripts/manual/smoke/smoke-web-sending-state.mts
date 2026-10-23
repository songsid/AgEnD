// The web chat's sending state (the user's request: Discord-like feedback), from defaults (fleet decision a78ebdc5), on
// a throttled network so every state stays on screen long enough to see — a fresh profile, driven only through visible
// UI: sign in, open the agent from the sidebar (a phone: through the drawer), send.
// - text: the bubble is there at once, dimmed, "Sending…", the composer already empty; /ui/send held 1.8 s; then it
//   reads as sent — one bubble, also after the live copy (SSE) has come in.
// - failure: /ui/send cut off → the bubble stays, "Not sent: …" with Retry / Put back / Delete; Retry sends it (one
//   bubble, one hand-off); Delete removes another; Put back gives a third back to the composer.
// - uploads: an image and a text file on a 256 KB/s uplink (Chromium's network emulation) → each file its own bar and
//   percentage, the second "waiting" while the first goes; then the sent message with the image. An upload cut off →
//   that file "failed" and Retry.
// The agent is a stub at the IPC boundary (no CLI, tmux, vendor or account).
// Output: sending/<case>-*.png and result.json.
//   PW_DIR=… REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-web-sending-state.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48791), instances: 2 });
const fm = fx.fm;
const template = fx.instances.find((i: any) => !i.general)!.name;
const name = "demo-agent";
fm.fleetConfig.instances[name] = { ...fm.fleetConfig.instances[template], display_name: "Demo agent", description: "Synthetic sending fixture" };
delete fm.fleetConfig.instances[template];
const handoffs: string[] = [];
fm.instanceIpcClients.set(name, { connected: true, send(payload: any) { handoffs.push(String(payload.content ?? "")); return true; } });
fm.getInstanceStatus = () => "running";
const r: any = { cases: {} };
const ok = (c: any, k: string, v: boolean) => { c[k] = v; if (!v) c.failed = [...(c.failed ?? []), k]; };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** In-page: a PNG of noise (it does not compress), as a base64 string — big enough that a slow uplink shows its bar. */
const NOISE_PNG = `(() => { const c = document.createElement("canvas"); c.width = 560; c.height = 360; const g = c.getContext("2d");
  const d = g.createImageData(c.width, c.height); for (let i = 0; i < d.data.length; i += 4) { d.data[i] = 40 + (i * 7) % 90 + Math.random() * 120; d.data[i + 1] = 90 + Math.random() * 120; d.data[i + 2] = 160 + Math.random() * 90; d.data[i + 3] = 255; }
  g.putImageData(d, 0, 0); return c.toDataURL("image/png").split(",")[1]; })()`;
const TEXT_FILE = Buffer.from(Array.from({ length: 9000 }, (_, i) => `line ${i}: the demo build's deploy log, step ${i % 40}\n`).join(""));

const CASES = [
  { device: "desk", theme: "light", lang: "en", reducedMotion: false },
  { device: "phone", theme: "dark", lang: "zh-TW", reducedMotion: true },
  { device: "phone", theme: "light", lang: "en", reducedMotion: false },
] as const;
for (const c of CASES.filter((x) => !process.env.ONLY || `${x.device}-${x.theme}-${x.lang}` === process.env.ONLY)) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c, { reducedMotion: c.reducedMotion });
  const page = p.page;
  const shot = (label: string) => page.screenshot({ path: shotPath("sending", c as any, label), caret: "initial" });
  const en = c.lang === "en";
  // The thread keeps the earlier cases' messages (one fixture): each case's own words, so "one bubble" counts its own.
  const own = (text: string) => c.device === "phone" ? text + (en ? " (phone)" : "（手機）") : text;
  // /ui/send: held (the slow acceptance the user saw as a freeze), or cut off.
  let sendMode: "slow" | "cut" = "slow";
  await page.route("**/ui/send", async (route: any) => { if (sendMode === "cut") return route.abort("failed"); await sleep(1800); return route.continue(); });
  const pending = page.locator(".msg.out");
  const userBubbles = (text: string) => page.locator(".msg.user:not(.out) .body", { hasText: text });
  /** A cut-off request's own console line (the route aborts it on purpose): accepted for /ui/send and /ui/upload only. */
  const errorsOf = (list: string[]) => list.filter((e) => !/^Failed to load resource: net::ERR_FAILED @ \S+\/ui\/(send|upload)(\?\S*)?$/.test(e));
  const noOverflow = () => page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`);
  try {
    ok(res, "mounted", await mounted(page) && errorsOf(p.errors).length === 0);
    if (c.device === "phone") await page.locator("#main button.only-narrow").click();
    await page.locator(`a[href="/ui/chat/${encodeURIComponent(name)}"]`).first().click();
    await page.locator("#msgIn").waitFor();

    // 1. A text message: at once, dimmed, "Sending…" — then sent, once.
    const TEXT = own(en ? "Deploy the demo build to staging" : "把示範版本部署到 staging");
    await page.locator("#msgIn").fill(TEXT);
    const t0 = Date.now(), before = handoffs.length;
    const accepted = page.waitForResponse((x: any) => x.url().endsWith("/ui/send"));
    await page.locator("#sendBtn").click();
    await pending.first().waitFor({ timeout: 1000 });
    ok(res, "bubbleAtOnce", Date.now() - t0 < 1000);
    ok(res, "composerEmptied", (await page.locator("#msgIn").inputValue()) === "");
    ok(res, "dimmedWhileSending", await pending.first().evaluate((el: Element) => el.matches(".out-sending, .out-queued") && Number(getComputedStyle(el.querySelector(".md")!).opacity) < 1));
    ok(res, "sendingCue", ((await pending.first().locator(".out-state").textContent()) ?? "").includes(en ? "Sending" : "傳送中"));
    res.spinnerAnimation = await pending.first().locator(".out-spin").evaluate((el: Element) => getComputedStyle(el).animationName);
    ok(res, "spinnerRespectsMotion", res.spinnerAnimation === (c.reducedMotion ? "none" : "out-spin"));
    await shot("1-sending");
    ok(res, "sent200", (await accepted).status() === 200);
    ok(res, "pendingResolved", await pending.first().waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false));
    await sleep(800);                                                       // the live copy has come in by now
    ok(res, "oneBubble", await userBubbles(TEXT).count() === 1);
    ok(res, "oneHandoff", handoffs.length === before + 1);
    await shot("2-sent");

    // 2. Cut off: the bubble stays, failed, with Retry / Delete; Retry sends it once.
    sendMode = "cut";
    const FAIL = own(en ? "Retry me after the cut" : "斷線後重試這則");
    await page.locator("#msgIn").fill(FAIL);
    await page.locator("#sendBtn").click();
    const failedBubble = page.locator(".msg.out.out-failed");
    await failedBubble.waitFor({ timeout: 5000 });
    const note = failedBubble.locator(".out-note");
    ok(res, "failedNote", ((await note.textContent()) ?? "").startsWith(en ? "Not sent: it did not reach AgEnD" : "沒有送出：沒有送到 AgEnD"));
    res.failedButtonTexts = await note.locator("button").allTextContents();
    ok(res, "failedButtons", JSON.stringify(res.failedButtonTexts) === (en ? '["Retry send","Put back","Delete"]' : '["重試傳送","放回輸入框","刪除"]'));
    ok(res, "failedNotDimmed", await failedBubble.evaluate((el: Element) => Number(getComputedStyle(el.querySelector(".md")!).opacity) === 1));
    ok(res, "noOverflowFailed", await noOverflow() as boolean);
    // The note hugs its words under the bubble's right edge (its bar beside them), as the bubble does.
    res.noteGeometry = await failedBubble.evaluate((el: Element) => { const b = el.querySelector(".body")!.getBoundingClientRect(), n = el.querySelector(".out-note")!.getBoundingClientRect(), cs = getComputedStyle(el.querySelector(".out-note")!);
      return { bodyRight: Math.round(b.right), noteRight: Math.round(n.right), noteLeft: Math.round(n.left), msgW: Math.round(el.getBoundingClientRect().width), ml: cs.marginLeft, w: cs.width, disp: getComputedStyle(el).display }; });
    ok(res, "noteUnderBubbleRight", Math.abs(res.noteGeometry.bodyRight - res.noteGeometry.noteRight) <= 2);
    await shot("3-failed");
    sendMode = "slow";
    const h1 = handoffs.length;
    await note.locator('[data-act="retryOut"]').click();
    await page.locator(".msg.out.out-sending").waitFor({ timeout: 1000 });
    ok(res, "retryResolves", await pending.first().waitFor({ state: "detached", timeout: 6000 }).then(() => true, () => false));
    await sleep(800);
    ok(res, "retryOneBubble", await userBubbles(FAIL).count() === 1 && handoffs.length === h1 + 1);
    sendMode = "cut";
    const DROP = own(en ? "Delete me" : "刪掉這則");
    await page.locator("#msgIn").fill(DROP);
    await page.locator("#sendBtn").click();
    await failedBubble.waitFor({ timeout: 5000 });
    await failedBubble.locator('[data-act="deleteOut"]').click();
    ok(res, "deleteRemoves", await pending.count() === 0 && await page.locator(".msg.user", { hasText: DROP }).count() === 0);
    // Put back: the text in the composer again, the bubble gone.
    const EDIT = own(en ? "Put me back" : "放回來改");
    await page.locator("#msgIn").fill(EDIT);
    await page.locator("#sendBtn").click();
    await failedBubble.waitFor({ timeout: 5000 });
    await failedBubble.locator('[data-act="putBackOut"]').click();
    ok(res, "putBack", await pending.count() === 0 && (await page.locator("#msgIn").inputValue()) === EDIT);
    await page.locator("#msgIn").fill("");
    sendMode = "slow";

    // 3. Uploads on a slow uplink: each file its own bar; then the sent message with the image.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: -1, uploadThroughput: 256 * 1024 });
    const png = Buffer.from(await page.evaluate(NOISE_PNG) as string, "base64");
    res.pngBytes = png.length;
    await page.locator('input[type="file"]').setInputFiles([{ name: "staging-preview.png", mimeType: "image/png", buffer: png }, { name: "deploy.log", mimeType: "text/plain", buffer: TEXT_FILE }]);
    const UP = own(en ? "Two files for the deploy" : "部署用的兩個檔案");
    await page.locator("#msgIn").fill(UP);
    await page.locator("#sendBtn").click();
    await pending.first().waitFor({ timeout: 1000 });
    const samples: Array<[string, string, string][]> = [];
    let shotTaken = false;
    while (await pending.count() > 0 && samples.length < 400) {
      const s = await pending.first().evaluate((el: Element) => [...el.querySelectorAll<HTMLElement>(".out-file")].map((f) => [f.dataset.state || "", f.querySelector(".out-bar")!.getAttribute("aria-valuenow") || "", f.querySelector(".out-pct")!.textContent || ""])).catch(() => null) as any;
      if (s) {
        samples.push(s);
        const v = Number(s[0]?.[1]);
        if (!shotTaken && s.length === 2 && s[0][0] === "uploading" && v >= 20 && v <= 80) { shotTaken = true; ok(res, "noOverflowUploading", await noOverflow() as boolean); await shot("4-uploading"); }
      }
      await sleep(100);
    }
    const mid = (i: number) => samples.some((s) => s[i] && s[i][0] === "uploading" && Number(s[i][1]) > 0 && Number(s[i][1]) < 100);
    ok(res, "firstFileProgress", mid(0));
    ok(res, "secondFileProgress", mid(1));
    ok(res, "secondWaitsFirst", samples.some((s) => s[0]?.[0] === "uploading" && s[1]?.[0] === "waiting" && s[1]?.[2] === (en ? "waiting" : "等待中")));
    ok(res, "pctText", samples.some((s) => /^\d+%$/.test(s[0]?.[2] ?? "")));
    ok(res, "uploadShot", shotTaken);
    res.samples = samples.length;
    await sleep(800);
    const sentUp = page.locator(".msg.user:not(.out)", { hasText: UP });
    ok(res, "uploadOneBubble", await sentUp.count() === 1);
    ok(res, "sentImage", await sentUp.locator("img").count() >= 1);
    await shot("5-uploaded");

    // 4. An upload cut off: that file failed, Retry sends it.
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const UPLOAD = /\/ui\/upload(\?|$)/;
    await page.route(UPLOAD, (route: any) => route.abort("failed"));
    await page.locator('input[type="file"]').setInputFiles([{ name: "notes.log", mimeType: "text/plain", buffer: Buffer.from("cut off\n") }]);
    await page.locator("#sendBtn").click();
    await failedBubble.waitFor({ timeout: 5000 });
    ok(res, "uploadFailedLabel", ((await failedBubble.locator(".out-file .out-pct").textContent()) ?? "") === (en ? "failed" : "失敗"));
    ok(res, "uploadFailedState", await failedBubble.locator('.out-file[data-state="failed"]').count() === 1);
    await shot("6-upload-failed");
    await page.unroute(UPLOAD);
    await failedBubble.locator('[data-act="retryOut"]').click();
    ok(res, "uploadRetryResolves", await pending.first().waitFor({ state: "detached", timeout: 6000 }).then(() => true, () => false));
    ok(res, "noPageErrors", errorsOf(p.errors).length === 0);
    res.errors = errorsOf(p.errors);
    res.expectedCutOff = p.errors.length - res.errors.length;
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 300)}`];
    res.pendingHtml = await pending.evaluateAll((els: Element[]) => els.map((e) => e.outerHTML.slice(0, 1500))).catch(() => null);
    await shot("error").catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((c: any) => !c.failed);
writeFileSync(shotPath("sending", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);

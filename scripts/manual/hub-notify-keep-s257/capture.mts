/** S-257 step 1 captures: the real Hub (tests/helpers/hub-s3b-rig.ts) over owned HTTPS, headless Chromium, synthetic people.
 *  Notifications are granted to the page; pressing the bell shows the one-time "Keep notifications coming" notice. */
import assert from "node:assert/strict";
import { createServer as createHttps } from "node:https";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const REPO = process.env.REPO!, PW = process.env.PW_DIR!, CHROME = process.env.CHROME!;
const out = process.env.OUT ?? join(process.cwd(), ".artifacts", "s257"); mkdirSync(out, { recursive: true });
const pw = createRequire(join(resolve(PW), "package.json"))("playwright-core");
const { s3bRig } = await import(join(REPO, "tests/helpers/hub-s3b-rig.ts"));
const { createOwnedPki } = await import(join(REPO, "scripts/manual/hub-connector-4c/rig.mts"));
const scratch = mkdtempSync(join(tmpdir(), "s257-hub-")), pki = createOwnedPki(join(scratch, "pki"));
let r: any;
const server = createHttps({ key: readFileSync(pki.key), cert: readFileSync(pki.cert) }, (req, res) => { if (!r?.http.handle(req, res)) { res.writeHead(404); res.end(); } });
const browser = await pw.chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const result: Record<string, unknown> = {};
try {
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  r = await s3bRig({ webOrigin: origin, realAudit: true });
  // Variants: "untrusted" is what this self-signed Hub really is (observed). "tab" and "app" fake only the facts the
  // page reads — a worker registration that succeeds (as on a trusted certificate), and the installed window's
  // display-mode — so the frame shows those notices; nothing else differs.
  const FAKE: Record<string, string> = {
    untrusted: "",
    // A trusted certificate: the worker registers and Chrome makes its install offer (headless never does: one synthetic event).
    tab: `if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.resolve({ scope: "/" });
      addEventListener("load", () => setTimeout(() => { const e = new Event("beforeinstallprompt", { cancelable: true }); e.prompt = async () => {}; e.userChoice = Promise.resolve({ outcome: "dismissed" }); dispatchEvent(e); }, 300));`,
    app: `const mm = window.matchMedia.bind(window); window.matchMedia = (q) => /display-mode: *standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : mm(q);`,
  };
  for (const [device, lang, theme] of [["desk", "en", "light"], ["phone", "zh-TW", "dark"]] as const) for (const variant of ["untrusted", "tab", "app"]) {
    const phone = device === "phone", tag = `${device}-${theme}-${lang}${variant === "untrusted" ? "" : "-" + variant}`;
    const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 }, isMobile: phone, hasTouch: phone,
      deviceScaleFactor: 2, locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: theme, ignoreHTTPSErrors: true,
      // A phone has no desktop notifications (the bell is off there); the phone frame uses a desktop user agent so the
      // notice can be shown at phone width.
      ...(phone ? { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36" } : {}) });
    await ctx.grantPermissions(["notifications"], { origin });
    await ctx.addInitScript({ content: `localStorage.setItem('agend_lang',${JSON.stringify(lang)});localStorage.setItem('agend_theme',${JSON.stringify(theme)});localStorage.setItem('agend_tour_done','1');` + FAKE[variant] });
    const page = await ctx.newPage(); page.setDefaultTimeout(20000);
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    try {
      await page.goto(origin + "/ui/hub?view=notices");
      await page.fill("#hubLogin", "admin"); await page.fill("#hubPassword", "pw-admin"); await page.locator(".hub-signin button[type=submit]").click();
      const bell = page.locator(".hub-head-tools .hub-notify:visible").first(); await bell.waitFor(); await page.waitForTimeout(1500);
      const state = await page.evaluate(async () => (await import("/assets/app-install.js")).installStore.get().state);
      assert.equal(state, { untrusted: "untrusted", tab: "available", app: "installed" }[variant]);
      if (variant === "untrusted") {
        // The bell's own words are its tooltip (title), which headless Chromium doesn't paint: the fixture draws that
        // exact title text under the bell, before and after turning it on, and records the attribute.
        const tip = async (name: string) => {
          await page.waitForTimeout(500);
          if (await page.locator("dialog[open]").count()) throw Error("a dialog is still open: the tooltip frame would show it");
          const title = await page.locator(".hub-head-tools .hub-notify:visible").first().getAttribute("title");
          await page.evaluate((text) => { document.getElementById("s257-tip")?.remove(); const b = [...document.querySelectorAll(".hub-head-tools .hub-notify")].find((x) => (x as HTMLElement).getBoundingClientRect().width > 0) as HTMLElement; const r = b.getBoundingClientRect();
            const d = document.createElement("div"); d.id = "s257-tip"; d.textContent = text; // The page's CSP refuses inline style attributes: set the box through the CSSOM.
            Object.assign(d.style, { position: "fixed", top: `${r.bottom + 6}px`, right: `${Math.max(8, innerWidth - r.right)}px`, maxWidth: "min(320px, 90vw)", padding: "6px 8px",
              borderRadius: "6px", background: "#333", color: "#fff", font: "12px/1.4 system-ui, sans-serif", zIndex: "99999", boxShadow: "0 2px 8px rgba(0,0,0,.3)" }); document.body.append(d); }, title);
          await page.screenshot({ path: join(out, `hub-${tag}-bell-${name}.png`) });
          await page.evaluate(() => document.getElementById("s257-tip")?.remove());
          return title;
        };
        result[`${tag}-bell-off`] = await tip("off");
        await bell.click(); await page.locator("dialog[open]").waitFor();
        await page.locator('dialog[open] [data-confirm="yes"]').click(); await page.waitForTimeout(400);
        result[`${tag}-bell-on`] = await tip("on");
        // Off again, forget the device's "shown" mark and open the page anew (a page shows it once), then as for the others.
        await bell.click(); await page.waitForTimeout(400);
        await page.evaluate(() => localStorage.removeItem("agend_hub_notify_kept"));
        await page.reload(); await bell.waitFor(); await page.waitForTimeout(1500);
      }
      await bell.click();
      const dialog = page.locator("dialog[open]"); await dialog.waitFor();
      const words = (await dialog.innerText()).replace(/\s+/g, " ").trim();
      assert.match(words, lang === "en" ? /Keep notifications coming/ : /持續收到通知/);
      await page.screenshot({ path: join(out, `hub-${tag}-keep.png`) });
      await dialog.locator('[data-confirm="yes"]').click(); await page.waitForTimeout(400);
      // Off and on again: no second notice.
      await bell.click(); await page.waitForTimeout(400); await bell.click(); await page.waitForTimeout(800);
      const again = await page.locator("dialog[open]").count();
      assert.equal(again, 0); assert.deepEqual(errors, []);
      result[tag] = { notice: words, secondTime: again };
    } finally { await ctx.close(); }
  }
} finally { await browser.close(); server.close(); await r?.close?.(); rmSync(scratch, { recursive: true, force: true }); }
writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 1));

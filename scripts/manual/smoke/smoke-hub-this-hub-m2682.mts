// M-2682: Hub Administration → This Hub, in a real browser on a REAL Hub web listener (createHubHttp behind node:https, the
// s3b rig: scratch DB, fake directory; no fleet runs). The sealed-settings writer is an in-memory stand-in here (the real one,
// with real keys and FleetManager: tests/hub-settings-*-m2682.test.ts). Pictures and checks, 8-case matrix:
//   - the card: name field, Save, Remove name, Hub ID, member key fingerprint (compare groups), issuer key, version;
//   - a long name and a long fingerprint stay inside the card (no sideways scroll), desktop and phone;
//   - Save: one click, a toast, no dialog; a refusal shows its plain sentence; no page error, no CSP report.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-hub-this-hub-m2682.mts
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";

const REPO = process.env.REPO ?? process.cwd(), PW = process.env.PW_DIR ?? REPO;
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", "hub-this-hub-m2682");
mkdirSync(OUT, { recursive: true });
type Case = { device: "desk" | "phone"; theme: "light" | "dark"; lang: "en" | "zh-TW" };
const ALL: Case[] = [];
for (const device of ["desk", "phone"] as const) for (const theme of ["light", "dark"] as const) for (const lang of ["en", "zh-TW"] as const) ALL.push({ device, theme, lang });
const CASES = process.env.MATRIX === "quick" ? [ALL[0]!, ALL[7]!] : ALL;
const r: Record<string, unknown> = {}, fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };

let refuse: string | null = null;
const seen: string[] = [];
const writer = {
  prepare(op: { name: string | null }) { seen.push(`prepare:${op.name}`);
    return { ref: "ref-1", summary: { field: "name", from: "Team Hub", to: op.name }, expiresAt: Date.now() + 300_000 }; },
  commit() { seen.push("commit"); if (refuse) { const { HubSettingsError } = settingsMod; throw new HubSettingsError(refuse); } return { receiptId: "11111111-1111-4111-8111-111111111111", summary: { field: "name", from: "Team Hub", to: "x" } }; },
  recover() {}, pending: () => false,
};
const settingsMod = await import(REPO + "/src/hub/settings-commit.ts");
const { s3bRig } = await import(REPO + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(REPO + "/src/hub/tls.ts");
const port = Number(process.env.HP ?? 48990), origin = `https://127.0.0.1:${port}`;
const INFO = { hubId: "4c3b2a19-0e8f-4d7c-9b6a-5f4e3d2c1b0a", memberSpkiSha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", issuerKeyId: "ed25519-7Qm2xLk9pV4sT8wR1nB6yH3jF5cD0aZe", version: "2.3.5-alpha.9", coexistence: "dedicated" };
const rig = await s3bRig({ webOrigin: origin, hubSettings: { info: INFO, writer } });
const keys = mkdtempSync(join(OUT, ".keys-")); chmodSync(keys, 0o700);
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });

async function open(c: Case) {
  const admin = await rig.signIn("admin");
  const ctx = await browser.newContext({ viewport: c.device === "desk" ? { width: 1366, height: 900 } : { width: 390, height: 844 }, colorScheme: c.theme,
    locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", ignoreHTTPSErrors: true, isMobile: c.device === "phone", hasTouch: c.device === "phone", deviceScaleFactor: 2 });
  const [n, v] = admin.cookie.split("="); await ctx.addCookies([{ name: n, value: v, url: origin, httpOnly: true, secure: true }]);
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_lang", ${JSON.stringify(c.lang)}); localStorage.setItem("agend_theme", ${JSON.stringify(c.theme)}); } catch {}
    window.__csp = []; document.addEventListener("securitypolicyviolation", e => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || "")));` });
  const page = await ctx.newPage(), errs: string[] = [];
  page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  await page.goto(origin + "/ui/hub/admin");
  await page.waitForSelector(".hub-this-facts", { timeout: 15000 });
  return { ctx, page, errs };
}
const CARD = `(() => { const c = document.querySelector(".hub-this-hub"); c.scrollIntoView({ block: "start" }); const b = c.getBoundingClientRect();
  const out = [...c.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > b.right + 1).map((e) => e.tagName + "." + e.className);
  return { text: c.innerText, input: document.querySelector("#hubThisName")?.value, over: out, pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    buttons: [...c.querySelectorAll("button")].map((x) => [x.textContent.trim(), x.disabled, Math.round(x.getBoundingClientRect().height)]) }; })()`;

try {
  for (const c of CASES) {
    const tag = `${c.device}-${c.theme}-${c.lang}`;
    const { ctx, page, errs } = await open(c);
    try {
      const m = await page.evaluate(CARD) as any;
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(OUT, `${tag}-card.png`) });
      const zh = c.lang === "zh-TW";
      check(`${tag}:card`, m.input === "Team Hub" && m.text.includes(INFO.hubId) && m.text.includes("9f86 d081 884c 7d65") && m.text.includes(INFO.issuerKeyId)
        && m.text.includes("2.3.5-alpha.9") && m.text.includes(zh ? "專用：這台電腦只執行 Hub" : "Dedicated: this computer runs only the Hub") && m.text.includes(zh ? "這個 Hub" : "This Hub") && m.text.includes(zh ? "移除名稱" : "Remove name")
        && m.over.length === 0 && m.pageX <= 0 && m.buttons[0][1] === true, m);
      // a long name: stays inside the card; Save enables
      await page.fill("#hubThisName", "Platform Reliability Engineering — Quarterly Architecture Reviews");
      const long = await page.evaluate(CARD) as any;
      check(`${tag}:long-name`, long.over.length === 0 && long.pageX <= 0 && long.buttons[0][1] === false, long);
      if (c.device === "phone") check(`${tag}:tap`, long.buttons.every((b: any[]) => b[2] >= 44), long.buttons);
      await page.screenshot({ path: join(OUT, `${tag}-typed.png`) });
      // a refusal: its plain sentence
      refuse = "stale";
      await page.click(".hub-this-hub button[type=submit]");
      await page.waitForSelector(".hub-this-hub .err", { timeout: 8000 });
      const err = await page.evaluate(`document.querySelector(".hub-this-hub .err").textContent`);
      check(`${tag}:refused`, err === (zh ? "Hub 的設定剛剛有變更。請確認名稱後再儲存一次。" : "The Hub's settings changed meanwhile. Check the name and save again."), err);
      await page.screenshot({ path: join(OUT, `${tag}-refused.png`) });
      // Save: one click → prepare + commit, a toast, no dialog
      refuse = null; seen.length = 0;
      await page.fill("#hubThisName", "Ops Hub");
      await page.click(".hub-this-hub button[type=submit]");
      await page.waitForTimeout(500);
      const toast = await page.evaluate(`[...document.querySelectorAll(".toast, [class*=toast]")].map((e) => e.textContent).join(" ")`) as string;
      const dialogs = await page.evaluate(`document.querySelectorAll("dialog[open]").length`);
      check(`${tag}:saved`, seen.join(",") === "prepare:Ops Hub,commit" && toast.includes(zh ? "已儲存" : "Saved") && dialogs === 0, { seen, toast, dialogs });
      await page.screenshot({ path: join(OUT, `${tag}-saved.png`) });
      const csp = await page.evaluate("window.__csp || []") as string[];
      check(`${tag}:no-errors`, errs.length === 0 && csp.length === 0, { errs, csp });
    } finally { await ctx.close(); }
  }
} catch (e) { fail.push(`exception: ${(e as Error).message}`); r.exception = String((e as Error).stack || e).slice(0, 1500); }
finally {
  await browser.close(); server.closeAllConnections(); await new Promise<void>((res) => server.close(() => res()));
  await rig.close(); rmSync(keys, { recursive: true, force: true });
  writeFileSync(join(OUT, "result.json"), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([, v]) => v !== "PASS")), null, 2));
  console.log(`${Object.keys(r).length} checks; ` + (fail.length ? `FAIL ${fail.length}: ${fail.join(", ")}` : "ALL PASS"));
  process.exit(fail.length ? 1 : 0);
}

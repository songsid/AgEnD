/**
 * M-3127 B browser acceptance: an agent's buttons (its asker only) and polls (everyone) in a Hub group room
 * (docs/design/hub-rooms-reactions-polls-search.md §B).
 * The real Hub listener (tests/helpers/hub-s3b-rig.ts) serves the workspace shell and its modules over HTTPS on loopback;
 * every /hub/v1/* call is answered by the rooms fixture (tests/support/hub-rooms-fixture.ts) — no fleet, CLI or account.
 * Cases: desktop-en-light, desktop-zh-TW-dark, phone-zh-TW-light, phone-en-dark. For each (the fixture's `buttons: true`):
 *   buttons-before — my question's buttons open, 陳主任's shut with 「只有 陳主任 能回答」, the poll with live counts;
 *   buttons-after  — I press mine (chosen, my click posted as a reply) and vote in the poll (mine marked, counts move);
 *   buttons-skew   — BASE_REF's hub-room-thread.js + chat-thread.js (a tab open before the upgrade) while the Hub sends
 *                    `buttons`: drawn as before (no button rows), no page error.
 * Writes PNGs and receipt.json (sourceHead, baseRef, inputs' digests, every check, every PNG's sha256) to OUT.
 *   PW_DIR=<playwright-core root> REPO=$PWD OUT=<dir> [BASE_REF=origin/release/2.3.5-alpha] npx tsx scripts/manual/hub-rooms/buttons.mts
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const repo = resolve(process.env.REPO ?? "."), out = resolve(process.env.OUT ?? join(repo, ".artifacts/hub-rooms-buttons"));
const base = process.env.BASE_REF ?? "origin/release/2.3.5-alpha";
mkdirSync(out, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-c", "gc.auto=0", "-C", repo, ...a], { encoding: "utf8" }).trim();
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
const { createHubRoomsFixture, FIXTURE_ME } = await import(repo + "/tests/support/hub-rooms-fixture.ts");

const keys = mkdtempSync(join(out, ".keys-")), port = 49600 + Math.floor(Math.random() * 200), origin = `https://127.0.0.1:${port}`;
const r = await s3bRig({ webOrigin: origin });
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!r.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>(done => server.listen(port, "127.0.0.1", done));

const SKEW_FILES: Record<string, string> = { "**/ui/js/hub-room-thread.js": "src/ui/hub-room-thread.js", "**/assets/chat-thread.js": "src/ui/shared/chat-thread.js" };
const baseOf = (path: string) => git("show", `${base}:${path}`);
const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core");
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const INPUTS = ["src/ui/hub-room-thread.js", "src/ui/shared/chat-thread.js", "src/ui/hub-button-actions.js", "src/ui/hub-room-strings.js", "src/ui/hub-client.js", "src/ui/shared/hub-rooms-u2.css", "tests/support/hub-rooms-fixture.ts"];
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), baseRef: git("rev-parse", base), dirty: git("status", "--porcelain", "--", "src", "tests").split("\n").filter(Boolean),
  inputs: [...Object.values(SKEW_FILES).map(p => ({ path: p, base: sha(baseOf(p)) })), ...INPUTS.map(p => ({ path: p, sha256: sha(readFileSync(join(repo, p))) }))], checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const cases = [["desktop", "en", "light"], ["desktop", "zh-TW", "dark"], ["phone", "zh-TW", "light"], ["phone", "en", "dark"]];
const VIEW: Record<string, { width: number; height: number }> = { desktop: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } };

async function open(variant: "after" | "skew", [device, lang, theme]: string[]) {
  const fx = createHubRoomsFixture({ buttons: true });
  const ctx = await browser.newContext({ viewport: VIEW[device], colorScheme: theme, ignoreHTTPSErrors: true, locale: lang === "en" ? "en-US" : "zh-TW", isMobile: device === "phone", hasTouch: device === "phone" });
  await ctx.addInitScript(() => { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); });
  await ctx.route("**/hub/v1/**", async (q: any) => {
    const req = q.request(), u = new URL(req.url()), path = u.pathname + u.search;
    if (u.pathname.endsWith("/events")) return q.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "retry: 600000\n\n" });
    const raw = req.postData(), answer = fx.handle({ method: req.method(), path, headers: req.headers(), body: raw ? JSON.parse(raw) : undefined });
    return q.fulfill({ status: answer?.status ?? 200, contentType: "application/json", body: JSON.stringify(answer?.body ?? {}) });
  });
  if (variant === "skew") for (const [glob, path] of Object.entries(SKEW_FILES)) await ctx.route(glob, (q: any) => q.fulfill({ status: 200, contentType: "text/javascript", body: baseOf(path) }));
  const p = await ctx.newPage(), errors: string[] = [];
  p.on("pageerror", (e: Error) => errors.push(e.message));
  p.on("console", (m: any) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  if (lang !== "en") await p.addInitScript(() => localStorage.setItem("agend_lang", "zh-TW"));
  await p.goto(`${origin}/ui/hub?room=room-weekly`);
  await p.waitForFunction(() => document.querySelectorAll(".hub-room-page .thread .msg").length > 5, undefined, { timeout: 15000 });
  await p.waitForTimeout(500);
  return { ctx, p, errors };
}
const shotPage = async (p: any, name: string) => { const file = join(out, name); await p.screenshot({ path: file }); receipt.pictures.push({ path: name, sha256: sha(readFileSync(file)) }); };
/** The answer (a message with a button row) whose words include `text`: each button "label(off)" and the row's note. */
const rowOf = (p: any, text: string) => p.evaluate((key: string) => {
  const node = [...document.querySelectorAll(".hub-room-page .thread .msg[data-key]")].find((n) => n.querySelector(".rb-row") && n.querySelector(".md")?.textContent?.includes(key));
  return node ? { buttons: [...node.querySelectorAll(".rb-row .rb-btn")].map((b) => `${b.textContent}${(b as HTMLButtonElement).disabled ? "(off)" : ""}`), note: node.querySelector(".rb-note")?.textContent ?? "" } : null;
}, text);
const answer = (p: any, text: string) => p.locator(".hub-room-page .thread .msg[data-key]", { has: p.locator(".rb-row") }).filter({ has: p.locator(".md", { hasText: text }) }).first();

try {
  for (const c of cases) {
    const tag = c.join("-");
    {
      const { ctx, p, errors } = await open("after", c);
      const mine = await rowOf(p, "要先送審"), theirs = await rowOf(p, "請選規格版本"), poll = await rowOf(p, "週會改哪天");
      check(`${tag} before: my buttons open, 陳主任's shut and say whose, the poll's live counts; no page error`,
        mine?.buttons.join("|") === "先送審|下週一起" && theirs?.buttons.every((x: string) => x.endsWith("(off)")) && /陳主任/.test(theirs?.note ?? "")
          && poll?.buttons.join("|") === "週三 · 1|週四 · 0|週五 · 0" && errors.length === 0, { mine, theirs, poll, errors });
      await answer(p, "請選規格版本").scrollIntoViewIfNeeded();
      await shotPage(p, `buttons-before.${tag}.png`);
      await answer(p, "要先送審").locator(".rb-btn").first().click(); await p.waitForTimeout(400);
      await answer(p, "週會改哪天").locator(".rb-btn").nth(1).click(); await p.waitForTimeout(400);
      const chosen = await rowOf(p, "要先送審"), voted = await rowOf(p, "週會改哪天");
      const click = await p.evaluate(() => { const last = [...document.querySelectorAll(".hub-room-page .thread .msg.user")].at(-1);
        return last ? { text: last.querySelector(".md")?.textContent, quote: last.querySelector(".msg-quote")?.textContent ?? "" } : null; });
      check(`${tag} after: mine chosen (✓, shut, by me), my click posted replying to it; my vote marked, the counts moved; no page error`,
        chosen?.buttons[0]?.startsWith("✓ 先送審") && chosen.buttons.every((x: string) => x.endsWith("(off)")) && click?.text === "先送審" && /要先送審/.test(click.quote)
          && voted?.buttons.join("|") === "週三 · 1|✓ 週四 · 1|週五 · 0" && errors.length === 0, { chosen, click, voted, errors });
      await answer(p, "週會改哪天").scrollIntoViewIfNeeded();
      await shotPage(p, `buttons-after.${tag}.png`);
      await ctx.close();
    }
    {
      const { ctx, p, errors } = await open("skew", c);
      const rows = await p.locator(".hub-room-page .thread .rb-row").count();
      check(`${tag} skew: BASE_REF's thread draws the room as before (no button rows) while the Hub sends buttons; no page error`, rows === 0 && errors.length === 0, { rows, errors });
      await shotPage(p, `buttons-skew.${tag}.png`);
      await ctx.close();
    }
  }
} finally {
  receipt.passed = receipt.checks.every((x: any) => x.ok);
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  await browser.close(); server.close(); await r.close();
}
console.log(receipt.passed ? "ALL PASS" : "SOME FAILED");
process.exit(receipt.passed ? 0 : 1);

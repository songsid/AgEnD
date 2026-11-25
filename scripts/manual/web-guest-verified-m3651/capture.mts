// M-3651 real-app captures: a guest's session menu — signed in with the private /web code (verified as its account:
// "Guest · Verified until …"), and a guest that is not verified ("Guest", as before). Real web HTTP, sessions and DOM
// (scripts/manual/smoke-fixture), inert agents, a synthetic guest account; headless Linux only. The verified guest is made
// by the same call auth-api makes after a private code's sign-in (FleetManager.authorizeSignedInSession); the DM it then
// tries has no chat connection here (the fixture has none), which is fine: the notice is covered by the unit test.
//   REPO=<checkout> PW_DIR=<dir with playwright-core> OUT=<dir> npx tsx scripts/manual/web-guest-verified-m3651/capture.mts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const smoke = "web-guest-verified-m3651", OUT = process.env.OUT!, REPO = process.env.REPO!;
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const fx = await bootFixture({ port: 0, classic: false, webYaml: "  guests:\n    enabled: true", roster: [
  { name: "agent-alpha", displayName: "Atlas", backend: "codex" }, { name: "agent-beta", displayName: "Beacon", backend: "claude-code" },
] });
const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
const owner = { adapterId: "discord", userId: "900000000000000099" }, person = `person:${owner.adapterId}:${owner.userId}`;
fx.fm.guestScope = () => new Set(["agent-alpha", "agent-beta"]);
try {
  for (const [device, lang, theme] of [["desk", "en", "light"], ["desk", "zh-TW", "dark"], ["phone", "en", "light"], ["phone", "zh-TW", "dark"]] as const) {
    for (const verified of [true, false]) {
      const phone = device === "phone", tag = `${device}-${lang}-${theme}`, name = verified ? "guest-verified" : "guest-not-verified";
      fx.fm.webPrefs.forgetGuest(person); fx.fm.webPrefs.writeForGuest(person, new Map<string, unknown>([["theme", theme], ["lang", lang]]));
      const { sessionId, record } = fx.fm.webSessions.create({ tier: "guest", surface: "local", label: "Firefox on Linux", tokenEpoch: tokenEpoch(fx.fm.webToken), owner });
      if (verified) fx.fm.authorizeSignedInSession(record, "loopback", false);
      const kind = fx.fm.webAuthority({ session: fx.fm.webSessions.findByHandle(record.handle), gateway: false, peer: "loopback" }).authority.kind;
      check(`${tag} ${name}: its messages would carry ${verified ? "web-guest" : "none"}, never web-verified`, kind === (verified ? "web-guest" : "none"), kind);
      const ctx = await fx.browser.newContext({ viewport: VIEWPORTS[device], colorScheme: theme, hasTouch: phone, isMobile: phone, locale: lang === "zh-TW" ? "zh-TW" : "en-US" });
      await ctx.addCookies([{ name: "agend_session", value: sessionId, url: fx.base }]);
      await ctx.addInitScript({ content: 'window.__name = f => f; localStorage.setItem("agend_tour_done","1"); localStorage.setItem("agend_firstrun_dismissed","1");' });
      const page = await ctx.newPage(), errors: string[] = [];
      page.on("pageerror", (e: any) => errors.push(String(e)));
      try {
        await page.goto(fx.base + "/ui/chat/agent-alpha"); await page.locator("#filterInput").waitFor({ state: "attached" });
        if (phone && !(await page.locator(".shell").evaluate((e: Element) => e.classList.contains("sb-open")))) await page.locator("#sbOpen").tap();
        const me = await page.evaluate(async () => (await fetch("/auth/session", { credentials: "same-origin" })).json());
        check(`${tag} ${name}: /auth/session says ${verified ? "until when" : "not verified"}`, me.tier === "guest" && (verified ? typeof me.verifiedUntil === "number" : me.verifiedUntil === null), me);
        await page.locator(".session > .side-row").click();
        const role = page.locator(".session .pop .role strong");
        await role.waitFor({ state: "visible" });
        const text = (await role.innerText()).trim();
        const want = verified ? (lang === "en" ? /^Guest · Verified until \d/ : /^訪客 · 驗證有效至 /) : (lang === "en" ? /^Guest$/ : /^訪客$/);
        check(`${tag} ${name}: the session menu's role reads "${text}"`, want.test(text), text);
        const tops = await page.locator(".session .pop .role").evaluate((r: Element) => [r.querySelector(".sub")!.getBoundingClientRect().top, r.querySelector("strong")!.getBoundingClientRect().top]);
        check(`${tag} ${name}: the role starts beside its label (never under a lone "Role")`, Math.abs(tops[0]! - tops[1]!) < 6, tops);
                if (verified) {
          // The time is one unit: it never splits across lines (09:16 / AM).
          const lines = await role.evaluate((el: Element) => { const r = document.createRange(); r.selectNodeContents(el); return [...r.getClientRects()].map(b => Math.round(b.top)); });
          const time = await role.evaluate((el: Element) => { const t = el.textContent!; const at = t.search(/\d/); const r = document.createRange(); const n = el.firstChild!; r.setStart(n, at); r.setEnd(n, t.length); return [...new Set([...r.getClientRects()].map(b => Math.round(b.top)))].length; });
          check(`${tag} ${name}: the time stays on one line (${new Set(lines).size} line(s) in all)`, time === 1, { time, lines });
        }
                check(`${tag} ${name}: no Authorize line for a guest`, (await page.locator(".session .pop .webauth-chip").count()) === 0);
        check(`${tag} ${name}: no page errors`, errors.length === 0, errors);
        const path = shotPath(smoke, tag, name);
        await page.screenshot({ path });
        receipt.pictures.push({ path: path.split("/").slice(-2).join("/"), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
      } finally { await ctx.close(); fx.fm.webSessions.revokeAll((r: any) => r.handle === record.handle); }
    }
  }
} finally {
  await fx.close();
  const failed = receipt.checks.filter((c: any) => !c.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, smoke, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}

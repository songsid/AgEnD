// #3212 PR 4 acceptance (offline part): Codex and Kiro named accounts sign in from Settings → Accounts, on the realistic
// fixture (never `fleet start`). SAFETY: refuses to run unless HOME is a scratch directory and the process has no outside
// network (run it inside `unshare -rn` with loopback up) — no vendor is contacted, no account is involved, and the
// sign-in is never started: the dialog's own pre-check (the real `codex login status` / `kiro-cli whoami` with the
// profile's CODEX_HOME / XDG_DATA_HOME) runs, and the run stops at the confirmation.
// - desk light (en) and phone dark (zh-TW): + Add account on the Codex card ("team") and the Kiro card ("k1"): Sign in
//   opens at once — the same dialog as Claude Code's — and asks to sign in that account (its pre-check found it signed
//   out); before PR 4 these rows only showed a host command. The profile folders hold nothing else after the pre-check
//   than what the CLIs wrote there; the host's own ~/.codex and ~/.local/share/kiro-cli are never used (HOME is scratch).
// No page error, no CSP report, no raw string key.
//   unshare -rn sh -c 'ip link set lo up && exec env HOME=<scratch> PLAYWRIGHT_BROWSERS_PATH=… PATH="$PATH" PW_DIR=… \
//     REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-accounts-profile-signin-3212.mts'
import { createConnection } from "node:net";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const home = process.env.HOME ?? "";
if (!home.startsWith(tmpdir()) && !home.includes("/scratchpad/")) { console.error(`refusing: HOME (${home}) is not a scratch directory`); process.exit(2); }
for (const v of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME"]) if (process.env[v]) { console.error(`refusing: ${v} is set`); process.exit(2); }
const reachable = await new Promise<boolean>((resolve) => {
  const s = createConnection({ host: "1.1.1.1", port: 443, timeout: 3000 }, () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false)); s.on("timeout", () => { s.destroy(); resolve(false); });
});
if (reachable) { console.error("refusing: the outside network is reachable — run inside `unshare -rn` with loopback up"); process.exit(2); }

const { bootFixture, shotPath } = await import("../smoke-fixture/index.mts");
const SMOKE = "smoke-accounts-profile-signin-3212";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48760), instances: 2 });
const fm = fx.fm as any;
fm.refreshSignInIdentities = () => {};
const r: Record<string, unknown> = { browser: fx.browser.version(), network: "blocked", home: "scratch" };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const W = { en: { add: "Add" }, "zh-TW": { add: "新增" } } as const;

try {
  for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
    const tag = `${c.device}-${c.theme}-${c.lang}`;
    const { ctx, page, csp } = await fx.page(c as any, { path: "/settings/agents" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.waitForSelector(".s-ai-accounts", { timeout: 20000 });
    await page.evaluate(`(() => { const d = document.querySelector("details.s-ai-accounts"); if (d && !d.open) d.querySelector("summary").click(); })()`);
    await page.waitForSelector(".s-account-card", { timeout: 15000 });
    const got: Record<string, unknown> = {};
    for (const [cli, name] of [["codex", `team-${c.device}`], ["kiro-cli", `k1-${c.device}`]] as const) {
      const cardSel = `.s-account-card[data-backend="${cli}"]`;
      const present = await page.$(cardSel);
      if (!present) { got[cli] = "no card (CLI not installed on this host)"; continue; }
      await page.click(`${cardSel} .s-account-add`);
      await page.waitForSelector("#acctAddName", { timeout: 5000 });
      await page.fill("#acctAddName", name);
      await page.evaluate(`[...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent.trim() === ${JSON.stringify(W[c.lang].add)}).click()`);
      // Sign in opens and its pre-check (the real CLI, offline, the profile's own variable) answers with the confirmation.
      const asked = await page.waitForFunction((n: string) => {
        const d = document.querySelector("dialog[open]");
        return !!d && !document.querySelector("#acctAddName") && d.textContent!.includes(n) && !!d.querySelector("button.btn-primary");
      }, name, { timeout: 30000 }).then(() => true, () => false);
      const text = await page.evaluate(`document.querySelector("dialog[open]")?.innerText || ""`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: shotPath(SMOKE, tag, `${cli}-sign-in-asks`) });
      got[cli] = { asked, hostCommandShown: /CODEX_HOME=|XDG_DATA_HOME=/.test(text), text: text.slice(0, 240) };
      await page.keyboard.press("Escape"); await page.waitForTimeout(500);
      await page.evaluate(`(() => { const d = document.querySelector("dialog[open]"); if (d) { const b = [...d.querySelectorAll("button")].find((x) => /Cancel|Close|取消|關閉/.test(x.textContent)); if (b) b.click(); } })()`);
      await page.waitForTimeout(400);
    }
    const body = await page.evaluate("document.body.innerText");
    const ok = (x: any) => x === "no card (CLI not installed on this host)" || (x && x.asked && !x.hostCommandShown);
    check(tag, ok(got.codex) && ok(got["kiro-cli"]) && !/\baccounts(Manage)?\.[a-zA-Z_]+\b/.test(body) && errs.length === 0 && (await csp()).length === 0, { ...got, errs, csp: await csp() });
    await ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  writeFileSync(shotPath(SMOKE, "result", "json").replace(/\.png$/, ".json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}

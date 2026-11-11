/** #3415 display acceptance in the real Settings shell. HTTP view fixtures are explicit; transport/restore is tested separately. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const repo = resolve(process.env.REPO ?? process.cwd()), out = resolve(process.env.OUT ?? join(repo, ".artifacts/hub-member-restore-3415/browser"));
mkdirSync(out, { recursive: true });
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const base = "9a351611bea1363ce7248c5954876b9c2e6685de";
const inputs = ["scripts/manual/hub-member-recovery-3415.mts", "scripts/manual/smoke-fixture/index.mts", "src/ui/app.html", "src/ui/settings-hub.js", "src/ui/hub-strings.js", "src/ui/hub-client.js", "src/ui/settings-hub-connection.js", "src/ui/shared/app.css", "src/ui/shared/hub.css"];
const inputDigests = () => Object.fromEntries(inputs.map(p => [p, digest(readFileSync(join(repo, p)))]));
const initial = inputDigests(), head = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}"), dirty = git("status", "--porcelain", "--untracked-files=no");
if (dirty) throw Error("capture requires committed source and harness");
const scratch = mkdtempSync(join(out, "owned-")), bin = join(scratch, "bin"); mkdirSync(bin);
const previousPath = process.env.PATH;
for (const name of ["tmux", "agend", "claude", "codex", "kiro-cli"]) writeFileSync(join(bin, name), `#!${process.execPath}\nprocess.exit(97)\n`, { mode: 0o755 });
process.env.AGEND_TMUX_BIN = join(bin, "tmux"); process.env.PATH = [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DISCORD_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"]) delete process.env[key];
const { bootFixture, matrix, caseName } = await import("./smoke-fixture/index.mts");
const hubId = "11111111-2222-4333-8444-555555555555", binding = "b".repeat(64), memberOrigin = "https://hub.example.test";
const held = (hold = "rejected") => ({ state: "held", hold, binding, hubId, memberOrigin });
const offline = { state: "paired", link: "offline", binding, hub: { hubId, memberOrigin, webOrigin: memberOrigin, name: "Example Hub", fingerprint: { kind: "hub-key", digest: "a".repeat(64) } } };
const receipt: any = { head, tree, dirty: false, base, inputs: initial, scope: "Real app.html, Settings navigation, current shared CSS, cookie sign-in and browser. Explicit view/step HTTP fixtures only; no restored backend or authorization claim from these screenshots. Real SQLite/TLS restore/re-pair is a separate automated test.", checks: [], assets: {}, cases: [], cleaned: false };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(!ok ? { detail } : {}) }); if (!ok) throw Error(name + " " + JSON.stringify(detail ?? "")); };
let fx: any;
try {
  fx = await bootFixture({ port: Number(process.env.PORT ?? 54930), instances: 1, classic: false });
  let lifecycle = 0;
  for (const method of ["startInstance", "startInstanceUnattended", "restartInstance", "restartFleet", "stopInstance"]) fx.fm[method] = async () => { lifecycle++; throw Error("native lifecycle forbidden"); };
  // This display rig never loads a Hub/member runtime. Only the server-rendered member affordance is needed.
  fx.fm.rawFleetConfig.hub_member = { enabled: true };
  const cases = matrix();
  for (const c of cases) {
    const modes = ["before", "rejected", "offline", "revoked", ...(caseName(c) === "phone-dark-zh-TW" ? ["old-strings", "old-client", "old-ui", "old-css"] : [])];
    for (const mode of modes) {
      let projection: any = mode === "before" || mode === "offline" ? offline : held(mode === "revoked" ? "revoked" : "rejected");
      const { ctx, page, csp } = await fx.page(c);
      const errors: string[] = [], writes: any[] = [], responses: Promise<void>[] = [];
      await ctx.addInitScript({content: "window.__name=fn=>fn;"});
      page.on("response", (response: any) => { const u = new URL(response.url()); if (u.pathname === "/settings/hub" || ["settings-hub.js", "hub-strings.js", "hub-client.js", "app.css", "hub.css"].some(n => u.pathname.endsWith("/" + n))) responses.push(response.body().then((body: Buffer) => { receipt.assets[caseName(c) + ":" + mode + ":" + u.pathname] = { status: response.status(), digest: digest(body) }; })); });
      page.on("pageerror", (e: Error) => errors.push(e.message));
      await ctx.route("**/*", async (route: any) => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== fx.base) return route.abort();
        const filename = url.pathname.split("/").pop();
        const old = mode === "before" && ["settings-hub.js", "hub-strings.js"].includes(filename!)
          || mode === "old-strings" && filename === "hub-strings.js"
          || mode === "old-client" && filename === "hub-client.js"
          || mode === "old-ui" && filename === "settings-hub.js"
          || mode === "old-css" && filename === "app.css";
        if (old) {
          const source = `src/ui/${filename === "app.css" ? "shared/" : ""}${filename}`;
          const body = execFileSync("git", ["show", `${base}:${source}`], { cwd: repo });
          receipt.assets[mode + ":" + source] = { revision: base, digest: digest(body) };
          return route.fulfill({ contentType: filename!.endsWith(".css") ? "text/css" : "text/javascript", body });
        }
        if (url.pathname === "/api/settings/hub/membership") return route.fulfill({ json: { ok: true, enabled: true, connectionCardV1: true, pairing: projection } });
        if (url.pathname === "/api/hub/member/pairing") return route.fulfill({ json: { pairing: projection, notices: [] } });
        if (url.pathname === "/api/hub/member/exposures") return route.fulfill({ json: { exposures: [] } });
        if (url.pathname === "/api/hub/member/pairing/disconnect") {
          writes.push({ path: url.pathname, body: request.postDataJSON() }); projection = held("disconnected");
          return route.fulfill({ json: { ok: true, remote: "pending" } });
        }
        if (url.pathname === "/api/hub/member/pairing/cancel") { writes.push({ path: url.pathname }); projection = { state: "unpaired" }; return route.fulfill({ json: { pairing: projection } }); }
        if (url.pathname.startsWith("/api/hub/") && request.method() !== "GET") throw Error("unexpected Hub write " + url.pathname);
        return route.continue();
      });
      try {
        await page.goto(fx.base + "/settings/hub");
        await page.locator("#hub-connect").waitFor();
        if (["before", "offline"].includes(mode)) await page.locator(".hub-connection-settings").waitFor();
        else await page.locator(".hub-held").waitFor();
        await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))); });
        const tag = caseName(c) + "-" + mode;
        check(tag + " real Settings shell", await page.locator(".s-nav .seg-item.active").textContent() === "Hub");
        const text = await page.locator("#hub-connect").innerText();
        if (mode === "before") check(tag + " reproduces absent recovery", await page.locator(".hub-repair").count() === 0);
        else if (mode === "old-ui") check(tag + " old UI generic hold", !text.includes("hold_rejected") && await page.locator(".hub-repair").count() === 0);
        else {
          check(tag + " Pair again", await page.locator(".hub-repair").count() === 1);
          check(tag + " reason", mode === "old-strings" ? text.includes("拒絕") : text.includes(c.lang === "zh-TW" ? mode === "revoked" ? "撤銷" : "還原" : mode === "revoked" ? "revoked" : "restored"));
        }
        check(tag + " passive", writes.length === 0);
        const geometry = await page.locator("#hub-connect").evaluate((card: HTMLElement) => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1,
          taps: [...card.querySelectorAll("button")].filter((e: any) => e.offsetParent !== null && !e.disabled).map(e => { const r = e.getBoundingClientRect(); return { text: e.textContent, w: r.width, h: r.height }; }) }));
        check(tag + " no overflow", !geometry.overflow, geometry);
        if (c.device === "phone" && mode !== "before") check(tag + " tap", geometry.taps.every((t: any) => Math.min(t.w, t.h) >= 43.5), geometry);
        await page.screenshot({ path: join(out, tag + ".png"), fullPage: true });
        if (mode === "rejected" && c.theme === "light" && c.device === "phone") {
          await page.locator(".hub-repair").click();
          await page.locator("dialog[open],.dialog-overlay").first().waitFor();
          check(tag + " dialog before write", writes.length === 0);
          await page.screenshot({ path: join(out, tag + "-confirm.png"), fullPage: true });
          await page.getByRole("button", { name: c.lang === "zh-TW" ? "中斷連線" : "Disconnect", exact: true }).click();
          await page.getByRole("button", { name: c.lang === "zh-TW" ? "重新開始" : "Start over", exact: true }).waitFor();
          check(tag + " existing exact disconnect", writes.length === 1 && writes[0].body.hubId === hubId && writes[0].body.binding === binding, writes);
          await page.getByRole("button", { name: c.lang === "zh-TW" ? "重新開始" : "Start over", exact: true }).click();
          await page.locator("form.hub-connect").waitFor();
          check(tag + " existing cancel", writes.length === 2 && writes[1].path.endsWith("/cancel"), writes);
          await page.screenshot({ path: join(out, tag + "-ready-to-pair.png"), fullPage: true });
        }
        check(tag + " no script errors", errors.length === 0, errors); check(tag + " CSP", (await csp()).length === 0);
        await Promise.all(responses); receipt.cases.push({ tag, geometry, writes });
      } finally { await ctx.close(); }
    }
  }
  check("no native lifecycle", lifecycle === 0); check("source unchanged during capture", JSON.stringify(initial) === JSON.stringify(inputDigests()));
  check("pinned tree unchanged", head === git("rev-parse", "HEAD") && tree === git("rev-parse", "HEAD^{tree}") && git("status", "--porcelain", "--untracked-files=no") === "");
  receipt.status = "PASS";
} catch (e: any) { receipt.status = "FAIL"; receipt.error = e.stack; throw e; }
finally { await fx?.close(); process.env.PATH = previousPath; rmSync(scratch, { recursive: true, force: true }); receipt.cleaned = true; writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); }
console.log(JSON.stringify({ status: receipt.status, cases: receipt.cases.length, checks: receipt.checks.length, cleaned: receipt.cleaned }));
process.exit(0);

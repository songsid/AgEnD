// Prism L1 (leader cid-1793860308012-pgydlr): "Not me" whose sign-out could not be saved, against a real browser tab that
// is open on that session (the stale tab). The fixture's FleetManager (never `fleet start`), the fleet's own Not me
// dependency (sessionAuthorizationRequests' signOut, the one a card's tap runs), and the stores' file operations refused
// in memory (inert EACCES — no host permission is touched):
// - both the rewrite and the removal refused: the dependency reports not durable (the card then says a restart may
//   bring the session back), and the files a restart would read still hold the session;
// - only the rewrite refused: durable (the old files removed — nothing can come back);
// - either way the open tab is signed out at its next request (the session-ended banner), and a reload is the sign-in
//   page; no page errors.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-not-me-not-saved.mts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48570), instances: 3, classic: false });
const r: Record<string, unknown> = {};
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const fm = fx.fm as any;
const eacces = () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); };
const sessionsFile = join(fm.dataDir, "web-sessions.json"), authFile = join(fm.dataDir, "web-authorizations.json");

async function run(name: string, unlinkToo: boolean) {
  const { ctx, page } = await fx.page({ device: "desk", theme: "dark", lang: "en" } as any, { path: "/ui" });
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  await page.waitForTimeout(1500);
  // The session this tab holds (the newest), and an authorization for it as a Confirm would leave.
  const record = [...fm.webSessions.byHash.values()].sort((a: any, b: any) => b.created - a.created)[0];
  fm.sessionAuthorizationStore().authorize(record.handle, { adapterId: "owner", userId: "admin" }, Date.now(), fm.webAuthorityState().epoch, Date.now() + 3_600_000, "loopback");
  const ops = fm.webSessions.ops, auth = fm.sessionAuthorizationStore(), io = auth.io;
  fm.webSessions.ops = { ...ops, writeFileSync: eacces, ...(unlinkToo ? { unlinkSync: eacces } : {}) };
  auth.io = { ...io, write: eacces, ...(unlinkToo ? { unlink: eacces } : {}) };
  let out: unknown;
  try { out = fm.sessionAuthorizationRequests().deps.signOut(record.handle); }
  finally { fm.webSessions.ops = ops; auth.io = io; }
  const files = { sessions: existsSync(sessionsFile) && readFileSync(sessionsFile, "utf8").includes(record.handle), authorizations: existsSync(authFile) && readFileSync(authFile, "utf8").includes(record.handle) };
  // The open tab: its next request is refused — the session-ended banner; a reload is the sign-in page.
  await page.evaluate(`fetch("/ui/authorization").catch(() => null)`);
  const banner = await page.waitForSelector('[data-trust="session-ended"]', { timeout: 10000 }).then(() => true, () => false);
  await page.screenshot({ path: shotPath("not-me-not-saved", name, "tab") });
  await page.reload(); await page.waitForTimeout(1200);
  const signin = new URL(page.url()).pathname === "/signin" || !!(await page.$("#code"));
  r[name] = { out, files, banner, signin, errs };
  await ctx.close();
  return { out: out as { durable: boolean; authorizationDurable: boolean }, files, banner, signin, errs };
}

try {
  const both = await run("write-and-removal-refused", true);
  check("double-failure-reported", both.out.durable === false && both.out.authorizationDurable === false && both.files.sessions && both.files.authorizations, both);
  check("double-failure-tab-signed-out", both.banner && both.signin && both.errs.length === 0, both);
  const one = await run("only-write-refused", false);
  check("write-only-durable", one.out.durable === true && one.out.authorizationDurable === true && !one.files.sessions && !one.files.authorizations, one);
  check("write-only-tab-signed-out", one.banner && one.signin && one.errs.length === 0, one);
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  writeFileSync(shotPath("not-me-not-saved", "result", "json").replace(/\.png$/, ".json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}

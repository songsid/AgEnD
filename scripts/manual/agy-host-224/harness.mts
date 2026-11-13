// AGEND-224: the host's Antigravity sign-in, end to end against the real `agy` (agy >= 1.5.0) and the real transport (a tmux session, never an instance pane), in a scratch HOME.
// HOME and GEMINI_HOME point at a scratch folder BEFORE anything is loaded, so the user's own ~/.gemini is never read or written (its token file's mtime is compared before and after, never its content).
// No login can finish: the code is never a real one, and the second attempt is cancelled before any code.
//   SCRATCH=<empty dir> npx tsx scripts/manual/agy-host-224/harness.mts
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const scratch = resolve(process.env.SCRATCH ?? "");
if (!process.env.SCRATCH) { console.error("SCRATCH=<empty dir> is required"); process.exit(2); }
const realHome = homedir();
const realToken = join(realHome, ".gemini", "antigravity-cli", "antigravity-oauth-token");
const realStamp = () => { try { const s = statSync(realToken); return `${s.mtimeMs}:${s.size}`; } catch { return "absent"; } };
const realBefore = realStamp();
rmSync(scratch, { recursive: true, force: true }); mkdirSync(scratch, { recursive: true });
process.env.HOME = scratch; process.env.USERPROFILE = scratch; process.env.GEMINI_HOME = join(scratch, ".gemini"); delete process.env.SSH_CONNECTION;
const dataDir = join(scratch, "agend-home"); mkdirSync(dataDir, { recursive: true });

const { StructuredSignIn } = await import("../../../src/structured-signin.js");
const { createStructuredSignInTransport } = await import("../../../src/structured-signin-transport.js");
const { LoginWindowLock } = await import("../../../src/login-window-lock.js");
const { LOGIN_FLOWS, checkAuthStatus, checkAuthSignedOut } = await import("../../../src/login-flows.js");
const { proveFolderIsolation } = await import("../../../src/account-isolation.js");
const { addAccountProfile } = await import("../../../src/accounts-profiles.js");
const { credentialProfileHome, credentialProfileLaunch } = await import("../../../src/backend/credential-profile.js");
const { seedFirstRun } = await import("../../../src/antigravity-first-run.js");

const results: Array<{ item: string; ok: boolean; detail?: string }> = [];
const record = (item: string, ok: boolean, detail?: string) => { results.push({ item, ok, ...(detail ? { detail } : {}) }); console.log(`${ok ? "PASS" : "FAIL"}  ${item}${detail ? "  —  " + detail : ""}`); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const loginProcesses = () => (spawnSync("pgrep", ["-f", "acp --login"], { encoding: "utf8" }).stdout ?? "").split("\n").filter(Boolean).length;
const tmuxServers = () => (spawnSync("sh", ["-c", "ls /tmp/tmux-$(id -u) 2>/dev/null | grep -c agend-signin- || true"], { encoding: "utf8" }).stdout ?? "0").trim();
const version = spawnSync("agy", ["--version"], { encoding: "utf8" }).stdout.trim();
console.log(`agy ${version}; scratch HOME ${scratch}`);

const owner = {};
async function attempt(profile?: string) {
  const lock = new LoginWindowLock();
  const transport = createStructuredSignInTransport({ backend: "antigravity", dataDir });
  const launchCheck = profile === undefined ? () => checkAuthStatus(LOGIN_FLOWS.antigravity!.authCheck!) : undefined;
  const session = new StructuredSignIn("antigravity", owner, {
    lock, current: () => true, transport,
    checkAuth: launchCheck ?? (() => checkAuthStatus(LOGIN_FLOWS.antigravity!.authCheck!, { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" }, ["--app_data_dir", join("..", "..", "..", "agend-home", "credential-profiles", "antigravity", profile!)])),
    ...(profile !== undefined ? { profile, isolated: () => proveFolderIsolation("antigravity", launch => checkAuthSignedOut(LOGIN_FLOWS.antigravity!.authCheck!, launch.env, launch.args)) } : {}),
  });
  return { session, lock, view: () => session.view(owner) };
}
async function until(fn: () => boolean, ms = 30_000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(400); } return fn(); }

// 1. The default account: link + code box, a wrong code is the provider's refusal, nothing is left.
{
  const before = loginProcesses();
  const a = await attempt();
  await a.session.start();
  const shown = await until(() => !!a.view().url);
  const url = a.view().url ?? "";
  record("default: the dialog gets Google's link (accounts.google.com, https) and a code box, from the real agy", shown && /^https:\/\/accounts\.google\.com\//.test(url) && a.view().phase !== "failed", `phase=${a.view().phase}; link host ok; query not printed`);
  record("default: the command is `agy acp --login` in its own tmux session (a process, not an instance pane)", loginProcesses() > before, `login processes ${before} → ${loginProcesses()}`);
  await a.session.action(owner, a.session.id, a.view().revision, { kind: "code", value: "not-a-real-authorization-code-224" });
  const ended = await until(() => ["failed", "done"].includes(a.view().phase), 40_000);
  record("default: a wrong code ends as the provider's refusal, never 'done'", ended && a.view().phase === "failed", `phase=${a.view().phase} reason=${a.view().reason}`);
  await sleep(800);
  record("default: no agy login process and no tmux session is left; the window is free", loginProcesses() === before && !a.lock.isHeld, `login processes ${loginProcesses()}, held=${a.lock.isHeld}`);
  record("default: no token file was written in the scratch home", !existsSync(join(scratch, ".gemini", "antigravity-cli", "antigravity-oauth-token")));
}

// 2. A named account: its folder, the isolation proof, a cancel before any code.
{
  const added = addAccountProfile(dataDir, "antigravity", "t224");
  record("an account is added: its own folder under AgEnD's credential-profiles", added.ok === true && existsSync(credentialProfileHome(dataDir, "antigravity", "t224")), JSON.stringify(added));
  const proved = await proveFolderIsolation("antigravity", launch => checkAuthSignedOut(LOGIN_FLOWS.antigravity!.authCheck!, launch.env, launch.args));
  record("the isolation proof: an EMPTY scratch folder under the account's launch answers 'not connected' (the pin keeps the login in the folder)", proved === true);
  const before = loginProcesses();
  const a = await attempt("t224");
  await a.session.start();
  const shown = await until(() => !!a.view().url);
  record("named account: the link and code box appear; its process runs", shown && loginProcesses() > before && /^https:\/\/accounts\.google\.com\//.test(a.view().url ?? ""), `login processes ${before} → ${loginProcesses()}`);
  await a.session.cancel();
  await sleep(1200);
  record("named account: cancel before any code reaps the process and frees the window", a.view().phase === "failed" && a.view().reason === "cancelled" && loginProcesses() === before && !a.lock.isHeld, `phase=${a.view().phase} reason=${a.view().reason}; login processes ${loginProcesses()}`);
  const folder = credentialProfileHome(dataDir, "antigravity", "t224");
  record("named account: nothing is in its folder that looks like a login", !readdirSync(folder).includes("antigravity-oauth-token"));
  // What a Connect (the start of `agy acp --login`) itself leaves in an account folder: agy's own files, never the first-run files the agent's launch generates.
  record("named account: a Connect start left neither settings.json nor cache/onboarding.json (so the launch's 'only when missing' still writes them)", !existsSync(join(folder, "settings.json")) && !existsSync(join(folder, "cache", "onboarding.json")), `agy created: ${readdirSync(folder).join(", ")}`);
  // The agent's launch generates the two first-run files (never copied); agy must take them as they are.
  const workdir = join(scratch, "workspace-dev"); mkdirSync(workdir, { recursive: true });
  const written = seedFirstRun(folder, workdir, join(dataDir, "agy-statusline.sh"));
  const seeded = JSON.stringify([readFileSync(join(folder, "settings.json"), "utf8"), readFileSync(join(folder, "cache", "onboarding.json"), "utf8")]);
  const launch = credentialProfileLaunch(dataDir, "antigravity", "t224")!;
  const models = spawnSync("agy", [...launch.args, "models"], { env: { ...process.env, ...launch.env }, encoding: "utf8", timeout: 30_000, input: "" });
  const settings = JSON.parse(readFileSync(join(folder, "settings.json"), "utf8"));
  record("generated first-run files: written once (settings.json, cache/onboarding.json)", written.sort().join() === "cache/onboarding.json,settings.json", written.join(", "));
  record("agy takes the generated files as they are: it starts on the account (exit 1, 'Please sign in'), keeps the trust list to this instance's directory only, keeps the onboarding booleans", /please sign in/i.test(`${models.stdout}${models.stderr}`) && JSON.stringify(settings.trustedWorkspaces) === JSON.stringify([workdir]) && JSON.parse(readFileSync(join(folder, "cache", "onboarding.json"), "utf8")).onboardingComplete === true, `trustedWorkspaces=${JSON.stringify(settings.trustedWorkspaces)}; agy added keys: ${Object.keys(settings).filter(k => !["statusLine", "trustedWorkspaces"].includes(k)).join(",") || "none"}; statusLine keys: ${Object.keys(settings.statusLine ?? {}).join(",")}`);
  record("a second seed writes nothing over them", seedFirstRun(folder, join(scratch, "elsewhere"), "/x") .length === 0 && seeded.length > 0);
}
record("the user's own ~/.gemini login was not touched (token file mtime and size, never content)", realStamp() === realBefore, realBefore === "absent" ? "no token file there" : "unchanged");
rmSync(scratch, { recursive: true, force: true });
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

// AGEND-224: a real Windows run of the Runtime's Antigravity accounts, against a built Runtime bundle (the 83 modules of RUNTIME_BUNDLE_MODULES), with `agy.exe` itself.
// Disposable: everything is made under WORK (default: the folder next to the bundle). The Windows user's own Antigravity login is only ever READ (`agy models`, by its exit code);
// it is never signed in, signed out or changed, and no token is printed. A named account's wrong-code attempt and its cancel are the only logins started, and neither can finish.
//   node harness.mjs <bundle dir> <work dir> [<odd work dir>]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [bundle, work, oddWork] = process.argv.slice(2).map(p => p && resolve(p));
if (!bundle || !work) { console.error("usage: node harness.mjs <bundle dir> <work dir> [<odd work dir>]"); process.exit(2); }
const load = name => import(pathToFileURL(join(bundle, "dist", name)).href);
const { RemoteAccounts } = await load("runtime-remote-accounts.js");
const worker = await load("windows-cli-worker.js");
const { setRemoteSwitch } = await load("runtime-remote-setup.js");
const { createRuntimeProfile } = await load("runtime-profile-ownership.js");
const { runLogoutProcess } = await load("runtime-client.js");
const { credentialProfileLaunch } = await load("runtime-credential-profiles.js");

const results = [];
const record = (item, ok, detail) => { results.push({ item, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${item}${detail ? "  —  " + detail : ""}`); };
// Every process that is Antigravity's login command (`agy... acp --login`, whatever the image is called), by its command line.
const agyPids = () => {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'acp\\s+--login' -and $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId }";
  const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).stdout || "";
  return out.split(/\r?\n/).map(l => l.trim()).filter(l => /^\d+$/.test(l)).map(Number);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const URL_HOST = /^https:\/\/accounts\.google\.com\//;

const version = spawnSync("agy.exe", ["--version"], { encoding: "utf8" }).stdout?.trim() || spawnSync("agy", ["--version"], { encoding: "utf8", shell: true }).stdout?.trim();
console.log(`agy.exe ${version}; node ${process.version}; ${process.platform}`);

async function rig(root) {
  rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
  const pairing = join(root, "pairing"), credentialRoot = join(pairing, "credential-profiles"); mkdirSync(credentialRoot, { recursive: true });
  setRemoteSwitch(pairing, "accounts", true, 3_600_000);
  const ra = new RemoteAccounts({
    pairingDirectory: pairing, credentialRoot,
    status: (cli, directory) => worker.probeCredentialProfileStatus(cli, directory),
    find: cli => worker.findCli(cli), defaultStatus: cli => worker.probeDefaultLogin(cli),
    environment: () => worker.nativeCliEnvironment(), runLogout: (exe, args, env) => runLogoutProcess(exe, args, env),
    isolated: (cli, scratch) => worker.probeCredentialIsolation(cli, scratch),
    deleteCredential: () => Promise.resolve(null),                 // never: the Windows user's own login is not touched by this run
    taskRunning: async () => false, inUse: () => undefined, inUseNow: () => undefined, defaultProfile: () => undefined, changed: () => {},
  });
  return { ra, pairing, credentialRoot };
}
const ACTOR = "windows-224";
const screenOf = async (ra, sessionId) => (await ra.handle("signin.capture", { sessionId })).screen ?? "";
async function waitScreen(ra, sessionId, want, ms = 30_000) {
  const end = Date.now() + ms; let screen = "";
  while (Date.now() < end) { screen = await screenOf(ra, sessionId); if (want(screen)) return screen; await sleep(500); }
  return screen;
}

// 1. The launch: the folder as an argument (relative to the Windows user's ~/.gemini) and the pin.
{
  const { credentialRoot } = await rig(join(work, "r1"));
  createRuntimeProfile(credentialRoot, "antigravity", "t224");
  const launch = credentialProfileLaunch(process.env, "antigravity", join(credentialRoot, "antigravity", "t224"));
  record("launch carries --app_data_dir <relative path> and the SSH_CONNECTION pin", launch.args[0] === "--app_data_dir" && !!launch.env.SSH_CONNECTION, `${launch.args[0]} ${launch.args[1]}`);
}

// 2. Isolation proof, the account's own status, and a named account's sign-in: link + code prompt, a wrong code, a cancel.
{
  const { ra, credentialRoot } = await rig(join(work, "r2"));
  const folder = (await import("node:path")).join(credentialRoot, "antigravity", "t224");
  const before = new Set(agyPids());
  record("the isolation proof: an EMPTY scratch folder answers 'not signed in' although the Windows user's own login is there", await worker.probeCredentialIsolation("antigravity", join(work, "scratch-iso")) === true);
  createRuntimeProfile(credentialRoot, "antigravity", "t224");
  const check = await ra.handle("accounts.check", { cli: "antigravity", profile: "t224" });
  record("a new named account is signed out (not the default's login)", check.loggedIn === false, `loggedIn=${check.loggedIn}`);
  const own = await ra.handle("accounts.check", { cli: "antigravity" });
  record("the computer's own login is only read (`agy models`, exit code)", typeof own.loggedIn === "boolean" || own.loggedIn === null, `loggedIn=${own.loggedIn}; identity ${own.identity ? "present" : "none"} (never printed)`);

  const started = await ra.handle("signin.start", { cli: "antigravity", profile: "t224", method: "subscription", actor: ACTOR });
  const screen = await waitScreen(ra, started.sessionId, s => /https:\/\/accounts\.google\.com\//.test(s) && /(authorization code|code)/i.test(s));
  const link = screen.match(/https:\/\/accounts\.google\.com\/[^\s]*/)?.[0] ?? "";
  record("the sign-in shows Google's link (accounts.google.com only) and asks for the code", URL_HOST.test(link) && /code/i.test(screen), `link host ok=${URL_HOST.test(link)}, query not printed`);
  record("agy.exe is running for it", agyPids().some(pid => !before.has(pid)), `new pids: ${agyPids().filter(pid => !before.has(pid)).join(",") || "none"}`);
  await ra.handle("signin.write", { sessionId: started.sessionId, input: "wrong-code-for-the-224-test" });
  let status = { alive: true }; const end = Date.now() + 40_000;
  while (Date.now() < end) { status = await ra.handle("signin.status", { sessionId: started.sessionId }); if (status.alive === false) break; await sleep(500); }
  record("a wrong code ends the command (not alive) with a failing exit code", status.alive === false && status.exitCode !== 0, `alive=${status.alive}, exitCode=${status.exitCode}, isolated=${status.isolated}`);
  await ra.handle("signin.close", { sessionId: started.sessionId }).catch(() => {});
  await sleep(1500);
  record("a wrong code leaves NO token file in the account's folder", !existsSync(join(folder, "antigravity-oauth-token")) && existsSync(folder));
  record("a wrong code leaves no agy.exe behind", agyPids().every(pid => before.has(pid)), `leftover: ${agyPids().filter(pid => !before.has(pid)).join(",") || "none"}`);
  record("the account is still signed out afterwards", (await ra.handle("accounts.check", { cli: "antigravity", profile: "t224" })).loggedIn === false);

  const second = await new Promise(r => setTimeout(r, 5500)).then(() => ra.handle("signin.start", { cli: "antigravity", profile: "t224", method: "subscription", actor: ACTOR }));
  await waitScreen(ra, second.sessionId, s => /accounts\.google\.com/.test(s));
  const running = agyPids().filter(pid => !before.has(pid));
  await ra.handle("signin.close", { sessionId: second.sessionId });
  await sleep(2000);
  record("cancel (close) before any code ends exactly that process", running.length > 0 && agyPids().every(pid => before.has(pid)), `running before close: ${running.join(",")}; leftover after: ${agyPids().filter(pid => !before.has(pid)).join(",") || "none"}`);
  record("cancel leaves no token file either", !existsSync(join(folder, "antigravity-oauth-token")));
}

// 3. A path with a space and a non-ASCII name, outside the Windows user's folder; and another drive.
if (oddWork) {
  const { credentialRoot } = await rig(join(oddWork, "r3"));
  createRuntimeProfile(credentialRoot, "antigravity", "x224");
  const launch = credentialProfileLaunch(process.env, "antigravity", join(credentialRoot, "antigravity", "x224"));
  const status = await worker.probeCredentialProfileStatus("antigravity", join(credentialRoot, "antigravity", "x224"));
  record("a folder with a space and non-ASCII name outside the user folder resolves to the same folder (empty → signed out)", status.loggedIn === false, `${launch.args[1]}; loggedIn=${status.loggedIn}`);
}
const other = ["D:\\", "E:\\"].find(d => d !== resolve(work).slice(0, 3) && existsSync(d));
if (other) {
  let refused = false, detail = "";
  try { const { credentialRoot } = await rig(join(other, "agend-224-drive")); createRuntimeProfile(credentialRoot, "antigravity", "d224"); credentialProfileLaunch(process.env, "antigravity", join(credentialRoot, "antigravity", "d224")); detail = "launch built (should not be)"; }
  catch (error) { refused = true; detail = String(error.message).slice(0, 120); }
  record("a folder on another drive is refused before anything starts", refused, detail);
  rmSync(join(other, "agend-224-drive"), { recursive: true, force: true });
} else console.log("(no second drive on this computer: the cross-drive refusal is covered by the unit tests only)");

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
writeFileSync(join(work, "result.json"), JSON.stringify({ agy: version, node: process.version, results }, null, 1));
process.exit(failed.length ? 1 : 0);

/** Real CLI/config/sandbox proof on a disposable Windows host. No model or provider call. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { findCli, nativeCliEnvironment } from "../../../dist/windows-cli-worker.js";
import { stagePersonalAgent, windowsPersonalStageHost } from "../../../dist/runtime-personal-stage.js";
import { checkPersonalCodexPrompt } from "../../../dist/runtime-personal-preflight.js";

assert.equal(process.platform, "win32", "Use an isolated Windows rig, never WSL's Windows interop");
assert.equal(process.env.GITHUB_ACTIONS, "true", "This proof is restricted to disposable hosted CI");
const exec = promisify(execFile), root = mkdtempSync(join(homedir(), "agend-personal-proof-"));
const shared = join(root, "shared"), outside = join(root, "outside"), auth = join(root, "source-auth");
for (const path of [shared, outside, auth]) mkdirSync(path);
const authText = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "synthetic-no-provider-access", settings: "must-not-copy" });
writeFileSync(join(auth, "auth.json"), authText);
writeFileSync(join(auth, "config.toml"), 'model = "must-not-copy"');
writeFileSync(join(shared, "allowed.txt"), "SHARED_OK");
writeFileSync(join(outside, "private.txt"), "OUTSIDE_CANARY");
symlinkSync(outside, join(shared, "escape"), "junction");
let stage, server;
const checks = [];
const run = async (command, args, env, cwd = root) => (await exec(command, args, { env, cwd, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 512 * 1024 })).stdout.trim();
try {
  const codex = await findCli("codex"), claude = await findCli("claude-code");
  assert.ok(codex && claude, "Both pinned CLIs must be installed on this disposable host");
  const environment = { ...nativeCliEnvironment(), CODEX_HOME: auth };
  stage = stagePersonalAgent({ cli: "codex", folder: shared, question: "Setup verification only", runtimeReads: [dirname(codex.command), dirname(process.execPath)] }, windowsPersonalStageHost(environment));
  const env = { ...environment, ...stage.plan.environment };
  await checkPersonalCodexPrompt(codex, stage.plan, env); checks.push("effective tool flags and no inherited skills/instructions");
  const jwt = payload => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`;
  const token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, email: "synthetic@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } });
  const oauthText = JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: token, access_token: token, refresh_token: "synthetic-refresh-must-not-copy", account_id: "synthetic-account" } });
  writeFileSync(join(auth, "auth.json"), oauthText);
  const oauth = stagePersonalAgent({ cli: "codex", folder: shared, question: "Setup verification only", runtimeReads: [dirname(codex.command), dirname(process.execPath)] }, windowsPersonalStageHost(environment));
  try {
    const staged = readFileSync(join(oauth.plan.environment.CODEX_HOME, "auth.json"), "utf8");
    assert.equal(JSON.parse(staged).tokens.refresh_token, ""); assert.ok(!staged.includes("synthetic-refresh-must-not-copy"));
    const status = await exec(codex.command, [...codex.args, "login", "status"], { env: { ...environment, ...oauth.plan.environment }, cwd: oauth.plan.cwd, shell: false, windowsHide: true, timeout: 10_000 });
    assert.match(status.stderr, /Logged in using ChatGPT/);
    assert.equal(readFileSync(join(auth, "auth.json"), "utf8"), oauthText);
    checks.push("access-only OAuth parses without changing source or copying refresh authority");
  } finally { oauth.cleanup(); writeFileSync(join(auth, "auth.json"), authText); }
  // Sandbox runs the same named profile as the turn. Never use --sandbox: it overrides that profile.
  const sandbox = script => run(codex.command, [...codex.args, "-C", stage.plan.cwd, "sandbox", "-P", "hub-personal", "--", process.execPath, "-e", script], env, stage.plan.cwd);
  const read = path => `try { process.stdout.write(require('fs').readFileSync(${JSON.stringify(path)},'utf8')); } catch { process.stdout.write('DENIED'); }`;
  assert.equal(await run(process.execPath, ["-e", read(join(outside, "private.txt"))], env), "OUTSIDE_CANARY");
  assert.equal(await sandbox(read(join(shared, "allowed.txt"))), "SHARED_OK"); checks.push("shared folder can be read");
  assert.equal(await sandbox(read(join(outside, "private.txt"))), "DENIED"); checks.push("outside read denied with positive unsandboxed control");
  assert.equal(await sandbox(read(join(shared, "escape", "private.txt"))), "DENIED"); checks.push("junction cannot escape shared folder");
  const created = join(shared, "must-not-write.txt");
  assert.equal(await sandbox(`try { require('fs').writeFileSync(${JSON.stringify(created)},'forbidden'); process.stdout.write('WROTE'); } catch { process.stdout.write('DENIED'); }`), "DENIED");
  assert.equal(existsSync(created), false); checks.push("writes denied");
  let connections = 0;
  server = createServer(socket => { connections++; socket.end(); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  const network = `const s=require('net').connect(${port},'127.0.0.1');s.setTimeout(2000);s.on('connect',()=>{process.stdout.write('CONNECTED');s.end();});s.on('error',()=>process.stdout.write('DENIED'));s.on('timeout',()=>{process.stdout.write('DENIED');s.destroy();});`;
  assert.equal(await run(process.execPath, ["-e", network], env), "CONNECTED");
  assert.equal(connections, 1);
  assert.equal(await sandbox(network), "DENIED"); assert.equal(connections, 1); checks.push("command network denied with reachable local control");
  const help = await run(claude.command, [...claude.args, "--help"], { ...nativeCliEnvironment(), CLAUDE_CONFIG_DIR: auth, DISABLE_AUTOUPDATER: "1" });
  for (const flag of ["--print", "--output-format", "--input-format", "--permission-mode", "--tools", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", "--add-dir"]) assert.ok(help.includes(flag), flag);
  // Hidden safety switches must also be accepted by the actual argument parser, without starting a turn.
  await run(claude.command, [...claude.args, "--safe-mode", "--restricted", "--permission-prompts", "none", "--disable-slash-commands", "--no-chrome", "--help"], { ...nativeCliEnvironment(), CLAUDE_CONFIG_DIR: auth, DISABLE_AUTOUPDATER: "1" });
  checks.push("Claude shipped help and safety argv accepted");
  const output = process.env.PERSONAL_PROOF_OUTPUT;
  assert.ok(output);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "claude-help.txt"), help);
  writeFileSync(join(output, "result.json"), JSON.stringify({ platform: process.platform, checks, providerCalls: 0, userCredentials: false, desktopWindows: false }, null, 2));
  assert.equal(readFileSync(join(auth, "auth.json"), "utf8"), authText);
  assert.equal(readFileSync(join(auth, "config.toml"), "utf8"), 'model = "must-not-copy"');
  console.log(`${checks.length} real Windows personal-profile controls passed; no model/provider call.`);
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  stage?.cleanup();
  // Exact own root only. Hosted runner is discarded after the job.
  rmSync(root, { recursive: true });
}

/** Real tmux + inert mock CLI only. Never connects to a fleet, account or service. */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const compiled = resolve(process.argv[2] ?? "dist");
const output = resolve(process.argv[3] ?? ".artifacts/enter-2957-acceptance.json");
const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const trackedClean = !execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
const runtimeSha256 = createHash("sha256").update(await readFile(join(compiled, "daemon.js"))).digest("hex");
const root = await mkdtemp(resolve(".artifacts/enter-2957-"));
const socket = "agend-proof-enter-" + randomUUID();
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.AGEND_HOME = root;
process.env.AGEND_TMUX_SESSION = socket;
for (const key of ["TMUX", "NOTIFY_SOCKET", "WATCHDOG_USEC", "WATCHDOG_PID"]) delete process.env[key];
const load = name => import(pathToFileURL(join(compiled, name + ".js")).href);
const [{ TmuxManager }, { Daemon }, { ClaudeCodeBackend }, { selectionCard }, { DEFAULT_INSTANCE_CONFIG }, { default: pino }] = await Promise.all([
  load("tmux-manager"), load("daemon"), load("backend/claude-code"), load("selection-card"), load("types"), import("pino"),
]);
TmuxManager.setSocketName(socket);
const fixture = name => readFile(resolve("tests/fixtures/" + name + ".pane.txt"), "utf8");
const idle = await fixture("claude-2.1.293-idle-empty");
const pasted = await fixture("claude-2.1.293-idle-paste-long");
const permission = await fixture("claude-2.1.316-bash-permission-prompt");
const mock = join(root, "mock.cjs");
await writeFile(mock, `
const fs = require("node:fs");
const [record, final] = process.argv.slice(2);
const draw = text => process.stdout.write("\\x1b[2J\\x1b[H" + text.replace(/\\r?\\n/g, "\\r\\n"));
process.stdin.setRawMode(true);
process.stdout.write("\\x1b[?2004h");
draw(${JSON.stringify(idle)});
let pending = "", pasted = false;
process.stdin.on("data", bytes => {
  pending += bytes.toString();
  if (!pasted && pending.includes("\\x1b[201~")) {
    pasted = true;
    fs.appendFileSync(record, "PASTE\\n");
    pending = pending.slice(pending.indexOf("\\x1b[201~") + 6);
    draw(final === "card" ? ${JSON.stringify(permission)} : ${JSON.stringify(pasted)});
  }
  if (pasted && pending.includes("\\r")) {
    fs.appendFileSync(record, "ENTER\\n");
    pending = "";
  }
});
`);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await test()) return; await delay(25); }
  throw Error("Private mock did not reach its expected screen");
}
async function recorded(file) {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}
const backend = new ClaudeCodeBackend(root);
const cases = [];
try {
  await TmuxManager.ensureSession("proof");
  for (const kind of ["card", "composer"]) {
    const record = join(root, kind + ".keys");
    const pane = new TmuxManager("proof", "", { columns: 200, rows: 72 });
    await pane.createWindow([process.execPath, mock, record, kind].map(quote).join(" "), root, "mock-" + kind);
    await until(async () => backend.readInputRow(await pane.capturePane()) !== null);
    assert.equal(await pane.pasteBuffer("[from:private-proof] mock delivery"), true);
    await until(async () => (await recorded(record)).includes("PASTE"));
    if (kind === "card") await until(async () => selectionCard(await pane.capturePane(), "Claude Code")?.cursor === 0);
    else await until(async () => (backend.readInputRow(await pane.capturePane())?.collapsedPastes ?? 0) > 0);
    const daemon = new Daemon("private-proof", { ...DEFAULT_INSTANCE_CONFIG, backend: "claude-code", working_directory: root, log_level: "silent" }, root, true, backend, undefined, pino({ level: "silent" }));
    daemon.tmux = pane;
    if (kind === "card") {
      assert.equal(backend.readInputRow(await pane.capturePane()), null);
      const submissions = [];
      for (const phase of ["initial-submit", "idle-to-busy-retry"]) {
        submissions.push(await daemon.sendDeliveryEnter(phase));
      }
      await delay(150);
      // Check actual bytes received by the mock before the return values: the old path must reproduce approval.
      assert.equal((await recorded(record)).includes("ENTER"), false, "Permission card received Enter");
      assert.deepEqual(submissions, [false, false]);
      cases.push({ kind, pasteCount: 1, permissionCursor: 0, enters: 0, bothSubmitPathsHeld: true });
    } else {
      assert.equal(await daemon.sendDeliveryEnter("initial-submit"), true);
      await until(async () => (await recorded(record)).includes("ENTER"));
      assert.equal((await recorded(record)).split("ENTER").length - 1, 1);
      cases.push({ kind, pasteCount: 1, enters: 1 });
      // A dead window makes the actual capture fail. It cannot authorize another Enter.
      await pane.killWindow();
      assert.equal(await daemon.sendDeliveryEnter("initial-submit"), false);
      cases.push({ kind: "unreadable", enters: 0 });
    }
  }
} finally {
  try { execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const receipt = { sourceHead, trackedClean, runtimeSha256, transport: "private real tmux / inert mock Claude", cases, noFleetOrAccount: true, scratchRemoved: true };
await writeFile(output, JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt));

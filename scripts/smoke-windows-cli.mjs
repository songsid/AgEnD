// Explicit acceptance check; never run from the account-free unit/CI suite.
// Build first: npx tsc. `--live` makes one read-only Codex model request.
import { mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { execFileSync } from "node:child_process";
import { WindowsCliBridge } from "../dist/windows-cli.js";

const bridge = new WindowsCliBridge();
const probe = await bridge.probe();
console.log(JSON.stringify(probe, null, 2));
if (!process.argv.includes("--live")) process.exit(0);
if (!probe.clis.some(c => c.id === "codex" && c.runnable)) throw new Error("A signed-in native Windows Codex is required");
const base = process.platform === "win32" ? tmpdir()
  : execFileSync("wslpath", ["-u", win32.join(probe.home, "AppData", "Local", "Temp")], { encoding:"utf8" }).trim();
const directory = mkdtempSync(join(base, "agend-native-cli-"));
const windowsDirectory = process.platform === "win32" ? directory
  : execFileSync("wslpath", ["-w", directory], { encoding:"utf8" }).trim();
const marker = `windows-native-proof-${randomUUID()}`;
writeFileSync(join(directory,"native-proof.txt"), marker, "utf8");
const task = bridge.start({ requestId:randomUUID(), cli:"codex", cwd:windowsDirectory, sandbox:"read-only",
  prompt:'Use a local shell tool to read native-proof.txt in the current working directory and get [System.Environment]::OSVersion.Platform. Return the exact file content, platform and working directory. Do not change any files. Do not delegate work or use network tools.' });
const deadline = Date.now()+320_000;
let result;
while (Date.now()<deadline) {
  result = bridge.get(task.id);
  if (!["starting","running","cancelling"].includes(result.status)) break;
  await new Promise(resolve => setTimeout(resolve,500));
}
if (!result || result.status!=="completed" || !result.output.includes(marker) || !result.output.includes("Win32NT")) {
  bridge.close(); throw new Error(JSON.stringify(result));
}
console.log(JSON.stringify({ check:"native-windows-cli", status:"passed", cwd:windowsDirectory, result },null,2));

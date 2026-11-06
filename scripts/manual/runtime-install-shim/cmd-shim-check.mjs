#!/usr/bin/env node
// Manual check, not part of the test suite: the repository's test process guard forbids a test from starting a Windows program (M-2239 P2-5),
// so the shim is run by a REAL cmd.exe from here, by hand, on Windows or on WSL with Windows interop and node.exe installed on Windows.
//
//   node scripts/manual/runtime-install-shim/cmd-shim-check.mjs
//
// It writes the shim exactly as templates/runtime-install/install.ps1 writes it, plus a control with a bare `setlocal`, into scratch folders under the
// Windows temp folder (one of them named with !), runs each by name from inside its bin folder (how PATH finds it: the folder is then only in %~dp0, never
// on the command line) under cmd /V:OFF and cmd /V:ON, prints one line per case and deletes the scratch folders. Exit code 0 when every expectation holds.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const template = readFileSync(join(root, "templates/runtime-install/install.ps1"), "utf8");
const lines = [...(/\$shimText = \(([\s\S]*?)\) -join/.exec(template)[1]).matchAll(/'([^']*)'/g)].map(m => m[1]);
const shims = { shim: lines.join("\r\n"), bare: lines.map(l => l === "setlocal DisableDelayedExpansion" ? "setlocal" : l).join("\r\n") };
const windows = process.platform === "win32";
const cmd = windows ? "cmd.exe" : "cmd.exe", cwd0 = windows ? undefined : "/mnt/c";
const probe = spawnSync(cmd, ["/c", "echo %TEMP% & node.exe -v"], { encoding: "utf8", cwd: cwd0 });
if (probe.status !== 0 || !/v\d+\./.test(probe.stdout)) { console.error("needs cmd.exe and node.exe on Windows (or WSL interop)"); process.exit(2); }
const windowsTemp = probe.stdout.split(/\r?\n/)[0].replace(/ *&? *$/, "").trim();
const local = windows ? windowsTemp : spawnSync("wslpath", ["-u", windowsTemp], { encoding: "utf8" }).stdout.trim();
const scratch = join(local, `agend-shim-check-${process.pid}`);
const folderFor = name => {
  const base = join(scratch, name), bin = join(base, "bin"), build = join(base, "1.0.0+aaaaaaaa", "dist");
  mkdirSync(bin, { recursive: true }); mkdirSync(build, { recursive: true });
  writeFileSync(join(bin, "current.txt"), "1.0.0+aaaaaaaa"); writeFileSync(join(build, "runtime-cli.js"), 'console.log("RUNTIME-STARTED " + process.argv.slice(2).join(" "));\n');
  for (const [file, text] of Object.entries(shims)) writeFileSync(join(bin, `${file}.cmd`), text);
  return bin;
};
const run = (bin, shim, flag) => { const r = spawnSync(cmd, [flag, "/c", shim, "--check"], { cwd: bin, encoding: "utf8" }); return `${r.stdout}${r.stderr}`.replace(/\r/g, "").trim().split("\n")[0]; };
let failed = 0;
const expect = (label, got, want) => { const ok = want instanceof RegExp ? want.test(got) : got === want; if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(44)} -> ${got.slice(0, 70)}`); };
try {
  for (const name of ["plain", "rt!", "a!b!c", "!lead", "trail!"]) {
    const bin = folderFor(name);
    for (const flag of ["/V:OFF", "/V:ON"]) expect(`shim   ${flag.padEnd(6)} folder ${JSON.stringify(name)}`, run(bin, "shim", flag), "RUNTIME-STARTED --check");
  }
  const bin = folderFor("rt!");
  expect("control bare setlocal /V:OFF folder \"rt!\"", run(bin, "bare", "/V:OFF"), "RUNTIME-STARTED --check");
  expect("control bare setlocal /V:ON  folder \"rt!\" (the bug)", run(bin, "bare", "/V:ON"), /not installed correctly/);
  writeFileSync(join(bin, "current.txt"), "9.9.9+deadbeef");
  expect("shim   /V:ON missing version, folder \"rt!\"", run(bin, "shim", "/V:ON"), /not installed correctly/);
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log(failed ? `${failed} expectation(s) failed` : "all expectations hold");
process.exit(failed ? 1 : 0);

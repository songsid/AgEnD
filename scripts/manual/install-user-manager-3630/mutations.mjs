// Owned scratch reversals only. Every CLI test uses an isolated HOME and a fake systemctl.
import fs from "node:fs";
import cp from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
const out = path.resolve(process.env.OUT || ".artifacts/install-user-manager-3630/mutations");
fs.mkdirSync(out, { recursive: true });
const helper = "src/install-user-systemd.ts";
const installer = "src/service-installer.ts";
const cases = [
  ["preflight", installer, "if (problem) throw new InstallUserManagerError(problem);", "if (problem && false) throw new InstallUserManagerError(problem);", "names an active manager|names a stopped manager"],
  ["stopped-state", helper, 'manager === "stopped" ? "stopped"', 'manager === "stopped" ? "unavailable"', "names a stopped manager"],
  ["both-sockets", helper, '!d.exists(bus) && !d.exists(privateSocket)', '!d.exists(bus) || !d.exists(privateSocket)', "unknown manager"],
  ["unknown-state", helper, 'manager === "stopped" ? "stopped"', '(manager === "stopped" || manager === "unavailable") ? "stopped"', "unknown manager"],
  ["non-root-sudo", helper, 'p.uid === 0 ? "" : "sudo "', 'p.uid === 0 ? "" : ""', "prints a manual restart"],
  ["root-no-sudo", helper, 'p.uid === 0 ? "" : "sudo "', 'p.uid === 0 ? "sudo " : "sudo "', "prints a manual restart"],
  ["interruption-warning", helper, '[t("install.user_manager_env"), t("install.user_manager_interrupt", manager)]', '[t("install.user_manager_env")]', "names an active manager"],
  ["stopped-start", helper, 'p.kind === "stopped" ? "start" : "restart"', 'p.kind === "stopped" ? "restart" : "restart"', "names a stopped manager"],
  ["wsl-env", helper, 'if (env.WSL_DISTRO_NAME?.trim()) return true;', 'if (false && env.WSL_DISTRO_NAME?.trim()) return true;', "detects WSL"],
  ["wsl-kernel", helper, 'return /microsoft|wsl/i.test(version());', 'return false;', "detects WSL"],
  ["off-wsl", helper, '...(wsl ? [t("install.user_manager_wsl") + " " + t("install.user_manager_wsl_recover")] : [])', '...([t("install.user_manager_wsl") + " " + t("install.user_manager_wsl_recover")])', "prints WSL lasting recovery"],
  ["wsl-order", helper, '    ...(wsl ? [t("install.user_manager_wsl") + " " + t("install.user_manager_wsl_recover")] : []),\n', '', "prints WSL lasting recovery"],
];
const saved = new Map([helper, installer].map(p => [p, fs.readFileSync(p, "utf8")]));
const results = [];
try {
  for (const [id, file, from, to, pattern] of cases) {
    const original = saved.get(file);
    if (original.split(from).length !== 2) throw Error(`non-unique reversal: ${id}`);
    let changed = original.replace(from, to);
    if (id === "wsl-order") changed = changed.replace('    t("install.user_manager_manual"),', '    t("install.user_manager_manual"), ...(wsl ? [t("install.user_manager_wsl") + " " + t("install.user_manager_wsl_recover")] : []),');
    fs.writeFileSync(file, changed);
    const run = cp.spawnSync("node_modules/.bin/vitest", ["run", "tests/install-user-manager-3630.test.ts", "-t", pattern], { encoding: "utf8" });
    const log = run.stdout + run.stderr;
    fs.writeFileSync(path.join(out, id + ".log"), log);
    fs.writeFileSync(file, original);
    if (run.status === 0 || !log.includes("AssertionError") || log.includes("Transform failed")) throw Error(`reversal escaped assertions: ${id}`);
    const counts = log.match(/Tests\s+(\d+) failed/);
    results.push({ id, file, pattern, assertionFailures: Number(counts?.[1]), caught: true });
    console.log(`${id}: ${counts?.[1]} assertion failures`);
  }
} finally {
  for (const [p, content] of saved) fs.writeFileSync(p, content);
}
const inputs = [...saved.keys(), "src/cli.ts", "src/locale.ts", "tests/install-user-manager-3630.test.ts", "scripts/manual/install-user-manager-3630/mutations.mjs"];
const bindings = Object.fromEntries(inputs.map(p => [crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"), [p]]));
fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ inputBindings: bindings, results, restored: true }, null, 2) + "\n");

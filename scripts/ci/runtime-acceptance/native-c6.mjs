#!/usr/bin/env node
// #1450 C6 native acceptance (design "Tests (actual package and service state, not only render)"). Against the
// runner's REAL service manager — a systemd user manager on Linux, launchd on macOS — with PRIVATE unit names / labels
// and a dummy long-running program, never com.agend.fleet:
//   - the restart guard (restart-guard.ts) on definitions the manager has really LOADED: the control passes; another
//     install, the 2.1 format, the wrong interpreter, an extra argument, NODE_OPTIONS / AGEND_NODE /
//     NODE_EXTRA_CA_CERTS in the definition or in the manager's own environment, a drop-in overriding ExecStart and a
//     file changed but not reloaded are each refused — and the running job is never signalled (same pid);
//   - systemd activation (service-activation.ts): a refreshed unit that does not prove out, and a failed daemon-reload,
//     put the unit preimage back AND reloaded (the loaded ExecStart is the preimage's) and the previous PACKAGE back
//     (a real package preimage); the control activates and restarts the job;
//   - launchd activation: exactly one bootout + one bootstrap (no kickstart) to the new job, running; a bootstrap that
//     fails puts the package back BEFORE the preimage job is bootstrapped again, which is then running its own tuple.
// Usage: node scripts/ci/runtime-acceptance/native-c6.mjs   (after `npm run build`; CI only — it drives the manager)
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { activateService, readLoadedUnit, parseLaunchctlPrint } = await import(join(ROOT, "dist", "service-activation.js"));
const { guardSystemd, guardLaunchd } = await import(join(ROOT, "dist", "restart-guard.js"));
const { takePackagePreimage, restorePackagePreimage } = await import(join(ROOT, "dist", "package-preimage.js"));

const ID = `c6accept${process.pid}`;
const W = mkdtempSync(join(tmpdir(), "agend-c6-"));
const NODE = realpathSync(process.execPath);
const calls = [];
const run = (command, args) => {
  calls.push([command, ...args].join(" "));
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 15_000 });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const deps = {
  realpath: p => { try { return realpathSync(p); } catch { return null; } },
  readFirstLine: p => { try { return readFileSync(p, "utf8").split("\n", 1)[0] ?? null; } catch { return null; } },
  isExecutable: p => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } },
};
let failures = 0;
const step = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failures++; console.log(`  ✗ ${name}\n${String(error?.stack ?? error).split("\n").map(l => `      ${l}`).join("\n")}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A fake global prefix holding @songsid/agend at `version`, whose dist/cli.js is a dummy (long-running unless `exits`). */
function installPackage(prefix, version, exits = false) {
  const pkg = join(prefix, "lib", "node_modules", "@songsid", "agend");
  rmSync(pkg, { recursive: true, force: true });
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@songsid/agend", version }, null, 2) + "\n");
  writeFileSync(join(pkg, "dist", "cli.js"), exits ? "#!/usr/bin/env node\nprocess.exit(1);\n"
    : "#!/usr/bin/env node\nprocess.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1 << 30);\n");
  writeFileSync(join(pkg, "dist", "agent-cli.js"), "#!/usr/bin/env node\n");
  chmodSync(join(pkg, "dist", "cli.js"), 0o755);
  mkdirSync(join(prefix, "bin"), { recursive: true });
  if (!existsSync(join(prefix, "bin", "agend"))) symlinkSync("../lib/node_modules/@songsid/agend/dist/cli.js", join(prefix, "bin", "agend"));
  return { pkg, entry: realpathSync(join(pkg, "dist", "cli.js")), root: join(prefix, "lib", "node_modules") };
}
const versionOf = pkg => JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
/** Another Node binary (a different realpath): the "wrong interpreter". */
const OTHER_NODE = join(W, "other-node", "node");
mkdirSync(dirname(OTHER_NODE)); cpSync(NODE, OTHER_NODE); chmodSync(OTHER_NODE, 0o755);

if (process.platform === "linux") await systemd();
else if (process.platform === "darwin") await launchd();
else { console.log(`no native service manager on ${process.platform}`); process.exit(1); }
rmSync(W, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} native C6 check(s) failed`); process.exit(1); }
console.log("\nall native C6 checks passed");

async function systemd() {
  const unitDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  const sd = (...args) => run("systemctl", ["--user", ...args]);
  const units = [];
  const unitFile = name => join(unitDir, `${name}.service`);
  const write = (name, exec, env = [`PATH=${dirname(NODE)}:/usr/bin:/bin`], extra = "") => {
    if (!units.includes(name)) units.push(name);
    assert.match(name, /^agend-c6accept/, "only private units");
    writeFileSync(unitFile(name), `[Unit]\nDescription=AgEnD C6 native acceptance (private)\n[Service]\nExecStart=${exec}\n${env.map(e => `Environment=${e}\n`).join("")}${extra}`);
  };
  const reload = () => assert.equal(sd("daemon-reload").status, 0, "daemon-reload");
  const mainPid = name => Number(sd("show", "-p", "MainPID", "--value", `${name}.service`).stdout.trim());
  const prefix = join(W, "prefix");
  const { pkg, entry, root } = installPackage(prefix, "2.2.0-new");
  const expected = { node: NODE, entry };
  const other = installPackage(join(W, "other-prefix"), "2.2.0-other");
  console.log(`== systemd user manager (${sd("--version").stdout.split("\n")[0]}), private units agend-${ID}-*`);

  try {
    // The control runs, so "never signalled" is a pid that must not change across every refusal below.
    const ctl = `agend-${ID}-guard`;
    write(ctl, `${NODE} ${entry} fleet start`); reload();
    assert.equal(sd("start", `${ctl}.service`).status, 0, "start the control");
    await sleep(500);
    const pid = mainPid(ctl);
    await step("restart guard: the loaded control definition is admitted", () => {
      assert.ok(pid > 0, "the control runs");
      assert.deepEqual(guardSystemd(run, true, `${ctl}.service`, expected, deps), { ok: true });
    });
    const refusals = [
      ["another install", `${NODE} ${other.entry} fleet start`, undefined, "not"],
      ["the 2.1 format (a script, its Node left to PATH)", `${entry} fleet start`, undefined, "as a script"],
      ["the wrong interpreter", `${OTHER_NODE} ${entry} fleet start`, undefined, "not the selected Node"],
      ["an extra argument", `${NODE} ${entry} fleet start --debug`, undefined, "its arguments"],
      ["NODE_OPTIONS in the unit", `${NODE} ${entry} fleet start`, [`PATH=${dirname(NODE)}:/usr/bin:/bin`, "NODE_OPTIONS=--trace-warnings"], "NODE_OPTIONS"],
      ["AGEND_NODE in the unit", `${NODE} ${entry} fleet start`, [`PATH=${dirname(NODE)}:/usr/bin:/bin`, `AGEND_NODE=${OTHER_NODE}`], "AGEND_NODE"],
      ["NODE_EXTRA_CA_CERTS in the unit", `${NODE} ${entry} fleet start`, [`PATH=${dirname(NODE)}:/usr/bin:/bin`, "NODE_EXTRA_CA_CERTS=/etc/hostname"], "NODE_EXTRA_CA_CERTS"],
    ];
    for (const [name, exec, env, why] of refusals) {
      await step(`restart guard refuses the loaded definition: ${name}`, () => {
        const unit = `agend-${ID}-r${refusals.findIndex(r => r[0] === name)}`;
        write(unit, exec, env); reload();
        const judged = guardSystemd(run, true, `${unit}.service`, expected, deps);
        assert.equal(judged.ok, false); assert.match(judged.reason, new RegExp(why));
      });
    }
    await step("restart guard refuses: NODE_OPTIONS in the user manager's own environment", () => {
      assert.equal(sd("set-environment", "NODE_OPTIONS=--trace-warnings").status, 0);
      try {
        const judged = guardSystemd(run, true, `${ctl}.service`, expected, deps);
        assert.equal(judged.ok, false); assert.match(judged.reason, /NODE_OPTIONS/);
      } finally { sd("unset-environment", "NODE_OPTIONS"); }
    });
    await step("restart guard refuses: a drop-in overriding ExecStart (the loaded, overridden command is judged)", () => {
      const unit = `agend-${ID}-dropin`;
      write(unit, `${NODE} ${entry} fleet start`);
      mkdirSync(join(unitDir, `${unit}.service.d`), { recursive: true });
      writeFileSync(join(unitDir, `${unit}.service.d`, "override.conf"), `[Service]\nExecStart=\nExecStart=${OTHER_NODE} ${entry} fleet start\n`);
      reload();
      const judged = guardSystemd(run, true, `${unit}.service`, expected, deps);
      assert.equal(judged.ok, false); assert.match(judged.reason, /not the selected Node/);
    });
    await step("restart guard refuses: the unit file of a RUNNING unit changed but not reloaded", async () => {
      // Only a unit systemd keeps loaded (here: running) can differ from its file; an inactive, unreferenced unit is
      // garbage-collected and read from disk again on the next query (systemd 255) — then the new file is what is
      // judged, as the next check shows.
      const unit = `agend-${ID}-stale`;
      write(unit, `${NODE} ${entry} fleet start`); reload();
      assert.equal(sd("start", `${unit}.service`).status, 0);
      await sleep(300);
      write(unit, `${NODE} ${entry} fleet start --changed`);
      const judged = guardSystemd(run, true, `${unit}.service`, expected, deps);
      assert.equal(judged.ok, false); assert.match(judged.reason, /not reloaded/);
    });
    await step("…an inactive unit whose file changed is judged by that file (systemd reads it again): refused", () => {
      const unit = `agend-${ID}-gc`;
      write(unit, `${NODE} ${entry} fleet start`); reload();
      write(unit, `${NODE} ${entry} fleet start --changed`);
      const judged = guardSystemd(run, true, `${unit}.service`, expected, deps);
      assert.equal(judged.ok, false); assert.match(judged.reason, /its arguments|not reloaded/);
    });
    await step("…and the running control was never signalled (same pid, still active)", () => {
      assert.equal(mainPid(ctl), pid);
      assert.equal(sd("is-active", `${ctl}.service`).stdout.trim(), "active");
    });
    sd("stop", `${ctl}.service`);

    // Activation: a real package preimage, then "npm" replaces the package; the refresh writes the new unit.
    const activation = async (name, newExec, { failReload = false } = {}) => {
      const unit = `agend-${ID}-act-${name}`;
      installPackage(prefix, "2.1.12-old");
      const taken = takePackagePreimage(root, prefix, new Date());
      assert.ok(taken.ok && taken.preimage, "package preimage taken");
      installPackage(prefix, "2.2.0-new");                                  // what npm did
      const preimageExec = `${NODE} ${entry} fleet start --previous`;
      write(unit, preimageExec); reload();
      const preimageBytes = readFileSync(unitFile(unit), "utf8");
      let reloads = 0, restarts = 0, restored = 0;
      const outcome = activateService({ kind: "systemd", unit, user: true, unitPath: unitFile(unit) }, { dir: pkg, bin: join(prefix, "bin", "agend"), entry, node: NODE }, {
        ...deps,
        run: (command, args) => (failReload && command === "systemctl" && args.includes("daemon-reload") && reloads++ === 0
          ? { status: 1, signal: null, stdout: "", stderr: "injected: the first daemon-reload fails" } : run(command, args)),
        readFile: p => { try { return readFileSync(p, "utf8"); } catch { return null; } },
        writeFile: (p, c) => writeFileSync(p, c),
        refresh: () => { write(unit, newExec); return { status: 0, signal: null, stdout: "", stderr: "" }; },
        restart: () => { restarts++; sd("restart", `${unit}.service`); },
        log: () => {},
        restorePackage: () => { restored++; const back = restorePackagePreimage(root, prefix, taken.preimage); return back.ok ? "package back" : `package NOT back: ${back.reason}`; },
      });
      return { unit, outcome, preimageBytes, preimageExec, restarts, restored };
    };
    const loadedArgv = unit => { const r = readLoadedUnit(run, true, `${unit}.service`); assert.ok(r.ok, "loaded unit readable"); return r.unit.tuple.argv.join(" "); };

    await step("activation: a refreshed unit that does not prove out → unit preimage back, RELOADED, package back; never restarted", async () => {
      const a = await activation("proof", `${NODE} ${join(pkg, "dist", "agent-cli.js")} fleet start`);
      assert.equal(a.outcome.ok, false); assert.equal(a.restarts, 0); assert.equal(a.restored, 1);
      assert.equal(readFileSync(unitFile(a.unit), "utf8"), a.preimageBytes, "unit byte-identical");
      assert.equal(loadedArgv(a.unit), a.preimageExec, "systemd has the preimage LOADED");
      assert.equal(versionOf(pkg), "2.1.12-old", "the previous package is installed again");
      assert.match(a.outcome.message, /is back and loaded/);
    });
    await step("activation: a failed daemon-reload → unit preimage back and reloaded, package back; never restarted", async () => {
      const a = await activation("reload", `${NODE} ${entry} fleet start`, { failReload: true });
      assert.equal(a.outcome.ok, false); assert.equal(a.restarts, 0); assert.equal(a.restored, 1);
      assert.equal(readFileSync(unitFile(a.unit), "utf8"), a.preimageBytes);
      assert.equal(loadedArgv(a.unit), a.preimageExec);
      assert.equal(versionOf(pkg), "2.1.12-old");
    });
    await step("activation control: the proven unit is loaded and restarted, the package stays the new one", async () => {
      const a = await activation("ok", `${NODE} ${entry} fleet start`);
      assert.deepEqual(a.outcome, { ok: true, via: "restart" }); assert.equal(a.restarts, 1); assert.equal(a.restored, 0);
      assert.equal(loadedArgv(a.unit), `${NODE} ${entry} fleet start`);
      assert.equal(versionOf(pkg), "2.2.0-new");
      await sleep(500);
      assert.equal(sd("is-active", `${a.unit}.service`).stdout.trim(), "active");
    });
  } finally {
    for (const name of units) { sd("stop", `${name}.service`); rmSync(unitFile(name), { force: true }); rmSync(join(unitDir, `${name}.service.d`), { recursive: true, force: true }); }
    sd("unset-environment", "NODE_OPTIONS");
    sd("daemon-reload");
  }
}

async function launchd() {
  const uid = process.getuid();
  // A runner with a GUI session has gui/<uid>; over SSH only user/<uid> (Background) exists.
  const gui = run("launchctl", ["print", `gui/${uid}`]).status === 0;
  const domain = gui ? `gui/${uid}` : `user/${uid}`;
  const agents = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  const labels = [];
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const plist = (label, args, env = {}, broken = false) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(a => `<string>${esc(a)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin</string>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${esc(v)}</string>`).join("")}</dict>
<key>WorkingDirectory</key><string>${W}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
${gui ? "" : "<key>LimitLoadToSessionType</key><string>Background</string>\n"}${broken ? "<key>Broken</key><dict><key>x</key>\n" : ""}</dict></plist>
`;
  const job = label => { assert.match(label, /^com\.agend\.c6accept/, "only private labels"); if (!labels.includes(label)) labels.push(label); return { label, plistPath: join(agents, `${label}.plist`), target: `${domain}/${label}` }; };
  const load = (j, xml) => { writeFileSync(j.plistPath, xml); const r = run("launchctl", ["bootstrap", domain, j.plistPath]); assert.equal(r.status, 0, `bootstrap ${j.label}: ${r.stderr}`); };
  const print = j => { const r = run("launchctl", ["print", j.target]); return r.status === 0 ? parseLaunchctlPrint(r.stdout) : null; };
  const waitRunning = async j => { for (let i = 0; i < 40; i++) { const p = print(j); if (p?.pid && p.state === "running") return p; await sleep(250); } return print(j); };
  const readFile = p => { try { return readFileSync(p, "utf8"); } catch { return null; } };
  const prefix = join(W, "prefix");
  const { pkg, entry, root } = installPackage(prefix, "2.2.0-new");
  const expected = { node: NODE, entry };
  const other = installPackage(join(W, "other-prefix"), "2.2.0-other");
  console.log(`== launchd, domain ${domain}, private labels com.agend.${ID}.*`);

  try {
    const g = job(`com.agend.${ID}.guard`);
    load(g, plist(g.label, [NODE, entry, "fleet", "start"]));
    const running = await waitRunning(g);
    await step("restart guard: the loaded control job is admitted", () => {
      assert.ok(running?.pid, "the control runs");
      assert.deepEqual(guardLaunchd(run, g.target, g.plistPath, readFile, expected, deps), { ok: true });
    });
    await step("restart guard refuses: AGEND_NODE / NODE_OPTIONS in launchd's own environment", () => {
      for (const key of ["AGEND_NODE", "NODE_OPTIONS"]) {
        assert.equal(run("launchctl", ["setenv", key, OTHER_NODE]).status, 0);
        try {
          const judged = guardLaunchd(run, g.target, g.plistPath, readFile, expected, deps);
          assert.equal(judged.ok, false); assert.match(judged.reason, new RegExp(key));
        } finally { run("launchctl", ["unsetenv", key]); }
      }
    });
    await step("restart guard refuses: the plist on disk is not the loaded job (changed, not reloaded)", () => {
      writeFileSync(g.plistPath, plist(g.label, [NODE, other.entry, "fleet", "start"]));
      const judged = guardLaunchd(run, g.target, g.plistPath, readFile, expected, deps);
      assert.equal(judged.ok, false); assert.match(judged.reason, /is not the one/);
      writeFileSync(g.plistPath, plist(g.label, [NODE, entry, "fleet", "start"]));
    });
    const refusals = [
      ["another install", [NODE, other.entry, "fleet", "start"], {}, "not"],
      ["the 2.1 format (a script, its Node left to PATH)", [entry, "fleet", "start"], {}, "as a script"],
      ["the wrong interpreter", [OTHER_NODE, entry, "fleet", "start"], {}, "not the selected Node"],
      ["NODE_OPTIONS in the plist", [NODE, entry, "fleet", "start"], { NODE_OPTIONS: "--trace-warnings" }, "NODE_OPTIONS"],
    ];
    for (const [name, args, env, why] of refusals) {
      await step(`restart guard refuses the loaded job: ${name}`, async () => {
        const j = job(`com.agend.${ID}.r${refusals.findIndex(r => r[0] === name)}`);
        load(j, plist(j.label, args, env));
        const judged = guardLaunchd(run, j.target, j.plistPath, readFile, expected, deps);
        run("launchctl", ["bootout", j.target]);
        assert.equal(judged.ok, false); assert.match(judged.reason, new RegExp(why));
      });
    }
    await step("…and the running control was never signalled (same pid, running)", () => {
      const now = print(g);
      assert.equal(now?.pid, running.pid); assert.equal(now?.state, "running");
    });
    run("launchctl", ["bootout", g.target]);

    // Activation: the preimage job (the previous package, its own marker) runs; npm replaced the package; the refresh
    // writes the new plist. Every launchctl call is the real one, and counted.
    const activation = async (name, { broken = false } = {}) => {
      const j = job(`com.agend.${ID}.act-${name}`);
      installPackage(prefix, "2.1.12-old");
      const taken = takePackagePreimage(root, prefix, new Date());
      assert.ok(taken.ok && taken.preimage, "package preimage taken");
      const preimageXml = plist(j.label, [NODE, entry, "fleet", "start"], { AGEND_C6_GENERATION: "previous" });
      load(j, preimageXml);
      const before = await waitRunning(j);
      assert.ok(before?.pid, "the preimage job runs");
      installPackage(prefix, "2.2.0-new");                                   // what npm did
      const start = calls.length;
      const order = [];
      const outcome = activateService({ kind: "launchd", label: j.label, plistPath: j.plistPath, domain }, { dir: pkg, bin: join(prefix, "bin", "agend"), entry, node: NODE }, {
        ...deps,
        run: (command, args) => { if (command === "launchctl" && args[0] === "bootstrap") order.push("bootstrap"); return run(command, args); },
        readFile, writeFile: (p, c) => writeFileSync(p, c),
        refresh: () => { writeFileSync(j.plistPath, plist(j.label, [NODE, entry, "fleet", "start"], { AGEND_C6_GENERATION: "new" }, broken)); return { status: 0, signal: null, stdout: "", stderr: "" }; },
        restart: () => { throw new Error("launchd activation never restarts"); },
        log: () => {},
        restorePackage: () => { order.push("restore-package"); const back = restorePackagePreimage(root, prefix, taken.preimage); return back.ok ? "package back" : `package NOT back: ${back.reason}`; },
      });
      const manager = calls.slice(start).filter(c => /^launchctl (bootout|bootstrap|kickstart)/.test(c));
      return { j, outcome, before, preimageXml, manager, order };
    };

    await step("activation control: exactly one bootout + one bootstrap (no kickstart); the new job runs; package stays new", async () => {
      const a = await activation("ok");
      assert.deepEqual(a.outcome, { ok: true, via: "launchd-activation" }, a.outcome.message);
      assert.deepEqual(a.manager.map(c => c.split(" ").slice(0, 2).join(" ")), ["launchctl bootout", "launchctl bootstrap"]);
      const now = await waitRunning(a.j);
      assert.ok(now?.pid && now.pid !== a.before.pid, "a new process runs");
      assert.equal(now.tuple.env.AGEND_C6_GENERATION, "new");
      assert.equal(versionOf(pkg), "2.2.0-new");
      run("launchctl", ["bootout", a.j.target]);
    });
    await step("activation: a bootstrap that fails → package back BEFORE the preimage job is bootstrapped again; it runs its own tuple", async () => {
      const a = await activation("fail", { broken: true });
      assert.equal(a.outcome.ok, false);
      assert.match(a.outcome.message, /Rolled back to the previous job, which is running/);
      assert.deepEqual(a.order, ["bootstrap", "restore-package", "bootstrap"]);
      assert.equal(a.manager.filter(c => /kickstart/.test(c)).length, 0, "no kickstart");
      assert.equal(readFileSync(a.j.plistPath, "utf8"), a.preimageXml, "the preimage plist is back");
      const now = await waitRunning(a.j);
      assert.ok(now?.pid, "the preimage job runs again");
      assert.equal(now.tuple.env.AGEND_C6_GENERATION, "previous");
      assert.equal(versionOf(pkg), "2.1.12-old", "the previous package is installed again");
      run("launchctl", ["bootout", a.j.target]);
    });
  } finally {
    for (const label of labels) { run("launchctl", ["bootout", `${domain}/${label}`]); rmSync(join(agents, `${label}.plist`), { force: true }); }
    for (const key of ["AGEND_NODE", "NODE_OPTIONS"]) run("launchctl", ["unsetenv", key]);
  }
}

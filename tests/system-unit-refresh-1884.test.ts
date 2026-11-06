/**
 * #1884: a root fleet under a legacy system unit (/etc/systemd/system/agend.service) updated from 2.1.12 installed 2.2
 * and kept running 2.1: the refresh (`agend install --no-activate`, which the old updater runs) wrote only the user
 * unit, the system unit kept `ExecStart=<prefix>/bin/agend fleet start`, and `agend restart`'s C6 guard refused it
 * (rehearsed on systemd 249 for beta.15). The refresh now rewrites that one line to the selected program when it starts
 * this package's fleet; everything else in the unit, and any ExecStart that starts something else, is left alone.
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshSystemUnitExecStart } from "../src/service-installer.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** An npm prefix with this package installed as 2.2 lays it out: bin/agend → launcher/agend, a bundled Node. */
function host() {
  const root = mkdtempSync(join(tmpdir(), "agend-1884-"));
  dirs.push(root);
  const pkg = join(root, "prefix/lib/node_modules/@songsid/agend");
  const node = join(pkg, "node_modules/@songsid/agend-node-linux-x64/bin/node");
  for (const f of [join(pkg, "launcher/agend"), join(pkg, "dist/cli.js"), node]) { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, ""); }
  mkdirSync(join(root, "prefix/bin"), { recursive: true });
  symlinkSync(join(pkg, "launcher/agend"), join(root, "prefix/bin/agend"));
  const vars = { label: "com.agend.fleet", execPath: join(pkg, "dist/cli.js"), nodePath: node, path: "/usr/bin:/bin", workingDirectory: "/root/.agend", logPath: "/root/.agend/fleet.log" };
  const unit = (execStart: string, extra = "") => {
    const path = join(root, "agend.service");
    writeFileSync(path, `[Unit]\nDescription=AgEnD (operator's own)\n\n[Service]\nUser=root\n${execStart}\nEnvironment=PATH=/usr/local/bin:/usr/bin:/bin\n${extra}Restart=always\n\n[Install]\nWantedBy=multi-user.target\n`);
    chmodSync(path, 0o640);
    return path;
  };
  /** The line the user unit gets: each word quoted (systemdQuote). */
  const selected = `"${node}" "${join(pkg, "dist/cli.js")}" fleet start`;
  return { root, pkg, node, vars, unit, selected, bin: join(root, "prefix/bin/agend") };
}

describe("#2015: the same refresh gives a system unit OOMPolicy=continue", () => {
  it("a unit already on this install's ExecStart gets only the OOMPolicy line; a second refresh changes nothing", () => {
    const h = host();
    const path = h.unit(`ExecStart=${h.selected}`);
    const before = readFileSync(path, "utf8");
    expect(refreshSystemUnitExecStart(path, h.vars, h.pkg)).toEqual({ kind: "updated", oomPolicyAdded: true });
    expect(readFileSync(path, "utf8")).toBe(before.replace("Restart=always\n", "Restart=always\nOOMPolicy=continue\n"));
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(refreshSystemUnitExecStart(path, h.vars, h.pkg)).toEqual({ kind: "current" });
  });
  it("an OOMPolicy the unit sets itself — any value — is the operator's and stays", () => {
    const h = host();
    for (const own of ["OOMPolicy=stop\n", "OOMPolicy=kill\n", "  OOMPolicy = continue\n"]) {
      const path = h.unit(`ExecStart=${h.selected}`, own);
      const before = readFileSync(path, "utf8");
      expect(refreshSystemUnitExecStart(path, h.vars, h.pkg)).toEqual({ kind: "current" });
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });
  it("#2018 review: an own OOMPolicy=stop survives a refresh that DOES rewrite ExecStart (no second assignment)", () => {
    const h = host();
    const path = h.unit(`ExecStart=${h.bin} fleet start`, "OOMPolicy=stop\n");
    const before = readFileSync(path, "utf8");
    expect(refreshSystemUnitExecStart(path, h.vars, h.pkg)).toEqual({ kind: "updated", execStart: h.selected });
    const after = readFileSync(path, "utf8");
    expect(after).toBe(before.replace(`ExecStart=${h.bin} fleet start`, `ExecStart=${h.selected}`));
    expect(after.match(/^\s*OOMPolicy\s*=.*$/gm)).toEqual(["OOMPolicy=stop"]);
  });
  it("#2018 review: only [Service] counts: an OOMPolicy line elsewhere ([Unit]) does not stand in for it", () => {
    const h = host();
    const path = h.unit(`ExecStart=${h.selected}`);
    writeFileSync(path, readFileSync(path, "utf8").replace("Description=AgEnD (operator's own)\n", "Description=AgEnD (operator's own)\nOOMPolicy=stop\n"));
    expect(refreshSystemUnitExecStart(path, h.vars, h.pkg)).toEqual({ kind: "updated", oomPolicyAdded: true });
    expect(readFileSync(path, "utf8").split(/^\[Service\]/m)[1]).toMatch(/^OOMPolicy=continue$/m);
  });
  it("a foreign unit gets no OOMPolicy either", () => {
    const h = host();
    const path = h.unit("ExecStart=/usr/bin/env agend fleet start");
    const before = readFileSync(path, "utf8");
    expect(refreshSystemUnitExecStart(path, h.vars, h.pkg).kind).toBe("foreign");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("#1884: the refresh brings a legacy system unit's ExecStart to this install", () => {
  it("2.1's `<prefix>/bin/agend fleet start` → the selected Node on this package's entry; every other line and the mode stay", () => {
    const h = host();
    const path = h.unit(`ExecStart=${h.bin} fleet start`);
    const before = readFileSync(path, "utf8");
    expect(refreshSystemUnitExecStart(path, h.vars, h.pkg)).toEqual({ kind: "updated", execStart: h.selected, oomPolicyAdded: true });
    const after = readFileSync(path, "utf8");
    // #2015: OOMPolicy=continue joins the end of [Service]; nothing else moves.
    expect(after).toBe(before.replace(`ExecStart=${h.bin} fleet start`, `ExecStart=${h.selected}`).replace("Restart=always\n", "Restart=always\nOOMPolicy=continue\n"));
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(refreshSystemUnitExecStart(path, h.vars, h.pkg)).toEqual({ kind: "current" });       // a second refresh changes nothing
  });

  it("an explicit Node on this package's entry (a 2.2 or hand-written unit) is brought to the selected Node", () => {
    const h = host();
    const path = h.unit(`ExecStart=/usr/bin/node ${join(h.pkg, "dist/cli.js")} fleet start`);
    expect(refreshSystemUnitExecStart(path, h.vars, h.pkg).kind).toBe("updated");
    expect(readFileSync(path, "utf8")).toContain(`ExecStart=${h.selected}`);
  });

  it("anything that does not start this package's fleet is the operator's: left byte for byte", () => {
    const h = host();
    const other = join(h.root, "other-agend");                    // another install, outside this package
    writeFileSync(other, "");
    for (const line of [`ExecStart=${other} fleet start`, `ExecStart=${h.bin} fleet start --extra`, `ExecStart=/usr/bin/env agend fleet start`, `ExecStart=${h.bin} web`, `ExecStart=${h.bin} fleet stop`, `ExecStart=/usr/bin/node ${join(h.pkg, "dist/cli.js")} web start`]) {
      const path = h.unit(line);
      const before = readFileSync(path, "utf8");
      expect(refreshSystemUnitExecStart(path, h.vars, h.pkg).kind).toBe("foreign");
      expect(readFileSync(path, "utf8")).toBe(before);
    }
    const twice = h.unit(`ExecStart=${h.bin} fleet start`, `ExecStart=${h.bin} fleet start\n`);
    expect(refreshSystemUnitExecStart(twice, h.vars, h.pkg)).toEqual({ kind: "foreign", reason: "2 ExecStart lines" });
  });

  it("an unreadable unit, or one with no [Service] section, is reported and not written", () => {
    const h = host();
    expect(refreshSystemUnitExecStart(join(h.root, "missing.service"), h.vars, h.pkg)).toEqual({ kind: "unreadable" });
    const path = join(h.root, "bare.service");
    writeFileSync(path, `ExecStart=${h.bin} fleet start\n`);
    expect(refreshSystemUnitExecStart(path, h.vars, h.pkg)).toEqual({ kind: "unreadable" });
  });
});

describe("#1884 follow-ups (Fable on #1886): what counts as this package's fleet", () => {
  it("a Node running a script outside the package, or a non-Node interpreter on the package's entry, is foreign", () => {
    const h = host();
    const outside = join(h.root, "elsewhere/cli.js");
    mkdirSync(join(outside, ".."), { recursive: true }); writeFileSync(outside, "");
    for (const line of [`ExecStart=/usr/bin/node ${outside} fleet start`, `ExecStart=/usr/bin/python3 ${join(h.pkg, "dist/cli.js")} fleet start`]) {
      const path = h.unit(line);
      const before = readFileSync(path, "utf8");
      expect(refreshSystemUnitExecStart(path, h.vars, h.pkg), line).toEqual({ kind: "foreign", reason: "its ExecStart does not start this package's fleet" });
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });
  it("a sibling whose path only starts with the package directory's name is not inside it", () => {
    const h = host();
    const sibling = `${h.pkg}-fork/launcher/agend`;            // …/@songsid/agend-fork: a prefix match without the "/"
    mkdirSync(join(sibling, ".."), { recursive: true }); writeFileSync(sibling, "");
    for (const line of [`ExecStart=${sibling} fleet start`, `ExecStart=/usr/bin/node ${h.pkg}-fork/launcher/agend fleet start`]) {
      const path = h.unit(line);
      const before = readFileSync(path, "utf8");
      expect(refreshSystemUnitExecStart(path, h.vars, h.pkg).kind, line).toBe("foreign");
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });
  it("only [Service] counts: an ExecStart in [Unit] is neither rewritten nor counted", () => {
    const h = host();
    const path = h.unit(`ExecStart=${h.bin} fleet start`);
    writeFileSync(path, readFileSync(path, "utf8").replace("Description=AgEnD (operator's own)\n", `Description=AgEnD (operator's own)\nExecStart=${h.bin} fleet start\n`));
    const before = readFileSync(path, "utf8");
    expect(refreshSystemUnitExecStart(path, h.vars, h.pkg)).toEqual({ kind: "updated", execStart: h.selected, oomPolicyAdded: true });
    const after = readFileSync(path, "utf8");
    expect(after.split(/^\[Service\]/m)[0]).toBe(before.split(/^\[Service\]/m)[0]);    // [Unit] byte for byte
    expect(after.split(/^\[Service\]/m)[1]).toContain(`ExecStart=${h.selected}`);
  });
});

describe("#1884 follow-up: the `agend install --no-activate` wiring in cli.ts (the real statements, run with stubs)", () => {
  /** The block between the #1884 and #2331 comments in cli.ts, run as it is with stubbed modules and output. */
  async function wiring(opts: { activate?: boolean; platform: string; systemUnit: string | null; refresh: (...a: unknown[]) => unknown }) {
    const { readFileSync: read } = await import("node:fs");
    const { createContext, runInContext } = await import("node:vm");
    const ts = (await import("typescript")).default;
    const src = read(new URL("../src/cli.ts", import.meta.url), "utf8");
    const start = src.indexOf("    // #1884: a legacy system unit is the service a root fleet runs under");
    const end = src.indexOf("    // #2331: a host whose fleet runs under the system unit", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const calls: unknown[][] = [];
    const out: string[] = [];
    const context = createContext({
      opts: { activate: opts.activate }, detectPlatform: () => opts.platform, getSystemServicePath: () => opts.systemUnit,
      serviceVars: { label: "com.agend.fleet" }, execPath: "/p/lib/node_modules/@songsid/agend/dist/cli.js",
      dirname: (p: string) => p.replace(/\/[^/]*$/, ""),
      console: { log: (s: string) => out.push(s), error: (s: string) => out.push(`ERR ${s}`) }, process: { exitCode: 0 },
      load: async () => ({ refreshSystemUnitExecStart: (...a: unknown[]) => { calls.push(a); return opts.refresh(...a); } }),
    });
    const body = ts.transpileModule(`(async () => {\n${src.slice(start, end)}\n})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.replaceAll("import(", "load(");
    await runInContext(body, context);
    return { calls, out, exitCode: (context as { process: { exitCode: number } }).process.exitCode };
  }
  it("a refresh on Linux with a system unit rewrites it against this package (two levels above dist/cli.js) and says what changed", async () => {
    const r = await wiring({ activate: false, platform: "linux", systemUnit: "/etc/systemd/system/agend.service", refresh: () => ({ kind: "updated", execStart: "X", oomPolicyAdded: true }) });
    expect(r.calls).toEqual([["/etc/systemd/system/agend.service", { label: "com.agend.fleet" }, "/p/lib/node_modules/@songsid/agend"]]);
    expect(r.out).toEqual(["  ✓ /etc/systemd/system/agend.service: ExecStart=X", "  ✓ /etc/systemd/system/agend.service: OOMPolicy=continue (one OOM-killed process no longer stops the fleet)"]);
  });
  it.each([
    [{ activate: true, platform: "linux", systemUnit: "/etc/systemd/system/agend.service" }, "an activating install"],
    [{ activate: false, platform: "macos", systemUnit: "/etc/systemd/system/agend.service" }, "macOS"],
    [{ activate: false, platform: "linux", systemUnit: null }, "no system unit"],
  ])("%j (%s): the system unit is not touched", async (o, _what) => {
    const r = await wiring({ ...o, refresh: () => { throw new Error("must not run"); } });
    expect(r.calls).toEqual([]); expect(r.out).toEqual([]);
  });
  it("foreign and unreadable say so and leave it; a failed write is an error with exit code 1", async () => {
    const unit = "/etc/systemd/system/agend.service";
    expect((await wiring({ activate: false, platform: "linux", systemUnit: unit, refresh: () => ({ kind: "foreign", reason: "2 ExecStart lines" }) })).out)
      .toEqual([`  ℹ ${unit} left as it is: 2 ExecStart lines.`]);
    expect((await wiring({ activate: false, platform: "linux", systemUnit: unit, refresh: () => ({ kind: "unreadable" }) })).out)
      .toEqual([`  ⚠ ${unit} could not be read; left as it is.`]);
    const failed = await wiring({ activate: false, platform: "linux", systemUnit: unit, refresh: () => { throw new Error("EACCES"); } });
    expect(failed.exitCode).toBe(1);
    expect(failed.out[0]).toMatch(/^ERR {3}✗ \/etc\/systemd\/system\/agend\.service could not be updated \(EACCES\)/);
  });
});

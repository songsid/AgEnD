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

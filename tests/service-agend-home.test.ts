/**
 * A fleet started on a custom AGEND_HOME comes back on it after a service restart or an update: `agend install` names
 * that home in the launchd plist / systemd user unit (#1735 follow-up, found by the real-Mac launchd check — the job
 * ran on ~/.agend). The default home adds nothing (byte-identical definitions); the path is quoted exactly; a refresh
 * (`install --no-activate`, an update's) from the default home keeps an existing definition's home.
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  renderLaunchdPlist,
  renderSystemdUnit,
  serviceDefinitionAgendHome,
  serviceHomeFor,
  systemdEnvironmentQuote,
} from "../src/service-installer.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const base = {
  label: "com.agend.fleet",
  execPath: "/opt/agend/lib/node_modules/@songsid/agend/dist/cli.js",
  nodePath: "/opt/agend/lib/node_modules/@songsid/agend/node_modules/@songsid/agend-node-linux-x64/bin/node",
  path: "/usr/local/bin:/usr/bin:/bin",
  workingDirectory: "/home/u/.agend",
  logPath: "/home/u/.agend/fleet.log",
  isRoot: false,
};
/** Lines in `b` that are not in `a`, and whether `a`'s lines all survive in order. */
function added(a: string, b: string): { added: string[]; keptInOrder: boolean } {
  const al = a.split("\n"), bl = b.split("\n"); const out: string[] = []; let i = 0;
  for (const line of bl) { if (i < al.length && line === al[i]) i++; else out.push(line); }
  return { added: out, keptInOrder: i === al.length };
}

describe("the definition names a custom home, and only a custom home", () => {
  it("launchd: the default home writes no AGEND_HOME — byte-identical to a definition without the field", () => {
    const plain = renderLaunchdPlist(base);
    expect(plain).not.toContain("AGEND_HOME");
    expect(renderLaunchdPlist({ ...base, agendHome: undefined })).toBe(plain);
  });

  it("launchd: a custom home adds exactly the AGEND_HOME key and string to EnvironmentVariables, nothing else", () => {
    const plain = renderLaunchdPlist(base);
    const custom = renderLaunchdPlist({ ...base, agendHome: "/srv/fleet-a" });
    const d = added(plain, custom);
    expect(d).toEqual({ added: ["        <key>AGEND_HOME</key>", "        <string>/srv/fleet-a</string>"], keptInOrder: true });
    const env = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(custom)![1]!;
    expect(env).toContain("<key>AGEND_HOME</key>");
  });

  it("systemd: the default home writes no AGEND_HOME — byte-identical", () => {
    const plain = renderSystemdUnit(base);
    expect(plain).not.toContain("AGEND_HOME");
    expect(renderSystemdUnit({ ...base, agendHome: undefined })).toBe(plain);
  });

  it("systemd: a custom home adds exactly one quoted Environment= line in [Service]", () => {
    const plain = renderSystemdUnit(base);
    const custom = renderSystemdUnit({ ...base, agendHome: "/srv/fleet-a" });
    expect(added(plain, custom)).toEqual({ added: ['Environment="AGEND_HOME=/srv/fleet-a"'], keptInOrder: true });
    const service = custom.slice(custom.indexOf("[Service]"), custom.indexOf("[Install]"));
    expect(service).toContain('Environment="AGEND_HOME=/srv/fleet-a"');
  });
});

describe("the path is quoted exactly, and read back exactly", () => {
  const awkward = ["/srv/my fleet", "/srv/100%/agend", '/srv/q"uote', "/srv/back\\slash", "/srv/$HOME/x", "/srv/a&b<c>d'e"];
  it.each(awkward)("launchd round-trip: %s", home => {
    const plist = renderLaunchdPlist({ ...base, agendHome: home });
    expect(serviceDefinitionAgendHome(plist)).toBe(home);
    const text = /<key>AGEND_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)![1]!;   // no raw < inside
    expect(text).not.toMatch(/[>]|&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/);                // escaped XML text
  });
  it.each(awkward)("systemd round-trip: %s", home => {
    const unit = renderSystemdUnit({ ...base, agendHome: home });
    expect(serviceDefinitionAgendHome(unit)).toBe(home);
  });
  it("systemd quoting: % doubled (specifier), \\ and \" escaped, $ left alone (no expansion in Environment=), one word", () => {
    expect(systemdEnvironmentQuote('AGEND_HOME=/a b/100%/"q"/\\x/$y')).toBe('"AGEND_HOME=/a b/100%%/\\"q\\"/\\\\x/$y"');
  });
  it("a relative path or a control character is refused", () => {
    expect(() => renderSystemdUnit({ ...base, agendHome: "srv/fleet" })).toThrow(/absolute/);
    expect(() => renderLaunchdPlist({ ...base, agendHome: "/srv/x\nExecStartPost=rm" })).toThrow(/control characters/);
  });
  it("anything not shaped like ours reads as no home", () => {
    expect(serviceDefinitionAgendHome("Environment=PATH=/usr/bin\n")).toBeNull();
    expect(serviceDefinitionAgendHome("<key>PATH</key><string>/x</string>")).toBeNull();
  });
});

describe("which home the service names", () => {
  const isDefault = (home: string) => home === "/home/u/.agend";
  const customUnit = renderSystemdUnit({ ...base, agendHome: "/srv/fleet-a", workingDirectory: "/srv/fleet-a", logPath: "/srv/fleet-a/fleet.log" });
  it("a custom CLI home is named (install or refresh)", () => {
    expect(serviceHomeFor("/srv/fleet-b", { refresh: false, existingDefinition: null, isDefault })).toEqual({ workingDirectory: "/srv/fleet-b", logPath: "/srv/fleet-b/fleet.log", agendHome: "/srv/fleet-b" });
    expect(serviceHomeFor("/srv/fleet-b", { refresh: true, existingDefinition: customUnit, isDefault })).toEqual({ workingDirectory: "/srv/fleet-b", logPath: "/srv/fleet-b/fleet.log", agendHome: "/srv/fleet-b" });
  });
  it("the default CLI home names nothing", () => {
    expect(serviceHomeFor("/home/u/.agend", { refresh: false, existingDefinition: null, isDefault })).toEqual({ workingDirectory: "/home/u/.agend", logPath: "/home/u/.agend/fleet.log" });
    expect(serviceHomeFor("/home/u/.agend", { refresh: true, existingDefinition: renderSystemdUnit(base), isDefault })).toEqual({ workingDirectory: "/home/u/.agend", logPath: "/home/u/.agend/fleet.log" });
  });
  it("a refresh from the default home keeps an existing custom home (an update typed without AGEND_HOME)", () => {
    expect(serviceHomeFor("/home/u/.agend", { refresh: true, existingDefinition: customUnit, isDefault })).toEqual({ workingDirectory: "/srv/fleet-a", logPath: "/srv/fleet-a/fleet.log", agendHome: "/srv/fleet-a" });
  });
  it("an explicit install from the default home does not keep it (the person chose this home)", () => {
    expect(serviceHomeFor("/home/u/.agend", { refresh: false, existingDefinition: customUnit, isDefault })).toEqual({ workingDirectory: "/home/u/.agend", logPath: "/home/u/.agend/fleet.log" });
  });
});

describe("`agend install --no-activate` with a custom AGEND_HOME (real CLI, scratch HOME, mocked systemctl)", () => {
  it("the user unit names the home it was installed from, and a second refresh keeps it", () => {
    const root = mkdtempSync(join(tmpdir(), "agend-svc-home-")); roots.push(root);
    const home = join(root, "home"), data = join(root, "fleet home"), bin = join(root, "bin");
    for (const d of [home, data, bin]) mkdirSync(d, { recursive: true });
    writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "systemctl"), 0o755);
    const run = () => spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "install", "--no-activate"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
      env: { ...process.env, HOME: home, AGEND_HOME: data, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, NOTIFY_SOCKET: "" },
    });
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    const unitPath = join(home, ".config/systemd/user/com.agend.fleet.service");
    const unit = readFileSync(unitPath, "utf8");
    expect(unit).toContain(`Environment="AGEND_HOME=${data}"`);
    expect(unit).toContain(`WorkingDirectory=${data}`);
    expect(serviceDefinitionAgendHome(unit)).toBe(data);
    const second = run();
    expect(second.status, second.stderr).toBe(0);
    expect(serviceDefinitionAgendHome(readFileSync(unitPath, "utf8"))).toBe(data);
  }, 60_000);
});

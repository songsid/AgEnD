import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ output: "", afterReload: "", fail: false, calls: [] as string[] }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  execSync(command: string) {
    native.calls.push(command);
    if (/^systemctl(?: --user)? show /.test(command)) { if (native.fail) throw Error("manager unavailable"); return native.output; }
    if (/^systemctl(?: --user)? daemon-reload$/.test(command)) { native.output = native.afterReload; return ""; }
    throw Error("Unexpected host command: " + command);
  },
}));
import { loadedUnitCheck, LOADED_PROPERTIES } from "../src/service-installer.js";
import { tmuxReadArgs } from "../src/tmux-read.js";
import { TmuxManager } from "../src/tmux-manager.js";
let home: string, path: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agend-oom-loaded-"));
  const unitDir = join(home, ".config/systemd/user"); mkdirSync(unitDir, { recursive: true });
  path = join(unitDir, "com.agend.fleet.service"); writeFileSync(path, "[Service]\nType=simple\nOOMPolicy=continue\n");
  native.output = ""; native.afterReload = ""; native.fail = false; native.calls = [];
});
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
function loaded(policy?: string, dropIns = "", extra = "") {
  return `Type=simple\nNotifyAccess=all\nTimeoutStartUSec=15min\nFragmentPath=${path}\nDropInPaths=${dropIns}\n${policy === undefined ? "" : `OOMPolicy=${policy}\n`}${extra}`;
}
function check() { return loadedUnitCheck({ user: true, unit: "com.agend.fleet", unitPath: path, home }).join("\n"); }
describe("effective OOM policy, from the loaded manager rather than the written file", () => {
  it("queries and reports a loaded continue value", () => {
    native.output = loaded("continue");
    expect(check()).toContain("has OOMPolicy=continue loaded");
    expect(LOADED_PROPERTIES).toContain("OOMPolicy");
    expect(native.calls).toEqual([`systemctl --user show -p ${LOADED_PROPERTIES.join(",")} com.agend.fleet`]);
  });
  it.each(["stop", "kill"])("reports loaded %s despite a file saying continue, naming an operator override", policy => {
    const dropIn = join(home, "override.conf"); writeFileSync(dropIn, `[Service]\nOOMPolicy=${policy}\n`);
    native.output = loaded(policy, dropIn);
    const result = check();
    expect(result).toContain(`OOMPolicy=${policy} loaded`);
    expect(result).toContain("can stop the whole fleet"); expect(result).toContain(dropIn); expect(result).toContain(path);
    expect(result).not.toContain("has OOMPolicy=continue loaded");
    expect(native.calls).toHaveLength(1); // no override, reload loop or refusal
  });
  it.each(["missing", "unreadable"])("an %s property is explicitly unknown without blocking the operation", kind => {
    native.output = loaded(); native.fail = kind === "unreadable";
    expect(check()).toContain("loaded OOMPolicy could not be verified");
    expect(check()).toContain("-p OOMPolicy -p FragmentPath -p DropInPaths");
  });
  it("uses the new policy snapshot after an existing notify-access repair reloads the manager", () => {
    native.output = loaded("continue").replace("Type=simple", "Type=notify").replace("NotifyAccess=all", "NotifyAccess=main");
    native.afterReload = loaded("stop").replace("Type=simple", "Type=notify");
    const result = check();
    expect(native.calls.some(c => c.endsWith("daemon-reload"))).toBe(true);
    expect(result).toContain("OOMPolicy=stop loaded"); expect(result).not.toContain("has OOMPolicy=continue loaded");
  });
});

describe("primary pane PID accompanies the same status observation", () => {
  it("requests the PID with status and parses it without an extra tmux process", async () => {
    expect(tmuxReadArgs({ kind: "pane", field: "status", session: "scratch", window: "@1" }).at(-1)).toBe("#{pane_dead} #{pane_dead_status} #{pane_pid}");
    const tmux = new TmuxManager("scratch", "@1");
    const read = vi.fn(async () => "0  12345\n"); (tmux as any).read = read;
    expect(await tmux.getPaneStatus()).toEqual({ alive: true, pid: 12345 }); expect(read).toHaveBeenCalledOnce();
    read.mockResolvedValue("1 137 12345\n"); expect(await tmux.getPaneStatus()).toEqual({ alive: false, exitCode: 137 });
    read.mockResolvedValue("0\n"); expect(await tmux.getPaneStatus()).toEqual({ alive: true });
  });
});

/**
 * M-2885 part 2: `agend shortcuts` on a Linux desktop (not WSL) makes two launchers, 「AgEnD 儀表板」 and 「AgEnD 重新啟動」:
 * XDG desktop entries in ~/.local/share/applications, copied to the XDG desktop folder (trusted on GNOME), the AgEnD
 * icons in the user's hicolor theme, and the scripts they run. No desktop session: nothing, said plainly. The scripts
 * are run here with the real sh against fake agend / xdg-open / wl-copy / xclip.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getLocale, setLocale } from "../src/locale.js";
import {
  LINUX_LAUNCHERS_HINT_MARKER, LINUX_LAUNCHERS_MARKER, agendDirOnPath, dashboardScript, desktopEntry, execArg, icoPngs, isGnome,
  launcherPaths, launchersHintOnce, linuxDesktopSession, packageIcons, restartScript, runLinuxLaunchers, type LinuxHost,
} from "../src/linux-launchers.js";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-2885-")); dirs.push(d); return d; };
const locale = getLocale();
afterEach(() => setLocale(locale));
const ICONS = packageIcons();
const validator = spawnSync("desktop-file-validate", ["--help"], { encoding: "utf8" }).status === 0;

/** A desktop session on a scratch home: xdg-user-dir names ~/Desktop (made), gio answers `gio`. */
function rig(o: { env?: NodeJS.ProcessEnv; desktop?: "made" | "home" | "missing"; gio?: number } = {}) {
  const home = scratch(), data = join(home, ".agend");
  const desk = join(home, "Desktop");
  if ((o.desktop ?? "made") === "made") mkdirSync(desk);
  const ran: string[][] = [], lines: string[] = [];
  const host: LinuxHost = {
    env: o.env ?? { XDG_CURRENT_DESKTOP: "ubuntu:GNOME", WAYLAND_DISPLAY: "wayland-0", PATH: "/usr/bin" },
    platform: "linux", home,
    isExecutable: path => path === "/opt/agend/bin/agend",
    run: (command, args) => {
      ran.push([command, ...args]);
      if (command === "xdg-user-dir") return { status: 0, stdout: (o.desktop === "home" ? home : desk) + "\n" };
      if (command === "gio") return { status: o.gio ?? 0, stdout: "" };
      return { status: 127, stdout: "" };
    },
  };
  const deps = { host, dataDir: data, icons: () => ICONS, log: (l: string) => { lines.push(l); }, now: () => new Date("2026-11-11T08:00:00Z") };
  return { home, data, desk, ran, lines, deps, paths: launcherPaths(home) };
}

describe("M-2885: where it makes launchers", () => {
  it("a desktop session is XDG_CURRENT_DESKTOP, DISPLAY or WAYLAND_DISPLAY; an SSH login or a server has none", () => {
    expect(linuxDesktopSession({ XDG_CURRENT_DESKTOP: "KDE" })).toBe(true);
    expect(linuxDesktopSession({ DISPLAY: ":0" })).toBe(true);
    expect(linuxDesktopSession({ WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
    expect(linuxDesktopSession({ SSH_CONNECTION: "1 2 3 4", DISPLAY: " " })).toBe(false);
    expect(linuxDesktopSession({})).toBe(false);
  });
  it("GNOME, also Ubuntu's ubuntu:GNOME; not KDE or XFCE", () => {
    expect(isGnome({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBe(true);
    expect(isGnome({ XDG_CURRENT_DESKTOP: "GNOME" })).toBe(true);
    expect(isGnome({ XDG_CURRENT_DESKTOP: "KDE" })).toBe(false);
    expect(isGnome({ XDG_CURRENT_DESKTOP: "XFCE" })).toBe(false);
    expect(isGnome({})).toBe(false);
  });
  it("no desktop session: says so, makes nothing, leaves no marker", async () => {
    const r = rig({ env: { PATH: "/usr/bin", SSH_CONNECTION: "x" } });
    expect(await runLinuxLaunchers(r.deps)).toBe(1);
    expect(r.lines.join("\n")).toMatch(/no desktop session here/);
    expect(existsSync(join(r.home, ".local"))).toBe(false);
    expect(existsSync(join(r.data, LINUX_LAUNCHERS_MARKER))).toBe(false);
    expect(r.ran).toEqual([]);
  });
  it("the CLI sends WSL to the Windows shortcuts and only a non-WSL Linux here; elsewhere the not-WSL message names both", () => {
    const cli = readFileSync(join(import.meta.dirname, "..", "src", "cli.ts"), "utf8");
    const action = cli.slice(cli.indexOf('.command("shortcuts")'), cli.indexOf("\nprogram\n", cli.indexOf('.command("shortcuts")')));
    expect(action).toMatch(/if \(process\.platform === "linux" && !detectWsl\(realHost\(\)\)\.wsl\) \{\n\s+const \{ runLinuxLaunchers/);
    expect(action.indexOf("runLinuxLaunchers")).toBeLessThan(action.indexOf("runShortcuts(realShortcutsDeps"));
    setLocale("en");
  });
});

describe("M-2885: the launchers on a GNOME desktop", () => {
  it("makes both entries, their scripts, the hicolor icons, the trusted desktop copies, and the marker", async () => {
    setLocale("zh-TW");
    const r = rig();
    expect(await runLinuxLaunchers(r.deps)).toBe(0);
    for (const [file, script, icon] of [["agend-dashboard.desktop", "open-dashboard.sh", "agend"], ["agend-restart.desktop", "restart-agend.sh", "agend-restart"]]) {
      const entry = readFileSync(join(r.paths.applications, file!), "utf8");
      expect(entry).toContain(`Exec=/bin/sh "${join(r.paths.scripts, script!)}"`);
      expect(entry).toContain(`Icon=${icon}\n`);
      expect(entry).toContain("Terminal=true\n");
      expect(statSync(join(r.paths.scripts, script!)).mode & 0o777).toBe(0o755);
      const copy = join(r.desk, file!);
      expect(readFileSync(copy, "utf8")).toBe(entry);
      expect(statSync(copy).mode & 0o111).toBe(0o111);                                   // executable: GNOME's desktop needs it
      expect(r.ran).toContainEqual(["gio", "set", "-t", "string", copy, "metadata::trusted", "true"]);
      for (const size of [16, 24, 32, 48, 64, 256]) {
        const png = readFileSync(join(r.paths.hicolor, `${size}x${size}`, "apps", `${icon}.png`));
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
      }
    }
    expect(readFileSync(join(r.paths.applications, "agend-dashboard.desktop"), "utf8")).toMatch(/^Name=AgEnD Dashboard\nName\[zh_TW\]=AgEnD 儀表板\n/m);
    expect(readFileSync(join(r.paths.applications, "agend-restart.desktop"), "utf8")).toMatch(/^Name=Restart AgEnD\nName\[zh_TW\]=AgEnD 重新啟動\n/m);
    expect(readFileSync(join(r.data, LINUX_LAUNCHERS_MARKER), "utf8")).toBe("2026-11-11T08:00:00.000Z\n");
    expect(r.lines.join("\n")).toContain("✓ 啟動器已更新：「AgEnD 儀表板」打開儀表板，「AgEnD 重新啟動」重新啟動 AgEnD（會先詢問）。");
    expect(r.lines.join("\n")).toContain(`也在桌面上（${r.desk}）。`);
    // The scripts speak the person's language, and put the agend that made them first on PATH.
    expect(readFileSync(join(r.paths.scripts, "restart-agend.sh"), "utf8")).toContain("確定要重啟 AgEnD 嗎？");
  });
  it.skipIf(!validator)("both entries pass desktop-file-validate", async () => {
    const r = rig();
    expect(await runLinuxLaunchers(r.deps)).toBe(0);
    for (const file of ["agend-dashboard.desktop", "agend-restart.desktop"]) {
      const v = spawnSync("desktop-file-validate", [join(r.paths.applications, file)], { encoding: "utf8" });
      expect([v.status, v.stdout + v.stderr]).toEqual([0, ""]);
    }
  });
  it("running it again rewrites them (a moved agend, another language) and asks gio again", async () => {
    const r = rig();
    setLocale("en");
    expect(await runLinuxLaunchers(r.deps)).toBe(0);
    setLocale("zh-TW");
    expect(await runLinuxLaunchers(r.deps)).toBe(0);
    expect(readFileSync(join(r.paths.scripts, "open-dashboard.sh"), "utf8")).toContain("儀表板登入碼");
    expect(r.ran.filter(c => c[0] === "gio")).toHaveLength(4);
  });
  it("not GNOME (KDE): the desktop copies are made executable, gio is never asked", async () => {
    const r = rig({ env: { XDG_CURRENT_DESKTOP: "KDE", DISPLAY: ":0", PATH: "/usr/bin" } });
    expect(await runLinuxLaunchers(r.deps)).toBe(0);
    expect(existsSync(join(r.desk, "agend-dashboard.desktop"))).toBe(true);
    expect(r.ran.some(c => c[0] === "gio")).toBe(false);
  });
  it("gio cannot mark them: made anyway, and the person is told how to allow launching", async () => {
    setLocale("en");
    const r = rig({ gio: 1 });
    expect(await runLinuxLaunchers(r.deps)).toBe(0);
    expect(r.lines.join("\n")).toContain('right-click it and choose "Allow Launching" once');
  });
  it("no desktop folder (xdg-user-dir answers the home itself, or a folder that is not there): the menu only, said so", async () => {
    setLocale("en");
    for (const desktop of ["home", "missing"] as const) {
      const r = rig({ desktop });
      expect(await runLinuxLaunchers(r.deps)).toBe(0);
      expect(existsSync(join(r.paths.applications, "agend-dashboard.desktop"))).toBe(true);
      expect(existsSync(join(r.home, "agend-dashboard.desktop"))).toBe(false);
      expect(r.lines.join("\n")).toContain("so they are only in the applications menu");
    }
  });
});

describe("M-2885: the desktop entry text", () => {
  it("Exec quotes the script path per the Desktop Entry Specification (spaces, $, quotes, backquotes, backslashes, %)", () => {
    expect(execArg("/home/u/.local/share/agend/launchers/open-dashboard.sh")).toBe('"/home/u/.local/share/agend/launchers/open-dashboard.sh"');
    expect(execArg("/home/a b/x.sh")).toBe('"/home/a b/x.sh"');
    expect(execArg('/home/$x"`y/x.sh')).toBe('"/home/\\\\$x\\\\"\\\\`y/x.sh"');
    expect(execArg("/home/a\\b/x.sh")).toBe('"/home/a\\\\\\\\b/x.sh"');
    expect(execArg("/home/100%/x.sh")).toBe('"/home/100%%/x.sh"');
    expect(() => execArg("/home/a\nb/x.sh")).toThrow(/control character/);
  });
  it.skipIf(!validator)("an entry whose script path has every special character still validates", () => {
    const dir = scratch(), file = join(dir, "x.desktop");
    writeFileSync(file, desktopEntry({ file: "x.desktop", name: "AgEnD Dashboard", nameZh: "AgEnD 儀表板", comment: "c", commentZh: "c", icon: "agend", script: '/home/a b/$x"`y\\z/100%/s.sh' }));
    const v = spawnSync("desktop-file-validate", [file], { encoding: "utf8" });
    expect([v.status, v.stdout + v.stderr]).toEqual([0, ""]);
  });
  it("the icons come from the same .ico files as the Windows shortcuts: 16–256 px PNGs; a broken .ico gives none", () => {
    expect(icoPngs(ICONS["agend.ico"]!).map(i => i.size)).toEqual([16, 24, 32, 48, 64, 256]);
    expect(icoPngs(ICONS["agend-restart.ico"]!).map(i => i.size)).toEqual([16, 24, 32, 48, 64, 256]);
    expect(icoPngs(Buffer.from("not an icon"))).toEqual([]);
  });
  it("the agend that ran `agend shortcuts` goes first on the launchers' PATH (a menu does not read the shell's profile)", () => {
    expect(agendDirOnPath({ env: { PATH: "relative:/usr/bin:/opt/agend/bin" }, isExecutable: p => p === "/opt/agend/bin/agend" })).toBe("/opt/agend/bin");
    expect(dashboardScript("/opt/a'b/bin", "/srv/agend-home")).toContain(`PATH='/opt/a'\\''b/bin':"$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; export PATH`);
    expect(restartScript(null, "/srv/agend-home")).toContain(`PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; export PATH`);
  });
});

/** Fake commands in a bin directory: each logs its argv (and standard input) to <name>.log. */
function fakeBin(commands: Record<string, string>) {
  const bin = scratch();
  for (const [name, body] of Object.entries(commands)) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${bin}/${name}.log'\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}
const runScript = (text: string, bin: string, input: string, env: NodeJS.ProcessEnv = {}) => {
  const file = join(scratch(), "s.sh");
  writeFileSync(file, text);
  return spawnSync("/bin/sh", [file], { input, encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: scratch(), ...env }, timeout: 20_000 });
};
const AGEND_WEB = `if [ "$1 $2" = "web --code" ]; then printf 'Sign-in page: http://localhost:19280/signin\\nCode:         ABCD-EF23   (works once, valid ~5 min)\\n'; exit 0; fi; exit 9`;

describe("M-2885: the dashboard launcher's script (real sh)", () => {
  it("asks the fleet for a code, opens the sign-in page, copies the code (Wayland), shows it spaced, waits for Enter", () => {
    setLocale("zh-TW");
    const bin = fakeBin({ agend: AGEND_WEB, "xdg-open": "", "wl-copy": `cat >> "\${0%/*}/wl-copy.in"` });
    const r = runScript(dashboardScript(null, "/srv/agend-home"), bin, "\n", { WAYLAND_DISPLAY: "wayland-0" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("儀表板登入碼： A B C D - E F 2 3");
    expect(r.stdout).toContain("[OK] 登入頁已在瀏覽器打開。");
    expect(r.stdout).toContain("登入頁網址：http://localhost:19280/signin");
    expect(r.stdout).toContain("[OK] 登入碼已複製：在登入頁的輸入框按 Ctrl+V。");
    expect(r.stdout.trimEnd().endsWith("按 Enter 關閉")).toBe(true);
    for (let i = 0; i < 50 && !existsSync(join(bin, "xdg-open.log")); i++) spawnSync("sleep", ["0.1"]);   // it was started in the background
    expect(readFileSync(join(bin, "xdg-open.log"), "utf8")).toBe("http://localhost:19280/signin\n");
    expect(readFileSync(join(bin, "wl-copy.in"), "utf8")).toBe("ABCD-EF23");
  });
  it("X11 with xclip: copied there; no clipboard tool: says to type it", () => {
    setLocale("en");
    const x = fakeBin({ agend: AGEND_WEB, "xdg-open": "", xclip: `cat > "\${0%/*}/xclip.in"` });
    expect(runScript(dashboardScript(null, "/srv/agend-home"), x, "\n", { DISPLAY: ":0" }).stdout).toContain("[OK] The code is copied");
    expect(readFileSync(join(x, "xclip.log"), "utf8")).toBe("-selection clipboard\n");
    const none = fakeBin({ agend: AGEND_WEB, "xdg-open": "" });
    expect(runScript(dashboardScript(null, "/srv/agend-home"), none, "\n", { DISPLAY: ":0" }).stdout).toContain("Type the code above on the sign-in page.");
  });
  it("the fleet does not answer: says AgEnD may not be running and how to start it; nothing opened; exit 1", () => {
    setLocale("en");
    const bin = fakeBin({ agend: "echo 'Web token not found. Is the fleet running?' >&2; exit 1", "xdg-open": "" });
    const r = runScript(dashboardScript(null, "/srv/agend-home"), bin, "\n");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("[!!] The AgEnD dashboard can't be opened right now: AgEnD may not be running yet.");
    expect(r.stdout).toContain("agend start");
    expect(existsSync(join(bin, "xdg-open.log"))).toBe(false);
  });
});

describe("M-2885: the restart launcher's script (real sh)", () => {
  const AGEND = `case "$1" in restart) echo restarting; exit 0;; status) echo 'Fleet: running (4 instances)';; esac`;
  it.each(["", "n", "no", "yes", " Y x"])("answer %j: no restart (only y or Y), says so", (answer) => {
    setLocale("en");
    const bin = fakeBin({ agend: AGEND });
    const r = runScript(restartScript(null, "/srv/agend-home"), bin, `${answer}\n\n`);
    expect(r.stdout).toContain("Restart AgEnD? Every agent restarts, and work in progress is interrupted. (y/N)");
    expect(r.stdout).toContain("Not restarted.");
    expect(existsSync(join(bin, "agend.log"))).toBe(false);
  });
  it.each(["y", " Y "])("answer %j: restarts, then shows the status, waits for Enter", (answer) => {
    setLocale("zh-TW");
    const bin = fakeBin({ agend: AGEND });
    const r = runScript(restartScript(null, "/srv/agend-home"), bin, `${answer}\n\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[OK] AgEnD 正在重新啟動。");
    expect(r.stdout).toContain("  Fleet: running (4 instances)");
    expect(readFileSync(join(bin, "agend.log"), "utf8")).toBe("restart\nstatus\n");
  }, 20_000);
  it("not running: says so with how to start it; another error: says it failed and shows AgEnD's words", () => {
    setLocale("en");
    const down = fakeBin({ agend: "echo 'Fleet not running'; exit 1" });
    expect(runScript(restartScript(null, "/srv/agend-home"), down, "y\n\n").stdout).toContain("[!!] AgEnD is not running, so there is nothing to restart. To start it: agend start");
    const broken = fakeBin({ agend: "echo 'database is locked'; exit 2" });
    const r = runScript(restartScript(null, "/srv/agend-home"), broken, "y\n\n");
    expect(r.stdout).toContain("[!!] The restart did not succeed: AgEnD reported an error.");
    expect(r.stdout).toContain("  database is locked");
  });
  it("no agend anywhere: says so; nothing runs", () => {
    setLocale("en");
    const r = spawnSync("/bin/sh", ["-c", restartScript(null, "/srv/agend-home")], { input: "y\n\n", encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: scratch() } });
    expect(r.stdout).toContain("[!!] AgEnD (the agend command) was not found, so nothing was restarted.");
    expect(r.status).toBe(1);
  });
});

describe("M-2885: the one-time line after an install or update", () => {
  const base = (o: Partial<Parameters<typeof launchersHintOnce>[0]> = {}) => {
    const written: string[] = [];
    const files = new Set<string>(o.exists ? [] : []);
    return {
      written,
      o: { env: { XDG_CURRENT_DESKTOP: "GNOME" }, platform: "linux" as NodeJS.Platform, wsl: false, dataDir: "/d", tty: true,
        exists: (p: string) => files.has(p), write: (p: string) => { if (files.has(p)) throw Object.assign(Error("EEXIST"), { code: "EEXIST" }); files.add(p); written.push(p); }, ...o },
    };
  };
  it("once, on a Linux desktop in a terminal, while there are no launchers", () => {
    setLocale("en");
    const { o, written } = base();
    expect(launchersHintOnce(o)).toBe('Desktop launchers: run `agend shortcuts` to add "AgEnD 儀表板" and "AgEnD 重新啟動".');
    expect(written).toEqual([`/d/${LINUX_LAUNCHERS_HINT_MARKER}`]);
    expect(launchersHintOnce(o)).toBeNull();
  });
  it.each([
    ["no terminal", { tty: false }],
    ["WSL (it has the Windows line)", { wsl: true }],
    ["macOS", { platform: "darwin" as NodeJS.Platform }],
    ["no desktop session", { env: {} }],
    ["the launchers exist", { exists: (p: string) => p === `/d/${LINUX_LAUNCHERS_MARKER}` }],
  ])("%s: nothing", (_n, over) => {
    expect(launchersHintOnce(base(over).o)).toBeNull();
  });
});

describe("M-2885 (Prism #3635 P2): the launchers serve the fleet they were made for, in the data base the desktop reads", () => {
  const AGEND_LOG = `printf '%s|%s\\n' "$1" "\${AGEND_HOME-<unset>}" >> "\${0%/*}/agend.env"; case "$1" in restart) exit 0;; status) echo ok;; web) printf 'Sign-in page: http://localhost:1/signin\\nCode:         ABCD-EF23   (x)\\n';; esac`;
  it.each([
    ["the click's environment has no AGEND_HOME", {}],
    ["the click's environment names another fleet", { AGEND_HOME: "/elsewhere/.agend" }],
  ])("a custom AGEND_HOME is bound into both scripts — %s", async (_n, env) => {
    const r = rig();
    const custom = join(r.home, "fleets", "it's mine");
    expect(await runLinuxLaunchers({ ...r.deps, dataDir: custom })).toBe(0);
    const bin = fakeBin({ agend: AGEND_LOG, "xdg-open": "" });
    runScript(readFileSync(join(r.paths.scripts, "restart-agend.sh"), "utf8"), bin, "y\n\n", env);
    runScript(readFileSync(join(r.paths.scripts, "open-dashboard.sh"), "utf8"), bin, "\n", env);
    expect(readFileSync(join(bin, "agend.env"), "utf8")).toBe(`restart|${custom}\nstatus|${custom}\nweb|${custom}\n`);
  }, 30_000);
  it("control: the default data dir is bound the same way (it is what the CLI resolved)", async () => {
    const r = rig();
    expect(await runLinuxLaunchers(r.deps)).toBe(0);
    expect(readFileSync(join(r.paths.scripts, "restart-agend.sh"), "utf8")).toContain(`AGEND_HOME='${r.data}'; export AGEND_HOME`);
  });
  it("an absolute XDG_DATA_HOME holds the entries, icons and scripts; a relative one is invalid (basedir spec) and ~/.local/share is used", async () => {
    const r = rig();
    const data = join(r.home, "xdg data");
    r.deps.host.env = { ...r.deps.host.env, XDG_DATA_HOME: data };
    expect(await runLinuxLaunchers(r.deps)).toBe(0);
    expect(existsSync(join(data, "applications", "agend-dashboard.desktop"))).toBe(true);
    expect(existsSync(join(data, "icons", "hicolor", "48x48", "apps", "agend.png"))).toBe(true);
    expect(readFileSync(join(data, "applications", "agend-restart.desktop"), "utf8")).toContain(`Exec=/bin/sh "${join(data, "agend", "launchers", "restart-agend.sh")}"`);
    expect(existsSync(join(r.home, ".local", "share", "applications"))).toBe(false);
    expect(launcherPaths("/h", { XDG_DATA_HOME: "relative/data" }).applications).toBe("/h/.local/share/applications");
    expect(launcherPaths("/h", { XDG_DATA_HOME: "  " }).applications).toBe("/h/.local/share/applications");
    expect(launcherPaths("/h", {}).hicolor).toBe("/h/.local/share/icons/hicolor");
  });
});

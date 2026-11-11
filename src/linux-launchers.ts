/**
 * M-2885 part 2: `agend shortcuts` on a Linux desktop (not WSL) — two launchers, the Linux counterparts of the Windows
 * desktop shortcuts (src/windows-shortcuts.ts):
 * - 「AgEnD 儀表板」 opens a terminal that asks the running fleet for a one-time sign-in code (`agend web --code`), opens
 *   the sign-in page in the browser (xdg-open), copies the code to the clipboard when a clipboard tool is there
 *   (wl-copy, xclip, xsel), shows it, and waits for Enter — as the Windows opener does.
 * - 「AgEnD 重新啟動」 opens a terminal that asks first (y/N, no by default), then runs `agend restart` and shows
 *   `agend status` — as the Windows one does.
 * They are XDG desktop entries in ~/.local/share/applications (the applications menu), copied to the XDG desktop folder
 * (`xdg-user-dir DESKTOP`) when there is one, with the AgEnD icons in the user's hicolor theme (taken from the same .ico
 * files the Windows shortcuts use). On GNOME the desktop copies are marked trusted, so a double-click launches them.
 * The scripts they run are written next to them, in the language AgEnD speaks to this person (the locale).
 * No desktop session (a server, an SSH login): nothing is made, and that is said.
 */
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "./locale.js";

/** Written in the data dir once the launchers exist. */
export const LINUX_LAUNCHERS_MARKER = "linux-launchers";

export interface LinuxHost {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  /** An executable at this path. */
  isExecutable: (path: string) => boolean;
  /** Run a program (xdg-user-dir, gio): its status and standard output. */
  run: (command: string, args: string[]) => { status: number | null; stdout: string };
}

/** A Linux desktop session: the variables a graphical login sets (an SSH login or a server has none of them). */
export function linuxDesktopSession(env: NodeJS.ProcessEnv): boolean {
  return !!(env.XDG_CURRENT_DESKTOP?.trim() || env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
}

/** GNOME (also Ubuntu's "ubuntu:GNOME"): its desktop launches a .desktop file only once it is marked trusted. */
export function isGnome(env: NodeJS.ProcessEnv): boolean {
  return (env.XDG_CURRENT_DESKTOP ?? "").split(":").some(part => /^gnome$/i.test(part.trim()));
}

/** The first `agend` on PATH, for the launchers' own PATH (a menu launcher does not read the shell's profile). */
export function agendDirOnPath(host: Pick<LinuxHost, "env" | "isExecutable">): string | null {
  for (const dir of (host.env.PATH ?? "").split(delimiter)) if (dir.startsWith("/") && host.isExecutable(join(dir, "agend"))) return dir;
  return null;
}

/** POSIX sh single-quoted. */
export const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * One argument of a desktop entry's Exec key (Desktop Entry Specification, "The Exec key"): quoted in double quotes with
 * `"`, `` ` ``, `$` and `\` escaped, then — the value being a string — every `\` doubled and `%` written `%%`.
 */
export function execArg(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`a path with a control character cannot be a launcher's command: ${JSON.stringify(value)}`);
  return `"${value.replace(/[\\"`$]/g, m => `\\${m}`)}"`.replace(/\\/g, "\\\\").replace(/%/g, "%%");
}

export interface LauncherEntry { file: string; name: string; nameZh: string; comment: string; commentZh: string; script: string; icon: string }

/** A desktop entry that runs `script` with /bin/sh in a terminal. */
export function desktopEntry(e: LauncherEntry): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.4",
    `Name=${e.name}`,
    `Name[zh_TW]=${e.nameZh}`,
    `Comment=${e.comment}`,
    `Comment[zh_TW]=${e.commentZh}`,
    `Exec=/bin/sh ${execArg(e.script)}`,
    `Icon=${e.icon}`,
    "Terminal=true",
    "Categories=Utility;",
    "StartupNotify=false",
    "",
  ].join("\n");
}

/** The launchers' PATH: the agend that made them first, then where npm/nvm installs usually put it. */
function pathPrelude(agendDir: string | null): string {
  return [
    `PATH=${agendDir ? `${shQuote(agendDir)}:` : ""}"$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; export PATH`,
    `if ! command -v agend >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; fi`,
  ].join("\n");
}

const say = (key: string) => `printf '%s\\n' ${shQuote(t(key))}`;
const WAIT = (key = "launchers.close") => `printf '%s' ${shQuote(t(key) + " ")}; read _ || true`;

/** The dashboard launcher's script (the Windows opener's behaviour, in sh). */
export function dashboardScript(agendDir: string | null): string {
  return [
    "#!/bin/sh",
    "# AgEnD 儀表板 — written by `agend shortcuts` (M-2885); `agend shortcuts` writes it again.",
    pathPrelude(agendDir),
    `out=$(agend web --code 2>&1); rc=$?`,
    `url=$(printf '%s\\n' "$out" | sed -n 's/^Sign-in page: *\\(https\\{0,1\\}:\\/\\/[^ ]*\\).*/\\1/p' | head -n 1)`,
    `code=$(printf '%s\\n' "$out" | sed -n 's/^Code: *\\([A-Z2-7]\\{4\\}-\\{0,1\\}[A-Z2-7]\\{4\\}\\)\\( .*\\)\\{0,1\\}$/\\1/p' | head -n 1)`,
    `if [ "$rc" -ne 0 ] || [ -z "$url" ] || [ -z "$code" ]; then`,
    `  ${say("launchers.dash_not_up")}`,
    `  ${say("launchers.dash_retry")}`,
    `  ${WAIT()}`,
    `  exit 1`,
    `fi`,
    `copied=0`,
    `if [ -n "$WAYLAND_DISPLAY" ] && command -v wl-copy >/dev/null 2>&1; then printf '%s' "$code" | wl-copy >/dev/null 2>&1 && copied=1`,
    `elif [ -n "$DISPLAY" ] && command -v xclip >/dev/null 2>&1; then printf '%s' "$code" | xclip -selection clipboard >/dev/null 2>&1 && copied=1`,
    `elif [ -n "$DISPLAY" ] && command -v xsel >/dev/null 2>&1; then printf '%s' "$code" | xsel --clipboard --input >/dev/null 2>&1 && copied=1; fi`,
    `opened=0`,
    `if command -v xdg-open >/dev/null 2>&1; then`,
    `  if command -v setsid >/dev/null 2>&1; then setsid xdg-open "$url" >/dev/null 2>&1 & else xdg-open "$url" >/dev/null 2>&1 & fi`,
    `  opened=1`,
    `fi`,
    `spaced=$(printf '%s' "$code" | sed 's/./& /g')`,
    `printf '\\n  ┌──────────────────────────────────────┐\\n'`,
    `printf '  │   %s %s   │\\n' ${shQuote(t("launchers.dash_code"))} "$spaced"`,
    `printf '  └──────────────────────────────────────┘\\n'`,
    `[ "$opened" = 1 ] && ${say("launchers.dash_opened")}`,
    `printf '%s%s\\n' ${shQuote(t("launchers.dash_url"))} "$url"`,
    `if [ "$copied" = 1 ]; then ${say("launchers.dash_copied")}; else ${say("launchers.dash_type")}; fi`,
    WAIT(),
    "",
  ].join("\n");
}

/** The restart launcher's script: asks first (no by default), then restarts and shows the status. */
export function restartScript(agendDir: string | null): string {
  return [
    "#!/bin/sh",
    "# AgEnD 重新啟動 — written by `agend shortcuts` (M-2885); `agend shortcuts` writes it again.",
    pathPrelude(agendDir),
    `printf '\\n%s ' ${shQuote(t("launchers.restart_ask"))}`,
    `read answer || answer=`,
    `case "$(printf '%s' "$answer" | tr -d ' \\t')" in`,
    `  y|Y) ;;`,
    `  *) ${say("launchers.restart_no")}; ${WAIT()}; exit 0 ;;`,
    `esac`,
    `if ! command -v agend >/dev/null 2>&1; then ${say("launchers.restart_no_agend")}; ${WAIT()}; exit 1; fi`,
    `out=$(agend restart 2>&1); rc=$?`,
    `if [ "$rc" -eq 0 ]; then`,
    `  ${say("launchers.restart_ok")}`,
    `  sleep 3`,
    `  printf '\\n'`,
    `  agend status 2>&1 | sed 's/^/  /'`,
    `else`,
    `  case "$out" in`,
    `    *"Fleet not running"*) ${say("launchers.restart_not_running")} ;;`,
    `    *) ${say("launchers.restart_failed")} ;;`,
    `  esac`,
    `  [ -n "$out" ] && printf '%s\\n' "$out" | sed 's/^/  /'`,
    `fi`,
    WAIT(),
    "",
  ].join("\n");
}

/** The PNG images of an .ico (PNG-compressed entries, as templates/icons has), by size. */
export function icoPngs(ico: Buffer): Array<{ size: number; png: Buffer }> {
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) return [];
  const out: Array<{ size: number; png: Buffer }> = [];
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const at = 6 + 16 * i;
    if (at + 16 > ico.length) break;
    const len = ico.readUInt32LE(at + 8), offset = ico.readUInt32LE(at + 12);
    const png = ico.subarray(offset, offset + len);
    if (png.length !== len || png.readUInt32BE(0) !== 0x89504e47) continue;
    out.push({ size: ico[at] || 256, png });
  }
  return out;
}

export interface LinuxLaunchersDeps {
  host: LinuxHost;
  dataDir: string;
  /** The package's icons (templates/icons). */
  icons: () => Partial<Record<"agend.ico" | "agend-restart.ico", Buffer>>;
  log: (line: string) => void;
  now: () => Date;
}

const DASHBOARD = { file: "agend-dashboard.desktop", script: "open-dashboard.sh", icon: "agend", ico: "agend.ico" as const };
const RESTART = { file: "agend-restart.desktop", script: "restart-agend.sh", icon: "agend-restart", ico: "agend-restart.ico" as const };

/** Where each piece goes, under this home. */
export function launcherPaths(home: string) {
  return {
    applications: join(home, ".local", "share", "applications"),
    scripts: join(home, ".local", "share", "agend", "launchers"),
    hicolor: join(home, ".local", "share", "icons", "hicolor"),
  };
}

/** The XDG desktop folder, when there is one other than the home itself (xdg-user-dir answers $HOME when none is set). */
export function desktopDir(host: LinuxHost): string | null {
  const r = host.run("xdg-user-dir", ["DESKTOP"]);
  const dir = r.status === 0 ? r.stdout.trim() : "";
  if (!dir || !dir.startsWith("/") || dir.replace(/\/+$/, "") === host.home.replace(/\/+$/, "") || !existsSync(dir)) return null;
  return dir;
}

/** `agend shortcuts` on a Linux desktop. Resolves to the exit code. */
export async function runLinuxLaunchers(deps: LinuxLaunchersDeps): Promise<number> {
  const { host } = deps;
  if (!linuxDesktopSession(host.env)) { deps.log(t("launchers.no_desktop")); return 1; }
  deps.log(t("launchers.making"));
  const paths = launcherPaths(host.home);
  const agendDir = agendDirOnPath(host);
  const icons = deps.icons();
  const made: string[] = [];
  try {
    for (const dir of [paths.applications, paths.scripts]) mkdirSync(dir, { recursive: true });
    for (const [which, text] of [[DASHBOARD, dashboardScript(agendDir)], [RESTART, restartScript(agendDir)]] as const) {
      const script = join(paths.scripts, which.script);
      writeFileSync(script, text, { mode: 0o755 });
      chmodSync(script, 0o755);
      for (const { size, png } of icoPngs(icons[which.ico] ?? Buffer.alloc(0))) {
        const dir = join(paths.hicolor, `${size}x${size}`, "apps");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${which.icon}.png`), png);
      }
      const key = which === DASHBOARD ? "dash" : "restart";
      const entry = desktopEntry({ file: which.file, script, icon: which.icon,
        name: t(`launchers.${key}_name_en`), nameZh: t(`launchers.${key}_name_zh`), comment: t(`launchers.${key}_comment_en`), commentZh: t(`launchers.${key}_comment_zh`) });
      writeFileSync(join(paths.applications, which.file), entry, { mode: 0o644 });
      made.push(join(paths.applications, which.file));
    }
  } catch (err) {
    deps.log(t("launchers.failed", (err as Error).message));
    return 1;
  }
  deps.log(t("launchers.done"));
  deps.log(`  ${t("launchers.in_menu", paths.applications)}`);
  const desktop = desktopDir(host);
  if (!desktop) deps.log(`  ${t("launchers.no_desktop_dir")}`);
  else {
    let untrusted = false;
    for (const which of [DASHBOARD, RESTART]) {
      const copy = join(desktop, which.file);
      try {
        writeFileSync(copy, readFileSync(join(paths.applications, which.file)), { mode: 0o755 });
        chmodSync(copy, 0o755);
      } catch (err) { deps.log(t("launchers.failed", (err as Error).message)); return 1; }
      if (isGnome(host.env) && host.run("gio", ["set", "-t", "string", copy, "metadata::trusted", "true"]).status !== 0) untrusted = true;
    }
    deps.log(`  ${t("launchers.on_desktop", desktop)}`);
    if (untrusted) deps.log(`  ${t("launchers.allow_launching")}`);
  }
  try {
    mkdirSync(deps.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(deps.dataDir, LINUX_LAUNCHERS_MARKER), deps.now().toISOString() + "\n");
  } catch { /* the hint may show once more */ }
  return 0;
}

/** The package's icons (templates/icons, scripts/build-shortcut-icons.py); one that can't be read is left out. */
export function packageIcons(dir = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "icons")): Partial<Record<"agend.ico" | "agend-restart.ico", Buffer>> {
  const icons: Partial<Record<"agend.ico" | "agend-restart.ico", Buffer>> = {};
  for (const name of ["agend.ico", "agend-restart.ico"] as const) { try { icons[name] = readFileSync(join(dir, name)); } catch { /* left out */ } }
  return icons;
}

/** Written once the Linux hint has been shown. */
export const LINUX_LAUNCHERS_HINT_MARKER = "linux-launchers-hint";

/**
 * The one-time line after an install or `agend update` on a Linux desktop: only in a terminal, only on Linux (never WSL:
 * it has its own line), only in a desktop session, only while the launchers were never made, and only once — claimed by
 * creating the hint marker exclusively (`write` fails with EEXIST when it exists), as the WSL line is.
 */
export function launchersHintOnce(o: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; wsl: boolean; dataDir: string; tty: boolean; exists: (path: string) => boolean; write: (path: string, content: string) => void }): string | null {
  if (!o.tty || o.platform !== "linux" || o.wsl || !linuxDesktopSession(o.env)) return null;
  if (o.exists(join(o.dataDir, LINUX_LAUNCHERS_MARKER)) || o.exists(join(o.dataDir, LINUX_LAUNCHERS_HINT_MARKER))) return null;
  try { o.write(join(o.dataDir, LINUX_LAUNCHERS_HINT_MARKER), new Date().toISOString() + "\n"); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") return null; }
  return t("launchers.hint");
}

/** The real host. */
export function realLinuxHost(run: LinuxHost["run"]): LinuxHost {
  return {
    env: process.env, platform: process.platform, home: process.env.HOME || "/",
    isExecutable: path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } },
    run,
  };
}

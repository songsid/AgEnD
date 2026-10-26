/**
 * #581: `agend container prepare`, run by the image's entrypoint before `agend fleet start`.
 *
 * 1. First run: no fleet.yaml yet → write a minimal one from the environment (one instance; web-only unless a chat
 *    platform is named). An existing fleet.yaml is never touched.
 * 2. Install the CLI of every backend fleet.yaml uses that is not installed yet, with that backend's own unattended
 *    installer (BACKEND_INSTALLATION_INFO), into HOME — which is the image's `agend-home` volume, so the install is
 *    kept across restarts and image updates. AGEND_CLI_VERSIONS pins versions where the installer takes one.
 *
 * Nothing here stops the fleet from starting: a CLI that fails to install is reported, and its instances report it
 * the way they do on a host (not installed / sign-in needed).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { newInstanceKiroUi } from "./config.js";
import { BACKEND_INSTALLATION_INFO } from "./instance-lifecycle.js";

/** `AGEND_CLI_VERSIONS="claude-code=2.1.300, kiro-cli=2.34.0"` → { "claude-code": "2.1.300", … }; anything malformed is reported. */
export function parseCliVersions(raw: string | undefined): { pins: Record<string, string>; problems: string[] } {
  const pins: Record<string, string> = Object.create(null);
  const problems: string[] = [];
  for (const item of (raw ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
    const m = /^([a-z][a-z0-9-]*)=([0-9A-Za-z][0-9A-Za-z.+-]{0,63})$/.exec(item);
    if (!m) { problems.push(`AGEND_CLI_VERSIONS: "${item}" is not backend=version`); continue; }
    if (!Object.hasOwn(BACKEND_INSTALLATION_INFO, m[1])) { problems.push(`AGEND_CLI_VERSIONS: no backend named "${m[1]}"`); continue; }
    pins[m[1]] = m[2];
  }
  return { pins, problems };
}

/**
 * The install command for `backend`, pinned to `version` when its installer takes one. null: this installer has no
 * version parameter (the newest is installed, and the pin is reported as not applied).
 */
export function installCommand(backend: string, version: string | undefined, arch: string = process.arch): string | null {
  const info = BACKEND_INSTALLATION_INFO[backend];
  if (!info) return null;
  const plain = info.unattended ?? info.install;
  if (!version) return plain;
  switch (backend) {
    // claude's install.sh takes the version as its argument.
    case "claude-code": return `curl -fsSL https://claude.ai/install.sh | bash -s ${version}`;
    // kiro publishes every release's tarball; its binaries run from where they are unpacked (the audit rigs do this).
    case "kiro-cli": {
      const cpu = arch === "arm64" ? "aarch64" : "x86_64";
      const dir = `"$HOME/.local/share/agend-cli/kiro-cli/${version}"`;
      return `set -e; mkdir -p ${dir} "$HOME/.local/bin"; curl -fsSL https://prod.download.cli.kiro.dev/stable/${version}/kirocli-${cpu}-linux.tar.xz | tar -xJ -C ${dir}; `
        + `for b in ${dir}/kirocli/bin/*; do ln -sf "$b" "$HOME/.local/bin/$(basename "$b")"; done`;
    }
    default: return null;
  }
}

/** The backends fleet.yaml's instances use (their own, else defaults.backend, else claude-code). */
export function fleetBackends(raw: unknown): string[] {
  const doc = (raw && typeof raw === "object" ? raw : {}) as { defaults?: { backend?: unknown }; instances?: Record<string, { backend?: unknown } | null> };
  const fallback = typeof doc.defaults?.backend === "string" ? doc.defaults.backend : "claude-code";
  const used = new Set<string>();
  for (const inst of Object.values(doc.instances ?? {})) used.add(typeof inst?.backend === "string" ? inst.backend : fallback);
  return [...used].sort();
}

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * fleet.yaml for a first start, from the environment. AGEND_INSTANCE (default `dev`) runs AGEND_BACKEND (default
 * claude-code) in /work/<name>. With AGEND_CHANNEL=telegram|discord and AGEND_GROUP_ID, a channel is added: its token
 * is read from TELEGRAM_BOT_TOKEN / DISCORD_BOT_TOKEN (the .env), and AGEND_ADMIN_IDS (comma-separated) are the only
 * people let in. Without them the fleet is web-only.
 */
export function firstRunFleet(env: NodeJS.ProcessEnv): { yaml: string } | { error: string } {
  const name = env.AGEND_INSTANCE?.trim() || "dev";
  const backend = env.AGEND_BACKEND?.trim() || "claude-code";
  if (!NAME_RE.test(name)) return { error: `AGEND_INSTANCE "${name}" must be lowercase letters, digits and dashes` };
  if (!Object.hasOwn(BACKEND_INSTALLATION_INFO, backend)) return { error: `AGEND_BACKEND "${backend}" is not a backend AgEnD installs` };
  // A new kiro instance runs the TUI engine, as every other creation path makes it (#2621; #2697 review).
  const kiroUi = newInstanceKiroUi(backend, undefined);
  const doc: Record<string, unknown> = { instances: { [name]: { backend, ...(kiroUi ? { kiro_ui: kiroUi } : {}), working_directory: `/work/${name}` } } };
  const channel = env.AGEND_CHANNEL?.trim();
  if (channel) {
    if (channel !== "telegram" && channel !== "discord") return { error: `AGEND_CHANNEL must be telegram or discord, not "${channel}"` };
    const group = env.AGEND_GROUP_ID?.trim();
    if (!group || !/^-?\d{1,25}$/.test(group)) return { error: "AGEND_CHANNEL needs AGEND_GROUP_ID (the Telegram forum group or Discord guild id)" };
    const admins = (env.AGEND_ADMIN_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
    if (admins.length === 0 || admins.some(id => !/^\d{1,25}$/.test(id))) return { error: "AGEND_CHANNEL needs AGEND_ADMIN_IDS (your numeric user id; comma-separated for several)" };
    doc.channels = [{
      type: channel, mode: "topic", bot_token_env: channel === "telegram" ? "TELEGRAM_BOT_TOKEN" : "DISCORD_BOT_TOKEN",
      group_id: group, access: { mode: "locked", allowed_users: admins },
    }];
  }
  return { yaml: `# Written by the container's first start (#581). Edit freely: it is never rewritten.\n${yaml.dump(doc, { lineWidth: 120 })}` };
}

export interface PrepareDeps {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  log: (line: string) => void;
  /** Where the backend's binary is, null when it is not installed (backend-availability's resolveBackendBinary). */
  find: (backend: string) => Promise<string | null | undefined>;
  /** Run an install command in a shell; resolves to its exit code. */
  run: (command: string, env: NodeJS.ProcessEnv) => Promise<number>;
  /**
   * The installed CLI's version, or null — read without starting a CLI that could update itself or reach the network
   * (backend-availability's probeBackendVersion, the #2078 rule), else from a pinned install's own directory.
   */
  version: (backend: string, binary: string) => Promise<string | null>;
}

/** Returns false when the fleet cannot start at all (no fleet.yaml and none could be written). */
export async function prepareContainer(deps: PrepareDeps): Promise<boolean> {
  const { env, dataDir, log } = deps;
  const configPath = join(dataDir, "fleet.yaml");
  if (!existsSync(configPath)) {
    const first = firstRunFleet(env);
    if ("error" in first) { log(`✗ No fleet.yaml, and none could be written: ${first.error}`); return false; }
    writeFileSync(configPath, first.yaml, { mode: 0o600, flag: "wx" });
    log(`First start: wrote ${configPath}`);
  }
  let backends: string[];
  try { backends = fleetBackends(yaml.load(readFileSync(configPath, "utf8"))); }
  catch (err) { log(`✗ fleet.yaml could not be read (${(err as Error).message}); no CLI installed — the fleet will report it`); return true; }
  const { pins, problems } = parseCliVersions(env.AGEND_CLI_VERSIONS);
  for (const p of problems) log(`⚠ ${p}`);
  for (const backend of backends) {
    const info = BACKEND_INSTALLATION_INFO[backend];
    if (!info) { log(`⚠ ${backend}: AgEnD has no installer for this backend; install it yourself`); continue; }
    const asked = pins[backend];
    // A pin only counts where the installer can take it; versions are compared exactly (2.1.30 is not 2.1.300).
    const pin = asked && installCommand(backend, asked) ? asked : undefined;
    if (asked && !pin) log(`⚠ ${backend}: its installer takes no version; the newest is used instead of ${asked}`);
    let path = await deps.find(backend);
    // A pinned CLI already in the volume at another version (the pin was changed) is installed again at the pin.
    if (path && pin) {
      const current = await deps.version(backend, path);
      if (current === null) log(`⚠ ${backend}: its installed version cannot be read, so the pin ${pin} is not checked`);
      else if (current !== pin) { log(`${backend}: ${current} is installed; the pin asks for ${pin}`); path = null; }
    }
    if (!path) {
      log(`Installing ${backend}${pin ? ` ${pin}` : ""}…`);
      const code = await deps.run(installCommand(backend, pin)!, env);
      path = await deps.find(backend);
      if (code !== 0 || !path) { log(`✗ ${backend}: the install ${code !== 0 ? `exited ${code}` : "finished but no binary was found"}; its instances will report it`); continue; }
    }
    const version = await deps.version(backend, path);
    if (pin && version !== pin) {
      log(version === null
        ? `⚠ ${backend}: ${path} is installed, but its version cannot be read to confirm the pin ${pin}`
        : `✗ ${backend}: ${version} is installed, not the pinned ${pin}`);
      continue;
    }
    log(`✓ ${backend}: ${path}${version ? ` (${version})` : ""}${pin ? " — pinned" : ""}`);
  }
  return true;
}

/** A pinned install's version from where installCommand unpacked it (…/agend-cli/<backend>/<version>/…), or null. */
export function pinnedLayoutVersion(realPath: string): string | null {
  return /\/agend-cli\/[a-z][a-z0-9-]*\/([0-9A-Za-z][0-9A-Za-z.+-]*)\//.exec(realPath)?.[1] ?? null;
}

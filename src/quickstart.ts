import { createInterface } from "node:readline/promises";
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, statSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { stdin, stdout } from "node:process";
import { execSync } from "node:child_process";
import yaml from "js-yaml";
import { BACKENDS, validateBotToken, verifyBotToken } from "./setup-wizard.js";
import { getAgendHome } from "./paths.js";

const DATA_DIR = getAgendHome();
const FLEET_CONFIG_PATH = join(DATA_DIR, "fleet.yaml");
const ENV_PATH = join(DATA_DIR, ".env");

// ── ANSI helpers ─────────────────────────────────────────

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

// ── Backend detection ────────────────────────────────────

function detectBackends(): typeof BACKENDS {
  return BACKENDS.filter(b => {
    try {
      execSync(`which ${b.binary}`, { stdio: "pipe" });
      return true;
    } catch { return false; }
  });
}

// ── Group + User ID auto-detect via Telegram polling ─────

// ── Discord bot verification ─────────────────────────────

async function verifyDiscordToken(token: string): Promise<{ valid: boolean; username: string | null }> {
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) return { valid: false, username: null };
    const data = (await res.json()) as { username?: string };
    return { valid: true, username: data.username ?? null };
  } catch { return { valid: false, username: null }; }
}

async function listDiscordGuilds(token: string): Promise<{ id: string; name: string }[]> {
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me/guilds", {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) return [];
    return (await res.json()) as { id: string; name: string }[];
  } catch { return []; }
}

// ── Telegram group + user detection ──────────────────────

const DETECT_TIMEOUT = 3 * 60_000;

async function detectGroupAndUser(
  token: string,
): Promise<{ groupId: number; userId: number }> {
  const api = `https://api.telegram.org/bot${token}`;
  let offset = 0;
  const start = Date.now();

  // Consume stale updates first
  try {
    const stale = await fetch(`${api}/getUpdates?offset=-1&timeout=0`);
    const data = (await stale.json()) as { result?: { update_id: number }[] };
    if (data.result?.length) offset = data.result[data.result.length - 1].update_id + 1;
  } catch { /* ignore */ }

  while (Date.now() - start < DETECT_TIMEOUT) {
    process.stdout.write(`  Waiting for message... ${dim("(Ctrl+C to cancel)")}\r`);
    const res = await fetch(`${api}/getUpdates?offset=${offset}&timeout=30`);
    const data = (await res.json()) as {
      result?: {
        update_id: number;
        message?: { chat: { id: number; type: string }; from?: { id: number } };
      }[];
    };
    for (const update of data.result ?? []) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (msg?.chat?.type === "supergroup" || msg?.chat?.type === "group") {
        if (msg.from?.id) {
          process.stdout.write("\x1b[2K"); // clear line
          return { groupId: msg.chat.id, userId: msg.from.id };
        }
      }
    }
  }
  throw new Error("Timed out (3 min). Please run `agend quickstart` again.");
}

// ── Project roots detection ──────────────────────────────

function detectProjectRoots(): { path: string; gitCount: number }[] {
  const home = homedir();
  const candidates = platform() === "darwin"
    ? ["Documents", "Projects", "Developer"]
    : ["projects", "src", "workspace", "code"];

  const results: { path: string; gitCount: number }[] = [];
  for (const name of candidates) {
    const dir = join(home, name);
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir);
      const gitCount = entries.filter(e => {
        try { return statSync(join(dir, e, ".git")).isDirectory(); } catch { return false; }
      }).length;
      results.push({ path: dir, gitCount });
    } catch { continue; }
  }
  results.sort((a, b) => b.gitCount - a.gitCount);
  return results;
}

// ── ClassicBot guild append helper ───────────────────────

const CLASSIC_BOT_PATH = join(DATA_DIR, "classicBot.yaml");

async function maybeUpdateClassicBot(rl: import("node:readline/promises").Interface): Promise<void> {
  if (!existsSync(CLASSIC_BOT_PATH)) return;
  const config = yaml.load(readFileSync(CLASSIC_BOT_PATH, "utf-8")) as Record<string, any>;
  let changed = false;

  // ── Add allowed guilds ──
  const addGuilds = await rl.question(`\n  classicBot.yaml found. Add allowed guilds? [y/N] `);
  if (addGuilds.toLowerCase() === "y") {
    const guilds: string[] = ((config as any)?.defaults?.allowed_guilds ?? []).map(String);
    console.log(`  Current allowed guilds: ${guilds.join(", ") || "(none)"}`);

    const token = readDiscordToken();
    if (token) {
      const available = await listDiscordGuilds(token);
      if (available.length > 0) {
        const unregistered = available.filter(g => !guilds.includes(g.id));
        if (unregistered.length > 0) {
          console.log(`\n  Bot is in these servers:`);
          for (let i = 0; i < unregistered.length; i++) {
            console.log(`    ${i + 1}. ${unregistered[i].name} ${dim(`(${unregistered[i].id})`)}`);
          }
          console.log(`    0. Skip`);
          while (true) {
            const choice = (await rl.question("  Add server [0]: ")).trim();
            if (!choice || choice === "0") break;
            const idx = parseInt(choice, 10) - 1;
            if (idx >= 0 && idx < unregistered.length) {
              guilds.push(unregistered[idx].id);
              console.log(`  ${green("✓")} Added: ${unregistered[idx].name} (${unregistered[idx].id})`);
              unregistered.splice(idx, 1);
              if (unregistered.length === 0) break;
            }
          }
        } else {
          console.log(`  All servers already in allowed list.`);
        }
      }
    }
    while (true) {
      const gid = (await rl.question("  Add guild ID manually (Enter to finish): ")).trim();
      if (!gid) break;
      if (guilds.includes(gid)) { console.log(`  Already in list.`); continue; }
      guilds.push(gid);
      console.log(`  ${green("✓")} Added: ${gid}`);
    }
    ((config as any).defaults ??= {}).allowed_guilds = guilds;
    changed = true;
  }

  // ── Add admin users ──
  const addAdmins = await rl.question(`  Add admin users? [y/N] `);
  if (addAdmins.toLowerCase() === "y") {
    const admins: string[] = ((config as any)?.defaults?.admin_users ?? []).map(String);
    console.log(`  Current admin users: ${admins.join(", ") || "(none)"}`);
    while (true) {
      const uid = (await rl.question("  Add user ID (Enter to finish): ")).trim();
      if (!uid) break;
      if (admins.includes(uid)) { console.log(`  Already in list.`); continue; }
      admins.push(uid);
      console.log(`  ${green("✓")} Added: ${uid}`);
    }
    ((config as any).defaults ??= {}).admin_users = admins;
    changed = true;
  }

  if (changed) {
    writeFileSync(CLASSIC_BOT_PATH, `# ClassicBot Configuration\n${yaml.dump(config, { quotingType: '"', forceQuotes: false })}`);
    console.log(`  ${green("✓")} Updated ${CLASSIC_BOT_PATH}`);
  }
}

/** Read Discord bot token from .env (uses bot_token_env from fleet.yaml) */
function readDiscordToken(): string | null {
  if (!existsSync(ENV_PATH)) return null;
  const content = readFileSync(ENV_PATH, "utf-8");
  // Try bot_token_env from fleet.yaml first
  if (existsSync(FLEET_CONFIG_PATH)) {
    try {
      const fleet = yaml.load(readFileSync(FLEET_CONFIG_PATH, "utf-8")) as Record<string, any>;
      const envName = fleet?.channel?.bot_token_env;
      if (envName) {
        const m = content.match(new RegExp(`^${envName}=(\\S+)`, "m"));
        if (m) return m[1];
      }
    } catch { /* ignore */ }
  }
  // Fallback: common Discord token env var names
  const match = content.match(/^(?:AGEND_DISCORD_TOKEN|DISCORD_TOKEN)=(\S+)/m);
  return match?.[1] ?? null;
}

// ── Platform flow results ────────────────────────────────

interface PlatformResult {
  type: "telegram" | "discord";
  token: string;
  tokenEnvName: string;
  botUsername: string;
  groupId: string;
  userId: string;
  generalChannelId?: string;
}

async function runTelegramFlow(rl: import("node:readline/promises").Interface): Promise<PlatformResult> {
  console.log(bold("Telegram Bot"));
  console.log(`  1. Open BotFather: ${dim("https://t.me/BotFather")}`);
  console.log(`  2. Send /newbot and pick a name`);
  console.log(`  3. Copy the token\n`);

  let token = "";
  let botUsername = "";
  const tokenEnvName = "AGEND_BOT_TOKEN";
  while (true) {
    token = (await rl.question("  Paste token: ")).trim();
    if (!validateBotToken(token)) {
      console.log(`  ${yellow("Invalid format.")} Should look like: 123456789:ABCdef...`);
      continue;
    }
    const result = await verifyBotToken(token);
    if (!result.valid) {
      console.log(`  ${yellow("Token rejected by Telegram.")} Try again.`);
      continue;
    }
    botUsername = result.username ?? "";
    console.log(`  ${green("✓")} Bot verified: @${botUsername}\n`);
    break;
  }

  console.log(`  Add @${botUsername} to a Telegram group, then send /start in the group.\n`);
  const detected = await detectGroupAndUser(token);
  const groupId = String(detected.groupId);
  const userId = String(detected.userId);
  console.log(`  ${green("✓")} Group: ${groupId} | User: ${userId}\n`);

  return { type: "telegram", token, tokenEnvName, botUsername, groupId, userId };
}

async function runDiscordFlow(rl: import("node:readline/promises").Interface): Promise<PlatformResult> {
  console.log(bold("Discord Bot"));
  console.log(`  1. Go to Discord Developer Portal: ${dim("https://discord.com/developers/applications")}`);
  console.log(`  2. New Application → Bot → Reset Token → Copy`);
  console.log(`  3. Enable ${bold("Message Content Intent")} under Bot → Privileged Gateway Intents\n`);

  let token = "";
  let botUsername = "";
  const tokenEnvName = "AGEND_DISCORD_TOKEN";
  while (true) {
    token = (await rl.question("  Paste bot token: ")).trim();
    if (!token) continue;
    const result = await verifyDiscordToken(token);
    if (!result.valid) {
      console.log(`  ${yellow("Token rejected by Discord.")} Try again.`);
      continue;
    }
    botUsername = result.username ?? "";
    console.log(`  ${green("✓")} Bot verified: ${botUsername}\n`);
    break;
  }

  let groupId = "";
  const guilds = await listDiscordGuilds(token);
  if (guilds.length === 0) {
    console.log(`  Bot is not in any server. Invite it first:`);
    console.log(`  ${dim("https://discord.com/developers/applications → OAuth2 → URL Generator")}`);
    console.log(`  Scopes: bot | Permissions: Send Messages, Read Message History, Manage Channels\n`);
    groupId = (await rl.question("  Paste Guild ID: ")).trim();
  } else if (guilds.length === 1) {
    groupId = guilds[0].id;
    console.log(`  ${green("✓")} Guild: ${guilds[0].name} (${groupId})`);
  } else {
    console.log("  Bot is in multiple servers:");
    for (let i = 0; i < guilds.length; i++) {
      console.log(`    ${i + 1}. ${guilds[i].name} ${dim(`(${guilds[i].id})`)}`);
    }
    const gChoice = await rl.question(`  Choose [1]: `);
    const gIdx = Math.max(0, Math.min(guilds.length - 1, parseInt(gChoice || "1", 10) - 1));
    groupId = guilds[gIdx].id;
    console.log(`  ${green("✓")} Guild: ${guilds[gIdx].name}`);
  }

  console.log(`\n  To get your User ID:`);
  console.log(`  Discord Settings → Advanced → ${bold("Developer Mode")} ON → Right-click yourself → Copy User ID\n`);
  const userId = (await rl.question("  Paste your User ID: ")).trim();
  console.log(`  ${green("✓")} User: ${userId}\n`);

  console.log(`\n  To get a Channel ID for the General channel:`);
  console.log(`  Right-click the text channel → ${bold("Copy Channel ID")}\n`);
  let generalChannelId = "";
  while (!generalChannelId) {
    generalChannelId = (await rl.question("  Paste General Channel ID (required): ")).trim();
    if (!generalChannelId) {
      console.log(`  ${yellow("⚠")} General Channel ID is required for Discord. The General dispatcher needs a channel to operate in.`);
    }
  }
  console.log(`  ${green("✓")} General Channel: ${generalChannelId}\n`);

  return { type: "discord", token, tokenEnvName, botUsername, groupId, userId, generalChannelId: generalChannelId || undefined };
}

/** Build a channel config object from a PlatformResult */
function buildChannelConfig(p: PlatformResult): Record<string, any> {
  const cfg: Record<string, any> = {
    id: p.type,
    type: p.type,
    mode: "topic",
    bot_token_env: p.tokenEnvName,
    group_id: p.groupId,
    access: { mode: "locked", allowed_users: [p.userId] },
  };
  if (p.generalChannelId) {
    cfg.options = { general_channel_id: p.generalChannelId };
  }
  return cfg;
}

// ── Main ─────────────────────────────────────────────────

export async function runQuickstart(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    console.log(`\n${bold("═══ AgEnD Quickstart ═══")}\n`);

    // Check existing config
    if (existsSync(FLEET_CONFIG_PATH)) {
      console.log(`  ${yellow("fleet.yaml already exists.")} What would you like to do?`);
      console.log("    1. Add allowed users");
      console.log("    2. Add another platform");
      console.log("    3. Overwrite (start fresh)");
      console.log("    4. Skip");
      const action = (await rl.question("  Choose [4]: ")).trim();

      if (action === "1") {
        // ── Add allowed users to existing fleet.yaml ──
        const raw = readFileSync(FLEET_CONFIG_PATH, "utf-8");
        const config = yaml.load(raw) as Record<string, any>;
        const currentUsers: string[] = (config as any)?.channel?.access?.allowed_users ?? [];
        console.log(`\n  Current allowed users: ${currentUsers.join(", ") || "(none)"}`);
        while (true) {
          const uid = (await rl.question("  Add user ID (Enter to finish): ")).trim();
          if (!uid) break;
          currentUsers.push(uid);
          console.log(`  ${green("✓")} Added: ${uid}`);
        }
        ((config as any).channel ??= {}).access ??= { mode: "locked" };
        (config as any).channel.access.allowed_users = currentUsers;
        writeFileSync(FLEET_CONFIG_PATH, yaml.dump(config, { quotingType: '"', forceQuotes: false }));
        console.log(`  ${green("✓")} Updated ${FLEET_CONFIG_PATH}`);

        // Hot-reload if fleet is running
        const pidPathUsers = join(DATA_DIR, "fleet.pid");
        if (existsSync(pidPathUsers)) {
          try { process.kill(parseInt(readFileSync(pidPathUsers, "utf-8").trim(), 10), "SIGHUP"); console.log(`  ${green("✓")} Fleet hot-reloaded.`); } catch { /* not running */ }
        }

        await maybeUpdateClassicBot(rl);
        console.log(`\n${bold("═══ Done ═══")}\n`);
        return;
      }

      if (action === "2") {
        // ── Add another platform ──
        const raw = readFileSync(FLEET_CONFIG_PATH, "utf-8");
        const config = yaml.load(raw) as Record<string, any>;

        // Normalize channel → channels
        if (config.channel && !config.channels) {
          config.channels = [{ ...config.channel, id: config.channel.type }];
          delete config.channel;
        }
        const channels: any[] = config.channels ?? [];
        const existingTypes = channels.map((c: any) => c.type);

        const available = ["telegram", "discord"].filter(t => !existingTypes.includes(t));
        if (available.length === 0) {
          console.log(`  Both platforms already configured.`);
          await maybeUpdateClassicBot(rl);
          console.log(`\n${bold("═══ Done ═══")}\n`);
          return;
        }

        let platformType: string;
        if (available.length === 1) {
          platformType = available[0];
          console.log(`\n  Adding: ${platformType}\n`);
        } else {
          console.log(`\n  Available platforms:`);
          for (let i = 0; i < available.length; i++) {
            console.log(`    ${i + 1}. ${available[i]}`);
          }
          const pChoice = (await rl.question("  Choose [1]: ")).trim();
          platformType = available[Math.max(0, Math.min(available.length - 1, parseInt(pChoice || "1", 10) - 1))];
        }

        console.log();
        const result = platformType === "telegram" ? await runTelegramFlow(rl) : await runDiscordFlow(rl);
        channels.push(buildChannelConfig(result));
        config.channels = channels;

        writeFileSync(FLEET_CONFIG_PATH, yaml.dump(config, { quotingType: '"', forceQuotes: false }));
        console.log(`  ${green("✓")} Updated ${FLEET_CONFIG_PATH}`);

        // Append or replace token in .env
        const envLine = `${result.tokenEnvName}=${result.token}`;
        const existingEnv = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8") : "";
        const lines = existingEnv.split("\n");
        const idx = lines.findIndex(l => l.startsWith(result.tokenEnvName + "="));
        if (idx >= 0) lines[idx] = envLine;
        else lines.push(envLine);
        writeFileSync(ENV_PATH, lines.filter(l => l !== "").join("\n") + "\n", { mode: 0o600 });
        try { chmodSync(ENV_PATH, 0o600); } catch {}
        console.log(`  ${green("✓")} ${ENV_PATH}`);

        await maybeUpdateClassicBot(rl);

        // Auto-restart fleet if running — prefer systemd to keep watchdog/crash recovery
        const pidPath = join(DATA_DIR, "fleet.pid");
        if (existsSync(pidPath)) {
          const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
          try {
            process.kill(pid, 0); // check alive
            console.log(`\n  Fleet is running. Restarting to apply new channel...`);
            const { execSync, spawn } = await import("node:child_process");
            let usedSystemd = false;
            try {
              execSync("systemctl --user is-active com.agend.fleet", { stdio: "pipe" });
              execSync("systemctl --user restart com.agend.fleet", { stdio: "pipe" });
              usedSystemd = true;
              console.log(`  ${green("✓")} Fleet restarted via systemd.`);
            } catch {
              const child = spawn("sh", ["-c", "sleep 2 && agend fleet restart --reload"], { detached: true, stdio: "ignore" });
              child.unref();
              console.log(`  ${green("✓")} Fleet restart scheduled (2s). New platform will be available shortly.`);
            }
          } catch { /* not running, user will start manually */ }
        }

        console.log(`\n${bold("═══ Done ═══")}\n`);
        return;
      }

      if (action !== "3") {
        // Skip (default)
        await maybeUpdateClassicBot(rl);
        console.log(`\n${bold("═══ Done ═══")}\n`);
        return;
      }
      // action === "3" → overwrite requires fleet to be stopped
      if (existsSync(join(DATA_DIR, "fleet.pid"))) {
        try { process.kill(parseInt(readFileSync(join(DATA_DIR, "fleet.pid"), "utf-8").trim(), 10), 0); console.error("Fleet is running. Stop it first: agend stop"); process.exit(1); } catch { /* stale pid, ok to proceed */ }
      }
    }

    // Check tmux
    try {
      execSync("which tmux", { stdio: "pipe" });
    } catch {
      console.error("tmux is required. Install: brew install tmux (macOS) or apt install tmux (Linux)");
      process.exit(1);
    }

    // ── Step 1: Backend ──────────────────────────────────

    console.log(bold("Step 1/3: Backend"));
    const found = detectBackends();

    let backend: string;
    if (found.length === 0) {
      console.log(`  No supported backend found in PATH.`);
      console.log(`  Install Claude Code: ${dim("curl -fsSL https://claude.ai/install.sh | bash")}`);
      process.exit(1);
    } else if (found.length === 1) {
      backend = found[0].id;
      console.log(`  ${green("✓")} Detected: ${found[0].label} ${dim(`(${found[0].binary})`)}`);
    } else {
      console.log("  Multiple backends detected:");
      for (let i = 0; i < found.length; i++) {
        console.log(`    ${i + 1}. ${found[i].label} ${dim(`(${found[i].binary})`)}`);
      }
      const choice = await rl.question(`  Choose [1]: `);
      const idx = Math.max(0, Math.min(found.length - 1, parseInt(choice || "1", 10) - 1));
      backend = found[idx].id;
      console.log(`  ${green("✓")} Selected: ${found[idx].label}`);
    }

    // ── Step 2: Channel ────────────────────────────────

    console.log(`\n${bold("Step 2/4: Channel")}`);
    console.log("    1. Telegram");
    console.log("    2. Discord");
    console.log("    3. Both (Telegram + Discord)");
    const chChoice = await rl.question(`  Choose [1]: `);
    const channelChoice = chChoice.trim() === "3" ? "both" : chChoice.trim() === "2" ? "discord" : "telegram";
    console.log(`  ${green("✓")} ${channelChoice}\n`);

    // Collect platform configs
    const platforms: PlatformResult[] = [];
    if (channelChoice === "telegram" || channelChoice === "both") {
      platforms.push(await runTelegramFlow(rl));
    }
    if (channelChoice === "discord" || channelChoice === "both") {
      platforms.push(await runDiscordFlow(rl));
    }

    const primaryPlatform = platforms[0];

    // ── Project roots ────────────────────────────────────

    console.log(bold("Project Roots (optional)"));
    console.log(`  ${dim("Directories containing your projects. Agents use these to find repos.")}\n`);

    const roots = detectProjectRoots();
    let projectRoots: string[] = [];
    if (roots.length > 0) {
      console.log("  Detected project directories:");
      for (const r of roots) {
        console.log(`    ${r.path} ${dim(`(${r.gitCount} git repos)`)}`);
      }
      const best = roots[0];
      const confirm = await rl.question(`\n  Use ${best.path}? [Y/n] `);
      if (confirm.toLowerCase() !== "n") {
        projectRoots = [best.path];
        console.log(`  ${green("✓")} ${best.path}`);
      }
    }
    if (projectRoots.length === 0) {
      const manual = (await rl.question("  Enter path (or leave blank to skip): ")).trim();
      if (manual) {
        const expanded = resolve(manual.replace(/^~/, homedir()));
        projectRoots = [expanded];
        console.log(`  ${green("✓")} ${expanded}`);
        if (!existsSync(expanded)) {
          console.log(`  ${dim("(directory does not exist yet — will be used when created)")}`);
        }
      } else {
        console.log(`  ${dim("Skipped")}`);
      }
    }
    console.log();

    // ── Write config ─────────────────────────────────────

    mkdirSync(DATA_DIR, { recursive: true });

    // Build fleet config object
    const fleetObj: Record<string, any> = {};
    if (platforms.length === 1) {
      // Single platform: use channel (singular) for simplicity
      fleetObj.channel = buildChannelConfig(platforms[0]);
      delete fleetObj.channel.id; // not needed for single
    } else {
      // Multi-platform: use channels array
      fleetObj.channels = platforms.map(p => buildChannelConfig(p));
    }
    if (projectRoots.length > 0) fleetObj.project_roots = projectRoots;
    fleetObj.defaults = { backend };

    writeFileSync(FLEET_CONFIG_PATH, yaml.dump(fleetObj, { quotingType: '"', forceQuotes: false }));
    console.log(`\n  ${green("✓")} ${FLEET_CONFIG_PATH}`);

    // Write .env with all tokens
    const envLines = platforms.map(p => `${p.tokenEnvName}=${p.token}`).join("\n") + "\n";
    writeFileSync(ENV_PATH, envLines, { mode: 0o600 });
    try { chmodSync(ENV_PATH, 0o600); } catch { /* best-effort on Windows */ }
    console.log(`  ${green("✓")} ${ENV_PATH}`);

    // ── ClassicBot setup (Discord only) ──────────────────

    const discordPlatform = platforms.find(p => p.type === "discord");
    const classicPath = join(DATA_DIR, "classicBot.yaml");
    if (discordPlatform && existsSync(classicPath)) {
      await maybeUpdateClassicBot(rl);
    } else if (discordPlatform) {
      const setupClassic = await rl.question(`\n  Set up ClassicBot? (allows /start in any channel) [Y/n] `);
      if (setupClassic.toLowerCase() !== "n") {
        const allowedGuilds: string[] = [discordPlatform.groupId];
        console.log(`  ${green("✓")} Primary guild added: ${discordPlatform.groupId}`);
        while (true) {
          const more = (await rl.question(`  Add another guild ID? (Enter to skip): `)).trim();
          if (!more) break;
          allowedGuilds.push(more);
          console.log(`  ${green("✓")} Added: ${more}`);
        }

        const cbBackend = (await rl.question(`  Default backend [${backend}]: `)).trim() || backend;

        const adminUsers: string[] = [discordPlatform.userId];
        console.log(`  ${green("✓")} Admin user added: ${discordPlatform.userId}`);
        while (true) {
          const uid = (await rl.question(`  Add another admin user ID? (Enter to skip): `)).trim();
          if (!uid) break;
          adminUsers.push(uid);
          console.log(`  ${green("✓")} Added: ${uid}`);
        }

        writeFileSync(classicPath, `# ClassicBot Configuration\n${yaml.dump({
          defaults: { backend: cbBackend, allowed_guilds: allowedGuilds, admin_users: adminUsers },
        }, { quotingType: '"', forceQuotes: false })}`);
        console.log(`  ${green("✓")} ${classicPath}`);
      }
    }

    // ── Next steps ───────────────────────────────────────

    console.log(`\n${bold("═══ Setup Complete ═══")}\n`);
    console.log(`  ${dim("(Optional)")} Edit ${FLEET_CONFIG_PATH} to customize\n`);

    // Offer to install & start as a system service (auto-start, survives reboot).
    // On success the fleet is already running; on failure (e.g. WSL without
    // systemd) we fall back to telling the user to start it manually.
    const svcAnswer = (await rl.question("  Install as system service? [Y/n] ")).trim().toLowerCase();
    const wantsService = svcAnswer === "" || svcAnswer === "y" || svcAnswer === "yes";
    let serviceRunning = false;
    if (wantsService) {
      try {
        const { installService, activateService } = await import("./service-installer.js");
        const svcPath = installService({
          label: "com.agend.fleet",
          execPath: process.argv[1],
          path: process.env.PATH!,
          workingDirectory: DATA_DIR,
          logPath: join(DATA_DIR, "fleet.log"),
        });
        // Stops any manually-started fleet, then daemon-reload + enable + start.
        activateService(svcPath, join(DATA_DIR, "fleet.pid"));
        console.log(`\n  ${green("✅")} Fleet service installed and running.`);
        serviceRunning = true;
      } catch (err) {
        console.log(`\n  ${yellow("⚠")}  Could not install the service automatically (${(err as Error).message}).`);
        console.log(`     Start the fleet manually: ${bold("agend fleet start")}`);
      }
    }
    if (!serviceRunning) {
      console.log(`\n  Start the fleet: ${bold("agend fleet start")}`);
    }

    const hasDiscord = platforms.some(p => p.type === "discord");
    if (hasDiscord) {
      for (const p of platforms) {
        if (p.type === "discord") console.log(`  • Talk to ${p.botUsername} in your Discord server`);
        else console.log(`  • Talk to @${p.botUsername} in your Telegram group`);
      }
      console.log(`\n  ${dim("Classic Bot Mode: Use /start in any Discord channel to start an agent. Use /chat to talk.")}\n`);
    } else {
      console.log(`  • Talk to @${primaryPlatform.botUsername} in your Telegram group\n`);
    }
  } finally {
    rl.close();
  }
}

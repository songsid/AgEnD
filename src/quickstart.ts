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

async function maybeAddClassicBotGuilds(rl: import("node:readline/promises").Interface): Promise<void> {
  if (!existsSync(CLASSIC_BOT_PATH)) return;
  const ans = await rl.question(`\n  classicBot.yaml found. Add allowed guilds? [y/N] `);
  if (ans.toLowerCase() !== "y") return;

  const config = yaml.load(readFileSync(CLASSIC_BOT_PATH, "utf-8")) as Record<string, any>;
  const guilds: string[] = ((config as any)?.defaults?.allowed_guilds ?? []).map(String);
  console.log(`  Current allowed guilds: ${guilds.join(", ") || "(none)"}`);

  // Try to list guilds from Discord API using bot token from .env
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

  // Manual entry fallback
  while (true) {
    const gid = (await rl.question("  Add guild ID manually (Enter to finish): ")).trim();
    if (!gid) break;
    if (guilds.includes(gid)) { console.log(`  Already in list.`); continue; }
    guilds.push(gid);
    console.log(`  ${green("✓")} Added: ${gid}`);
  }
  ((config as any).defaults ??= {}).allowed_guilds = guilds;
  writeFileSync(CLASSIC_BOT_PATH, `# ClassicBot Configuration\n${yaml.dump(config, { quotingType: '"', forceQuotes: false })}`);
  console.log(`  ${green("✓")} Updated ${CLASSIC_BOT_PATH}`);
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

// ── Main ─────────────────────────────────────────────────

export async function runQuickstart(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    console.log(`\n${bold("═══ AgEnD Quickstart ═══")}\n`);

    // Check fleet.pid conflict
    if (existsSync(join(DATA_DIR, "fleet.pid"))) {
      console.error("Fleet is already running. Stop it first: agend fleet stop");
      process.exit(1);
    }

    // Check existing config
    if (existsSync(FLEET_CONFIG_PATH)) {
      console.log(`  ${yellow("fleet.yaml already exists.")} What would you like to do?`);
      console.log("    1. Add allowed users");
      console.log("    2. Overwrite (start fresh)");
      console.log("    3. Skip");
      const action = (await rl.question("  Choose [3]: ")).trim();

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

        await maybeAddClassicBotGuilds(rl);
        console.log(`\n${bold("═══ Done ═══")}\n`);
        return;
      }

      if (action !== "2") {
        // Skip (default)
        await maybeAddClassicBotGuilds(rl);
        console.log(`\n${bold("═══ Done ═══")}\n`);
        return;
      }
      // action === "2" → fall through to full setup
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
    const chChoice = await rl.question(`  Choose [1]: `);
    const channel = chChoice.trim() === "2" ? "discord" : "telegram";
    console.log(`  ${green("✓")} ${channel}\n`);

    let token = "";
    let botUsername = "";
    let groupId = "";
    let userId = "";
    let tokenEnvName = "";
    let generalChannelId = "";

    if (channel === "telegram") {
      // ── Telegram flow ──────────────────────────────────

      console.log(bold("Step 3/4: Telegram Bot"));
      console.log(`  1. Open BotFather: ${dim("https://t.me/BotFather")}`);
      console.log(`  2. Send /newbot and pick a name`);
      console.log(`  3. Copy the token\n`);

      tokenEnvName = "AGEND_BOT_TOKEN";
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

      console.log(bold("Step 4/4: Group & User ID"));
      console.log(`  Add @${botUsername} to a Telegram group, then send /start in the group.\n`);

      const detected = await detectGroupAndUser(token);
      groupId = String(detected.groupId);
      userId = String(detected.userId);
      console.log(`  ${green("✓")} Group: ${groupId} | User: ${userId}\n`);

    } else {
      // ── Discord flow ───────────────────────────────────

      console.log(bold("Step 3/4: Discord Bot"));
      console.log(`  1. Go to Discord Developer Portal: ${dim("https://discord.com/developers/applications")}`);
      console.log(`  2. New Application → Bot → Reset Token → Copy`);
      console.log(`  3. Enable ${bold("Message Content Intent")} under Bot → Privileged Gateway Intents\n`);

      tokenEnvName = "AGEND_DISCORD_TOKEN";
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

      console.log(bold("Step 4/4: Guild & User ID"));

      // Auto-detect guilds
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
      userId = (await rl.question("  Paste your User ID: ")).trim();
      console.log(`  ${green("✓")} User: ${userId}\n`);

      console.log(`  To get a Channel ID for the General channel:`);
      console.log(`  Right-click the text channel → ${bold("Copy Channel ID")}\n`);
      generalChannelId = (await rl.question("  Paste General Channel ID (optional, Enter to skip): ")).trim();
      if (generalChannelId) {
        console.log(`  ${green("✓")} General Channel: ${generalChannelId}\n`);
      } else {
        console.log(`  ${dim("Skipped")}\n`);
      }
    }

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

    // Quote IDs that may be snowflakes (Discord 64-bit)
    const qGid = groupId.length >= 16 ? `"${groupId}"` : groupId;
    const qUid = userId.length >= 16 ? `"${userId}"` : userId;

    const fleetYaml = [
      "channel:",
      `  type: ${channel}`,
      "  mode: topic",
      `  bot_token_env: ${tokenEnvName}`,
      `  group_id: ${qGid}`,
      "  access:",
      "    mode: locked",
      "    allowed_users:",
      `      - ${qUid}`,
      ...(generalChannelId ? [
        "  options:",
        `    general_channel_id: "${generalChannelId}"`,
      ] : []),
      "",
      ...(projectRoots.length > 0
        ? ["project_roots:", ...projectRoots.map(p => `  - ${p}`), ""]
        : []),
      "defaults:",
      `  backend: ${backend}`,
      "",
    ].join("\n");

    writeFileSync(FLEET_CONFIG_PATH, fleetYaml);
    console.log(`\n  ${green("✓")} ${FLEET_CONFIG_PATH}`);

    // .env contains the bot token — restrict to owner-only read/write so a
    // multi-user system (or a curious sibling process) can't grab it.
    writeFileSync(ENV_PATH, `${tokenEnvName}=${token}\n`, { mode: 0o600 });
    // writeFileSync's mode is only honoured when the file did not previously
    // exist; chmod the realised file to cover the overwrite case as well.
    try { chmodSync(ENV_PATH, 0o600); } catch { /* best-effort on Windows */ }
    console.log(`  ${green("✓")} ${ENV_PATH}`);

    // ── ClassicBot setup (Discord only) ──────────────────

    const classicPath = join(DATA_DIR, "classicBot.yaml");
    if (channel === "discord" && existsSync(classicPath)) {
      await maybeAddClassicBotGuilds(rl);
    } else if (channel === "discord") {
      const setupClassic = await rl.question(`\n  Set up ClassicBot? (allows /start in any channel) [Y/n] `);
      if (setupClassic.toLowerCase() !== "n") {
        // Allowed guilds — primary guild pre-filled
        const allowedGuilds: string[] = [groupId];
        console.log(`  ${green("✓")} Primary guild added: ${groupId}`);
        while (true) {
          const more = (await rl.question(`  Add another guild ID? (Enter to skip): `)).trim();
          if (!more) break;
          allowedGuilds.push(more);
          console.log(`  ${green("✓")} Added: ${more}`);
        }

        // Default backend
        const cbBackend = (await rl.question(`  Default backend [${backend}]: `)).trim() || backend;

        const classicConfig = {
          defaults: {
            backend: cbBackend,
            allowed_guilds: allowedGuilds,
          },
        };

        writeFileSync(classicPath, `# ClassicBot Configuration\n${yaml.dump(classicConfig, { quotingType: '"', forceQuotes: false })}`);
        console.log(`  ${green("✓")} ${classicPath}`);
      }
    }

    // ── Next steps ───────────────────────────────────────

    console.log(`\n${bold("═══ Setup Complete ═══")}\n`);
    if (channel === "discord") {
      console.log("  Next steps:");
      console.log(`    1. ${bold("npm install -g @suzuke/agend-plugin-discord")}`);
      console.log(`    2. ${dim("(Optional)")} Edit ~/.agend/fleet.yaml to customize`);
      console.log(`    3. ${bold("agend fleet start")}`);
      console.log(`    4. Talk to ${botUsername} in your Discord server`);
      console.log(`\n  ${dim("Classic Bot Mode: Use /start in any Discord channel to start an agent. Use /chat to talk.")}\n`);
    } else {
      console.log("  Next steps:");
      console.log(`    1. ${dim("(Optional)")} Edit ~/.agend/fleet.yaml to customize`);
      console.log(`    2. ${bold("agend fleet start")}`);
      console.log(`    3. Talk to @${botUsername} in your Telegram group\n`);
    }
  } finally {
    rl.close();
  }
}

/**
 * M-3770 slice 2.3 (design update-transaction §5.1): what the update's snapshot covers, and who writes what.
 *
 * - **The scope** is an exclude list: every path in the home is included except these. `classify(rel)` answers for a
 *   path relative to the home (POSIX separators).
 * - **The writer inventory** lists every name the code writes under the home or outside it, with its **phase**:
 *   `pre-commit` (fleet startup in trial mode, migrations, the update and rollback themselves) or `post-commit` (agent
 *   launch, CLI activity, ordinary operation). A test scans the code's path literals and fails when one isn't listed.
 * - **Eligibility** for the transaction's automatic rollback (§5.1 rev 8): no pre-commit writer may touch excluded user
 *   state, a path outside the home that the transaction doesn't restore itself (the unit and package preimages, §6.3),
 *   or an excluded cache that an older build would refuse rather than rebuild (`olderBuildRebuilds`). Runtime files and
 *   logs are meaningless after a restore and don't count.
 */

/** Why a path is left out of the snapshot. */
export type ExcludeKind =
  | "journal"      // the transaction's own state
  | "user-state"   // what agents and CLIs own; a pre-commit write here could not be rolled back
  | "cache"        // rebuildable
  | "log"          // history, never restored
  | "runtime"      // process state: pids, locks, sockets, tokens, tmux
  | "lease";       // the CLI state lease: its locks live on that inode (§5.1 rev 5)

interface Rule { match: (rel: string) => boolean; kind: ExcludeKind; rule: string }

const under = (dir: string) => (rel: string) => rel === dir || rel.startsWith(`${dir}/`);
const exactly = (...names: string[]) => (rel: string) => names.includes(rel);
const base = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);

/** §5.1's exclude list. Order doesn't matter: a path excluded by any rule is excluded. */
export const EXCLUDED: readonly Rule[] = [
  { rule: ".update-journal/", kind: "journal", match: under(".update-journal") },
  { rule: "update-in-progress.json", kind: "journal", match: exactly("update-in-progress.json") },
  { rule: "workspaces/", kind: "user-state", match: under("workspaces") },
  { rule: "credential-profiles/", kind: "user-state", match: under("credential-profiles") },
  { rule: "cx/", kind: "user-state", match: under("cx") },
  // muse's isolated XDG home per instance (backend/muse.ts): links into the user's ~/.config — the CLI's own config
  // home, the same kind as cx/ and credential-profiles/ (Fable #4523 F3).
  { rule: "instances/*/muse-xdg/", kind: "user-state", match: rel => /^instances\/[^/]+\/muse-xdg(\/|$)/.test(rel) },
  { rule: "cache/", kind: "cache", match: under("cache") },
  { rule: "cache-codex-rollouts.json, usage-last-good.json", kind: "cache", match: exactly("cache-codex-rollouts.json", "usage-last-good.json") },
  { rule: "search.db*", kind: "cache", match: rel => !rel.includes("/") && rel.startsWith("search.db") },
  { rule: "*.log", kind: "log", match: rel => base(rel).endsWith(".log") },
  { rule: "profiles/", kind: "log", match: under("profiles") },
  { rule: "tmux/, operator/", kind: "runtime", match: rel => under("tmux")(rel) || under("operator")(rel) },
  { rule: "*.sock", kind: "runtime", match: rel => base(rel).endsWith(".sock") },
  { rule: "fleet.pid, fleet.lock (+ its reclaim/handoff/tmp files)", kind: "runtime", match: rel => rel === "fleet.pid" || rel === "fleet.lock" || rel.startsWith("fleet.lock.") },
  { rule: ".update.lock, .service.lock (+ reclaim markers)", kind: "runtime", match: rel => /^\.(update|service)\.lock(\.reclaim)?$/.test(rel) },
  { rule: "tunnel.lease, web.token, view.token", kind: "runtime", match: exactly("tunnel.lease", "web.token", "view.token") },
  { rule: ".state-lease.sqlite (+ -journal)", kind: "lease", match: exactly(".state-lease.sqlite", ".state-lease.sqlite-journal") },
];

export type Classified = { included: true } | { included: false; kind: ExcludeKind; rule: string };

/** §5.1: is `rel` (relative to the home, `/`-separated, no leading `./`) in the snapshot's scope? */
export function classify(rel: string): Classified {
  if (rel === "" || rel.startsWith("/") || rel.split("/").some(p => p === "" || p === "." || p === "..")) throw new Error(`not a relative path in the home: ${JSON.stringify(rel)}`);
  for (const r of EXCLUDED) if (r.match(rel)) return { included: false, kind: r.kind, rule: r.rule };
  return { included: true };
}

export type Phase = "pre-commit" | "post-commit";
export interface Writer {
  /** Home: the top-level name under the home. Outside: the path relative to the user's home directory. */
  path: string;
  where: "home" | "outside";
  phase: Phase;
  /** Who writes it (module or role), for the reader. */
  by: string;
  /** Outside paths the transaction restores itself (§6.3). */
  restoredBy?: "unit-preimage" | "package-preimage";
  /**
   * An excluded cache written before commit: an older build that finds it rebuilds or ignores it (a schema it doesn't
   * know, an unknown shape) rather than refusing to start. Required for any pre-commit cache writer (§5.1 rev 8).
   */
  olderBuildRebuilds?: true;
}

const home = (path: string, phase: Phase, by: string, extra: Pick<Writer, "olderBuildRebuilds"> = {}): Writer => ({ path, where: "home", phase, by, ...extra });
const outside = (path: string, phase: Phase, by: string, restoredBy?: Writer["restoredBy"]): Writer => ({ path, where: "outside", phase, by, ...(restoredBy ? { restoredBy } : {}) });

/**
 * The writer inventory (§5.1). Home names are top-level entries under the home. Names reached only through a helper
 * that takes the home as a parameter (no literal join over a home root) are listed by hand, marked "via <helper>". The test
 * `update-snapshot-scope-m3770` scans the code's `join` calls over a home root (or over the user's home directory) with a
 * literal name, and fails when a name is missing here: a new path is classified before it ships.
 */
export const WRITER_INVENTORY: readonly Writer[] = [
  // ── Fleet startup and migrations (pre-commit: the trial fleet starts before commit) ──
  home("fleet.yaml", "pre-commit", "config load and migrations (fleet-yaml-patch, cli)"),
  home("fleet.pid", "pre-commit", "fleet start"),
  home("fleet.lock", "pre-commit", "fleet start (fleet-lock)"),
  home("fleet.lock.reclaim", "pre-commit", "fleet-lock's reclaim marker (the update's owned re-take of a dead holder)"),
  home("fleet.log", "pre-commit", "fleet logger"),
  home("fleet-fatal.log", "pre-commit", "fleet fatal handler"),
  home("daemon.log", "pre-commit", "daemon logger"),
  home("update.log", "pre-commit", "agend update"),
  home("update-in-progress.json", "pre-commit", "agend update (marker)"),
  home("events.db", "pre-commit", "event log (opened at start)"),
  home("scheduler.db", "pre-commit", "scheduler (opened at start; CLI under the state lease)"),
  home("delivery-outbox.db", "pre-commit", "delivery outbox (opened at start)"),
  home("profiles.db", "pre-commit", "web profiles (opened at start)"),
  home("reply-buttons.db", "pre-commit", "reply buttons (opened at start)"),
  home("instances", "pre-commit", "instance state at start (instances/<name>/…)"),
  home("tmux", "pre-commit", "private tmux server"),
  home("tmux-migration.json", "pre-commit", "tmux migration"),
  home("operator", "pre-commit", "operator socket"),
  home("web.token", "pre-commit", "web server start"),
  home("view.token", "pre-commit", "web server start"),
  home("tunnel.lease", "pre-commit", "tunnel at start"),
  home("cli-env", "pre-commit", "CLI environment files at start"),
  home("hub-member", "pre-commit", "Hub member state at start"),
  home("hub-member-invalidate.pending", "pre-commit", "Hub member invalidation"),
  home("kiro-v3", "pre-commit", "kiro engine at start"),
  home("kiro-engine-ledger.json", "pre-commit", "kiro engine at start"),
  home("kiro-identity", "pre-commit", "kiro engine identity"),
  home(".update-journal", "pre-commit", "the update transaction"),
  home("host-monitoring.sqlite", "pre-commit", "host monitoring (a SQLite database opened at fleet start; §5.3 treats it as one)"),
  home("rollback.json", "pre-commit", "tmux migration rollback (tmux-rollback)"),
  home("kiro-classic-archives", "pre-commit", "kiro classic migration (kiro-classic-archive, kiro-migration-verify)"),
  home("kiro-reconciliations", "pre-commit", "kiro reconcile store"),
  home("search.db", "pre-commit", "search index (startSearchIndex at fleet start); another schema → rebuilt (search-store meta.schema)", { olderBuildRebuilds: true }),
  home("cache-codex-rollouts.json", "pre-commit", "cache service's codex rollout metadata; unknown entries are skipped (cache-service)", { olderBuildRebuilds: true }),
  home("usage-last-good.json", "pre-commit", "usage last-good rows; another version or shape is ignored (usage-api loadLastGood)", { olderBuildRebuilds: true }),
  // ── Ordinary operation (post-commit) ──
  home("workspaces", "post-commit", "agent launch (the agents' working directories)"),
  home("credential-profiles", "post-commit", "agent launch (the CLIs' homes, each profile's .claude.json)"),
  home("cx", "post-commit", "codex backend at agent launch"),
  home("instances/*/muse-xdg", "post-commit", "muse backend at agent launch (its isolated XDG home: links into ~/.config)"),
  home("cache", "post-commit", "caches"),

  home("usage-quota-history.jsonl", "post-commit", "usage"),
  home("quota-notices.json", "post-commit", "usage notices"),

  home("profiles", "post-commit", "CPU profiles"),
  home("access", "post-commit", "channel access lists"),
  home("inbox", "post-commit", "attachments inbox"),
  home("avatars", "post-commit", "web avatars"),
  home("cards", "post-commit", "web cards"),
  home("archived-topics.json", "post-commit", "topic archive"),
  home("backend-signin-pending.json", "post-commit", "backend sign-in"),
  home("bin", "post-commit", "cloudflared install"),
  home(".env", "post-commit", "quickstart settings"),
  home("classicBot.yaml", "post-commit", "ClassicBot"),
  home("credential-vault", "post-commit", "credential vault"),
  home("delivery-audit", "post-commit", "delivery audit"),
  home("forged-envelope-reports.json", "post-commit", "envelope reports"),
  home("hub-assistant", "post-commit", "Hub room assistant"),
  home("hub-classic-private.json", "post-commit", "Hub ClassicBot sharing"),
  home("hub-contact-windows.json", "post-commit", "Hub contact windows"),
  home("pending-owner-notices.json", "post-commit", "owner notices"),
  home("skipped-skills.json", "post-commit", "skill sync"),
  home("web-app-icon", "post-commit", "web settings"),
  home("web-authority.json", "post-commit", "web sign-in"),
  home("web-authorizations.json", "post-commit", "web sign-in"),
  home("web-devices.json", "post-commit", "web sign-in"),
  home("web-host-authorized", "post-commit", "web host"),
  home("web-mods", "post-commit", "web mods"),
  home("web-mods.json", "post-commit", "web mods"),
  home("web-office-skins", "post-commit", "web office"),
  home("web-offices.json", "post-commit", "web office"),
  home("web-owner-css", "post-commit", "web theme"),
  home("web-pins.json", "post-commit", "web pins"),
  home("web-sessions.json", "post-commit", "web sessions"),
  home("web-themes", "post-commit", "web themes"),
  home("web-themes.json", "post-commit", "web themes"),
  home("needs-you-message.json", "post-commit", "Needs-you hub"),
  home("agy-statusline.sh", "post-commit", "antigravity backend at agent launch"),
  home("shared", "post-commit", "web office packs (web-office-pack-read; its stateDir is the home)"),
  home("signin-launch", "post-commit", "web sign-in links — via web-signin-link's join over the home it is passed (cli.ts passes DATA_DIR)"),
  // ── Outside the home ──
  outside(".claude.json", "post-commit", "claude-code backend at agent launch (trust, onboarding); $CLAUDE_CONFIG_DIR/.claude.json when set"),
  outside(".claude", "post-commit", "claude-code backend and usage at agent launch"),
  outside(".codex", "post-commit", "codex backend at agent launch"),
  outside(".gemini", "post-commit", "gemini profiles at agent launch"),
  outside(".grok", "post-commit", "grok backend at agent launch"),
  outside(".kiro", "post-commit", "kiro backend at agent launch"),
  outside(".local", "post-commit", "backend CLIs' data at agent launch"),
  outside("AppData", "post-commit", "Windows pane stdio"),
  outside(".agend", "pre-commit", "the default AgEnD home itself (paths.ts) — the home, not outside it"),
  outside(".config", "pre-commit", "the systemd user unit (service-installer)", "unit-preimage"),
  outside("Library", "pre-commit", "the launchd agent plist (service-installer)", "unit-preimage"),
  outside(".npm-global", "pre-commit", "the npm prefix (the install itself)", "package-preimage"),
  outside(".nvm", "pre-commit", "nvm's Node prefix (the install itself)", "package-preimage"),
];

export type Eligibility = { ok: true } | { ok: false; offenders: Writer[] };

/**
 * §5.1 eligibility (rev 8): no pre-commit writer touches excluded user state, an outside path the transaction doesn't
 * restore itself, or an excluded cache an older build wouldn't rebuild. Runtime files and logs don't count. (The
 * default home under `~/.agend` is the home, so it's judged as a home path.)
 */
export function rollbackEligible(inventory: readonly Writer[] = WRITER_INVENTORY): Eligibility {
  const offenders = inventory.filter(w => {
    if (w.phase !== "pre-commit") return false;
    if (w.where === "outside") return w.path !== ".agend" && !w.restoredBy;
    const c = classify(w.path);
    if (c.included) return false;
    if (c.kind === "user-state") return true;
    return c.kind === "cache" && !w.olderBuildRebuilds;          // an older build must rebuild it, never refuse it
  });
  return offenders.length ? { ok: false, offenders } : { ok: true };
}

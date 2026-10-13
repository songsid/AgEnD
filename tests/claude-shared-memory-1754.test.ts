/**
 * #1754: a named Claude credential profile is its own `projects/`, so Claude Code's auto-memory for the project would
 * start empty there and stay apart from every other instance's. Memory is knowledge, not an account — shared like the
 * instructions and skills (#1699 (a)): at a profile launch `<profile>/projects/<repo key>/memory` links to the shared
 * `<~/.claude>/projects/<repo key>/memory`. The key is the repository's root (a worktree's main checkout), as claude
 * keys memory. Never replaces anything real; no profile is today's launch, byte for byte.
 *
 * Scratch AGEND_HOME and HOME, the real ClaudeCodeBackend.buildCommand; nothing starts a CLI or a fleet.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeBackend, claudeMemoryRoot, claudeProjectKey, linkSharedClaudeMemory } from "../src/backend/claude-code.js";
import { credentialProfileHome } from "../src/backend/credential-profile.js";
import { carryClaudeConversation } from "../src/backend/claude-carry.js";

const ENV = ["AGEND_HOME", "HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};
let root: string, agendHome: string, home: string, inst: string, repo: string;

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  root = realpathSync(mkdtempSync(join(tmpdir(), "agend-1754-")));
  agendHome = join(root, "agend"); home = join(root, "home"); inst = join(root, "inst"); repo = join(root, "repo");
  for (const d of [agendHome, home, inst, join(repo, ".git"), join(repo, "src", "deep")]) mkdirSync(d, { recursive: true });
  process.env.AGEND_HOME = agendHome; process.env.HOME = home;
  for (const k of ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const backend = () => { const b = new ClaudeCodeBackend(inst); (b as any).binaryPath = "/usr/bin/claude"; return b; };
const cfg = (workingDirectory: string, backendOptions?: Record<string, unknown>) =>
  ({ workingDirectory, instanceDir: inst, instanceName: "w", mcpServers: {}, skipPermissions: true, ...(backendOptions ? { backendOptions } : {}) }) as any;
const profile = (p = "team") => credentialProfileHome(agendHome, "claude-code", p);
const sharedMemory = (key: string) => join(home, ".claude", "projects", key, "memory");
const profileMemory = (key: string, p = "team") => join(profile(p), "projects", key, "memory");
/** A git worktree of `repo` at `dir`, laid out as git leaves it (`.git` file → worktree gitdir → commondir). */
function worktree(dir: string, name = "wt") {
  const gitdir = join(repo, ".git", "worktrees", name);
  mkdirSync(gitdir, { recursive: true }); mkdirSync(dir, { recursive: true });
  writeFileSync(join(gitdir, "commondir"), "../..\n");
  writeFileSync(join(dir, ".git"), `gitdir: ${gitdir}\n`);
}
const linkOf = (p: string) => (lstatSync(p).isSymbolicLink() ? readlinkSync(p) : "not a link");

describe("the memory key is the repository's root — as claude keys it", () => {
  it("a subdirectory of a repo → the repo; a worktree (and its subdirectory) → the main checkout; outside any repo → itself", () => {
    const wt = join(root, "repo-wt");
    worktree(wt); mkdirSync(join(wt, "pkg"));
    const plain = join(root, "plain", "dir"); mkdirSync(plain, { recursive: true });
    expect([claudeMemoryRoot(join(repo, "src", "deep")), claudeMemoryRoot(repo), claudeMemoryRoot(wt), claudeMemoryRoot(join(wt, "pkg")), claudeMemoryRoot(plain)])
      .toEqual([repo, repo, repo, repo, plain]);
  });
});

describe("a profile launch links the project's memory to the shared one", () => {
  it("from a repo's subdirectory: <profile>/projects/<repo key>/memory → the shared memory (created); a note written there is the shared note", () => {
    backend().buildCommand(cfg(join(repo, "src", "deep"), { credential_profile: "team" }));
    const key = claudeProjectKey(repo);
    writeFileSync(join(profileMemory(key), "MEMORY.md"), "- a shared fact\n");
    expect([linkOf(profileMemory(key)), readFileSync(join(sharedMemory(key), "MEMORY.md"), "utf8")]).toEqual([sharedMemory(key), "- a shared fact\n"]);
  });

  it("from a worktree: the main checkout's key — the memory every worktree of the repo shares", () => {
    const wt = join(root, "repo-wt"); worktree(wt);
    mkdirSync(sharedMemory(claudeProjectKey(repo)), { recursive: true });
    writeFileSync(join(sharedMemory(claudeProjectKey(repo)), "MEMORY.md"), "157 notes\n");
    backend().buildCommand(cfg(wt, { credential_profile: "team" }));
    expect([readFileSync(join(profileMemory(claudeProjectKey(repo)), "MEMORY.md"), "utf8"), existsSync(profileMemory(claudeProjectKey(wt)))]).toEqual(["157 notes\n", false]);
  });

  it("an empty memory folder (what claude makes before it writes) gives way to the link; a second launch leaves the link as it is", () => {
    const key = claudeProjectKey(repo);
    mkdirSync(profileMemory(key), { recursive: true });
    const first = linkSharedClaudeMemory(profile(), repo, join(home, ".claude"));
    const again = linkSharedClaudeMemory(profile(), repo, join(home, ".claude"));
    expect([first, again, linkOf(profileMemory(key))]).toEqual(["linked", "already-linked", sharedMemory(key)]);
  });

  it("review r1: our link pointing at a shared folder that is not there (linked early, or the folder removed): the folder is made — by the helper and by a launch — and a note lands", () => {
    const key = claudeProjectKey(repo);
    mkdirSync(join(profile(), "projects", key), { recursive: true });
    symlinkSync(sharedMemory(key), profileMemory(key), "dir");
    const direct = linkSharedClaudeMemory(profile(), repo, join(home, ".claude"));
    const madeByHelper = existsSync(sharedMemory(key));
    rmSync(join(home, ".claude"), { recursive: true, force: true });                       // the shared side removed again
    backend().buildCommand(cfg(repo, { credential_profile: "team" }));
    writeFileSync(join(profileMemory(key), "MEMORY.md"), "- lands\n");
    expect([direct, madeByHelper, linkOf(profileMemory(key)), readFileSync(join(sharedMemory(key), "MEMORY.md"), "utf8")])
      .toEqual(["already-linked", true, sharedMemory(key), "- lands\n"]);
  });

  it("review r1: our link, but a file where the shared folder should be: reported as failed (and said so), the link kept", () => {
    const key = claudeProjectKey(repo);
    mkdirSync(join(home, ".claude", "projects", key), { recursive: true });
    writeFileSync(sharedMemory(key), "a file, not a folder");
    mkdirSync(join(profile(), "projects", key), { recursive: true });
    symlinkSync(sharedMemory(key), profileMemory(key), "dir");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect([linkSharedClaudeMemory(profile(), repo, join(home, ".claude")), linkOf(profileMemory(key)), warn.mock.calls.length > 0]).toEqual(["failed", sharedMemory(key), true]);
  });

  it("the profile's own non-empty memory is never replaced — left as it is, and said so", () => {
    const key = claudeProjectKey(repo);
    mkdirSync(profileMemory(key), { recursive: true });
    writeFileSync(join(profileMemory(key), "MEMORY.md"), "the profile's own\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    backend().buildCommand(cfg(repo, { credential_profile: "team" }));
    const direct = linkSharedClaudeMemory(profile(), repo, join(home, ".claude"));
    expect([direct, linkOf(profileMemory(key)), readFileSync(join(profileMemory(key), "MEMORY.md"), "utf8"), existsSync(sharedMemory(key)),
      warn.mock.calls.some((c) => String(c[0]).includes(profileMemory(key)))]).toEqual(["kept-own", "not a link", "the profile's own\n", false, true]);
  });

  it("a link somewhere else is the user's choice: kept; a file in the way is kept; neither stops the launch", () => {
    const key = claudeProjectKey(repo), elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere); mkdirSync(join(profile(), "projects", key), { recursive: true });
    symlinkSync(elsewhere, profileMemory(key), "dir");
    const other = linkSharedClaudeMemory(profile(), repo, join(home, ".claude"));
    const key2 = claudeProjectKey(join(root, "plain2")); mkdirSync(join(root, "plain2"));
    mkdirSync(join(profile(), "projects", key2), { recursive: true }); writeFileSync(profileMemory(key2), "a file");
    const file = linkSharedClaudeMemory(profile(), join(root, "plain2"), join(home, ".claude"));
    const cmd = backend().buildCommand(cfg(repo, { credential_profile: "team" }));
    expect([other, linkOf(profileMemory(key)), existsSync(sharedMemory(key)), file, readFileSync(profileMemory(key2), "utf8"), cmd.includes("CLAUDE_CONFIG_DIR=")])
      .toEqual(["kept-other-link", elsewhere, false, "kept-own", "a file", true]);
  });

  it("a link that cannot be made is reported, and the launch goes on", () => {
    const key = claudeProjectKey(repo);
    mkdirSync(profile(), { recursive: true }); writeFileSync(join(profile(), "projects"), "not a folder");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = linkSharedClaudeMemory(profile(), repo, join(home, ".claude"));
    expect([res, warn.mock.calls.length > 0, existsSync(profileMemory(key))]).toEqual(["failed", true, false]);
  });

  it("the fleet's own CLAUDE_CONFIG_DIR is the shared side, as for the instructions and skills", () => {
    const fleetConfig = join(root, "fleet-claude"); process.env.CLAUDE_CONFIG_DIR = fleetConfig;
    backend().buildCommand(cfg(repo, { credential_profile: "team" }));
    expect(linkOf(profileMemory(claudeProjectKey(repo)))).toBe(join(fleetConfig, "projects", claudeProjectKey(repo), "memory"));
  });
});

describe("no profile: today's launch, nothing linked or created", () => {
  it("the launch command is byte-identical and the shared config gets no projects/ entry", () => {
    const TODAY = `CMUX_CLAUDE_HOOKS_DISABLED=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 /usr/bin/claude --settings ${inst}/claude-settings.json --mcp-config ${inst}/mcp-config.json --dangerously-skip-permissions`;
    const cmd = backend().buildCommand(cfg(repo));
    expect([cmd, existsSync(join(home, ".claude", "projects")), existsSync(join(agendHome, "credential-profiles"))]).toEqual([TODAY, false, false]);
  });
});

describe("with #1753's conversation carry: transcripts move between profiles, the memory stays the one shared", () => {
  it("at the repo root (transcripts and memory in one projects/ folder): the carry copies the conversation, both profiles' memory is the same shared link", async () => {
    const key = claudeProjectKey(repo), SID = "0f8b0e1c-1a2b-4c3d-8e9f-0123456789ab";
    backend().buildCommand(cfg(repo, { credential_profile: "a" }));
    writeFileSync(join(profileMemory(key, "a"), "MEMORY.md"), "- one fact\n");
    writeFileSync(join(profile("a"), "projects", key, `${SID}.jsonl`), '{"type":"user"}\n');
    const carried = await carryClaudeConversation({ sessionId: SID, workingDirectory: repo, fromConfigDir: profile("a"), toConfigDir: profile("b"), freeBytes: async () => 1e12 });
    backend().buildCommand(cfg(repo, { credential_profile: "b" }));
    expect([carried.carried, readFileSync(join(profile("b"), "projects", key, `${SID}.jsonl`), "utf8"), linkOf(profileMemory(key, "a")), linkOf(profileMemory(key, "b")),
      readFileSync(join(profileMemory(key, "b"), "MEMORY.md"), "utf8"), readdirSync(sharedMemory(key))]).toEqual([true, '{"type":"user"}\n', sharedMemory(key), sharedMemory(key), "- one fact\n", ["MEMORY.md"]]);
  });
});

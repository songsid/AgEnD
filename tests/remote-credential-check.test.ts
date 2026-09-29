/**
 * #855/#963: GitHub credentials are removed from linked-worktree remote URLs.
 *
 * Every case calls the production detector (src/remote-credential-check.ts) or
 * the real InstanceLifecycle.handleCreate path; no parser or pattern is
 * duplicated here. All tokens are fake.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  EMBEDDED_CREDENTIAL_REMOTE_WARNING,
  GITHUB_TOKEN_PREFIXES,
  httpsUserinfo,
  remoteListHasEmbeddedGitHubToken,
  stripEmbeddedGitHubToken,
  urlHasEmbeddedGitHubToken,
} from "../src/remote-credential-check.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";

const FAKE = "FAKE0000000000000000000000000000";
const GIT_BIN = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();

describe("urlHasEmbeddedGitHubToken — each GitHub token form, on its own", () => {
  // One fixture per prefix, and no fixture carries a second prefix, so removing
  // any single prefix from GITHUB_TOKEN_PREFIXES fails exactly its own case.
  it.each([
    ["ghp_", `https://ghp_${FAKE}@github.com/acme/repo.git`],
    ["gho_", `https://gho_${FAKE}@github.com/acme/repo.git`],
    ["ghu_", `https://ghu_${FAKE}@github.com/acme/repo.git`],
    ["ghs_", `https://ghs_${FAKE}@github.com/acme/repo.git`],
    ["ghr_", `https://ghr_${FAKE}@github.com/acme/repo.git`],
    ["github_pat_", `https://github_pat_${FAKE}@github.com/acme/repo.git`],
  ])("flags a %s token used as the userinfo", (_prefix, url) => {
    expect(urlHasEmbeddedGitHubToken(url)).toBe(true);
  });

  it("covers exactly the documented GitHub prefixes", () => {
    expect([...GITHUB_TOKEN_PREFIXES]).toEqual(["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"]);
  });

  it("flags the GitHub App form x-access-token:<token>@ whatever the password looks like", () => {
    expect(urlHasEmbeddedGitHubToken("https://x-access-token:opaque-value@github.com/acme/repo.git")).toBe(true);
    expect(urlHasEmbeddedGitHubToken("https://X-Access-Token:opaque-value@github.com/acme/repo.git")).toBe(true);
  });

  it("does not flag x-access-token as a bare username: a credential helper supplies the token", () => {
    expect(urlHasEmbeddedGitHubToken("https://x-access-token@github.com/acme/public.git")).toBe(false);
    expect(urlHasEmbeddedGitHubToken("https://x-access-token:@github.com/acme/public.git")).toBe(false);
    // An encoded @ keeps this one username (`x-access-token@ci-user`), no password.
    expect(urlHasEmbeddedGitHubToken("https://x-access-token%40ci-user@github.com/acme/repo.git")).toBe(false);
    expect(remoteListHasEmbeddedGitHubToken(
      "origin\thttps://x-access-token%40ci-user@github.com/acme/repo.git (fetch)\n",
    )).toBe(false);
  });

  it("flags a token in the password position and a percent-encoded separator", () => {
    expect(urlHasEmbeddedGitHubToken(`https://oauth2:ghp_${FAKE}@github.com/acme/repo.git`)).toBe(true);
    expect(urlHasEmbeddedGitHubToken(`https://x-access-token%3Aghs_${FAKE}@github.com/acme/repo.git`)).toBe(true);
  });

  it("strips only GitHub HTTPS userinfo and never returns a token in a repair URL", () => {
    expect(stripEmbeddedGitHubToken(`https://x-access-token:ghp_${FAKE}@github.com/acme/repo.git`))
      .toBe("https://github.com/acme/repo.git");
    expect(stripEmbeddedGitHubToken(`https://ghp_${FAKE}@github.com/acme/repo.git`))
      .toBe("https://github.com/acme/repo.git");
    expect(stripEmbeddedGitHubToken(`https://ghp_${FAKE}@git.example.com/acme/repo.git`)).toBeNull();
    expect(stripEmbeddedGitHubToken("https://github.com/acme/repo.git")).toBeNull();
  });

  it("flags a token inside a multi-@ userinfo: git sends everything before the last @", () => {
    expect(httpsUserinfo(`https://user@ghp_${FAKE}@github.com/acme/repo.git`)).toBe(`user@ghp_${FAKE}`);
    expect(urlHasEmbeddedGitHubToken(`https://user@ghp_${FAKE}@github.com/acme/repo.git`)).toBe(true);
  });

  it("is case-insensitive on the scheme only", () => {
    expect(urlHasEmbeddedGitHubToken(`HTTPS://ghp_${FAKE}@github.com/acme/repo.git`)).toBe(true);
    expect(urlHasEmbeddedGitHubToken(`http://ghp_${FAKE}@git.example.com/acme/repo.git`)).toBe(true);
  });
});

describe("urlHasEmbeddedGitHubToken — never a false positive outside the userinfo", () => {
  it.each([
    ["no userinfo", "https://github.com/acme/repo.git"],
    ["plain username", "https://alice@github.com/acme/repo.git"],
    ["username merely containing a prefix", "https://myghp_user@github.com/acme/repo.git"],
    ["token-like path segment", `https://github.com/acme/ghp_${FAKE}.git`],
    ["token-like path segment followed by @", `https://github.com/acme/ghp_${FAKE}@v2/repo.git`],
    // A `:` or `@` right before the lookalike would make it its own userinfo
    // component if the authority were not cut at the first `/`, `?` or `#`.
    ["path with user:token@ shape", `https://github.com/acme/a:ghp_${FAKE}@v2/repo.git`],
    ["query with user:token@ shape", `https://github.com/acme/repo.git?t=a:ghp_${FAKE}@x`],
    ["fragment with user:token@ shape", `https://github.com/acme/repo.git#a:ghp_${FAKE}@x`],
    ["query with @token@ shape", `https://github.com/acme/repo.git?a@ghp_${FAKE}@x`],
    // No path at all, so only the `?` / `#` boundary stops the authority.
    ["query straight after the host", `https://github.com?t=a:ghp_${FAKE}@x`],
    ["fragment straight after the host", `https://github.com#a:ghp_${FAKE}@x`],
    ["token-like host after the last @", "https://alice@ghp_mirror.example.com/acme/repo.git"],
    ["x-access-token only in the path", "https://github.com/x-access-token/repo.git"],
  ])("does not flag %s", (_label, url) => {
    expect(urlHasEmbeddedGitHubToken(url)).toBe(false);
  });

  it.each([
    ["ssh:// URL (out of scope: key auth)", `ssh://ghp_${FAKE}@github.com/acme/repo.git`],
    ["scp-style remote", "git@github.com:acme/repo.git"],
    ["local path", "/srv/git/repo.git"],
  ])("leaves %s alone", (_label, url) => {
    expect(urlHasEmbeddedGitHubToken(url)).toBe(false);
  });
});

describe("remoteListHasEmbeddedGitHubToken — git remote -v output", () => {
  it("finds the one tokened remote among clean ones, fetch or push", () => {
    const clean = "origin\thttps://github.com/acme/repo.git (fetch)\norigin\thttps://github.com/acme/repo.git (push)\n";
    expect(remoteListHasEmbeddedGitHubToken(clean)).toBe(false);
    const pushOnly = `${clean}mirror\thttps://github.com/acme/mirror.git (fetch)\nmirror\thttps://x-access-token:ghs_${FAKE}@github.com/acme/mirror.git (push)\n`;
    expect(remoteListHasEmbeddedGitHubToken(pushOnly)).toBe(true);
    expect(remoteListHasEmbeddedGitHubToken("")).toBe(false);
  });

  it("keeps the advisory text free of any URL or token", () => {
    expect(EMBEDDED_CREDENTIAL_REMOTE_WARNING).not.toMatch(/https?:\/\//);
    for (const prefix of GITHUB_TOKEN_PREFIXES) expect(EMBEDDED_CREDENTIAL_REMOTE_WARNING).not.toContain(prefix);
  });
});

// ── Integration: the real handleCreate path, real git ───────────────────────

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(GIT_BIN, args, { cwd, encoding: "utf-8" });
}

function makeSourceRepo(remoteUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-963-src-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@test.invalid");
  git(dir, "config", "user.name", "AgEnD Test");
  writeFileSync(join(dir, "a.txt"), "init\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-qm", "init");
  git(dir, "remote", "add", "origin", remoteUrl);
  return dir;
}

function installFakeGitHubCredentialSetup(): { restore: () => void; home: string } {
  const home = mkdtempSync(join(tmpdir(), "agend-855-auth-"));
  dirs.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin);
  const fakeGh = join(bin, "gh");
  writeFileSync(fakeGh, [
    "#!/bin/sh",
    "if [ \"$1\" = auth ] && [ \"$2\" = setup-git ]; then",
    "  git config --global --replace-all credential.https://github.com.helper '!gh auth git-credential'",
    "  exit $?",
    "fi",
    "if [ \"$1\" = auth ] && [ \"$2\" = git-credential ]; then",
    "  printf 'username=gh-helper-user\\npassword=gh-helper-fake-credential\\n\\n'",
    "  exit 0",
    "fi",
    "exit 2",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(fakeGh, 0o700);
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousSystem = process.env.GIT_CONFIG_NOSYSTEM;
  const previousPath = process.env.PATH;
  process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}${delimiter}/usr/local/bin:/usr/bin:/bin`;
  return {
    home,
    restore: () => {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      if (previousSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = previousSystem;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    },
  };
}

function makeCtx(warn: ReturnType<typeof vi.fn>): LifecycleContext {
  return {
    fleetConfig: { instances: {}, defaults: {} },
    logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    dataDir: tmpdir(),
    routing: { resolve: vi.fn(() => undefined), register: vi.fn(), unregister: vi.fn() } as any,
    instanceIpcClients: new Map(),
    ipcStoppingInstances: new Set(),
    sessionRegistry: new Map(),
    eventLog: null,
    controlClient: null,
    getInstanceDir: (n: string) => join(tmpdir(), n),
    saveFleetConfig: vi.fn(),
    restartSingleInstance: vi.fn(async () => {}),
    connectIpcToInstance: vi.fn(async () => {}),
    createForumTopic: vi.fn(async () => "topic-1"),
    deleteForumTopic: vi.fn(async () => {}),
    setTopicIcon: vi.fn(),
    removeInstance: vi.fn(async () => {}),
    touchActivity: vi.fn(),
    sendHangNotification: vi.fn(async () => {}),
    notifyInstanceTopic: vi.fn(() => {}),
    notifyInteractivePrompt: vi.fn(async () => {}),
  } as unknown as LifecycleContext;
}

async function createWorktreeFrom(sourceDir: string) {
  const worktreePath = mkdtempSync(join(tmpdir(), "agend-963-wt-"));
  dirs.push(worktreePath);
  rmSync(worktreePath, { recursive: true });
  const warn = vi.fn();
  const respond = vi.fn();
  const lifecycle = new InstanceLifecycle(makeCtx(warn));
  lifecycle.start = vi.fn(async () => {});
  await lifecycle.handleCreate(
    { directory: sourceDir, branch: "feature-963", worktree_path: worktreePath, backend: "claude-code" },
    respond,
  );
  return { warn, worktreePath, response: respond.mock.calls[0] };
}

describe("handleCreate protects linked worktree remotes (real git)", () => {
  it("moves a global insteadOf token to the GitHub CLI helper before creating the worktree", async () => {
    const fakeAuth = installFakeGitHubCredentialSetup();
    try {
      const src = makeSourceRepo("https://github.com/acme/repo.git");
      // This isolated global rule models the credentialed effective URL from
      // the fleet without reading or changing the operator's real git config.
      git(src, "config", "--global", "--add", `url.https://x-access-token:ghs_${FAKE}@github.com/.insteadOf`, "https://github.com/");
      const { warn, worktreePath, response } = await createWorktreeFrom(src);
      expect(response?.[1]).toBeUndefined();
      expect(response?.[0]).toMatchObject({ success: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith({ repo: src }, EMBEDDED_CREDENTIAL_REMOTE_WARNING);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged.includes(FAKE)).toBe(false);
      expect(logged.includes("github.com")).toBe(false);

      for (const cwd of [src, worktreePath]) {
        const verbose = git(cwd, "remote", "-v");
        const origin = git(cwd, "config", "--get", "remote.origin.url");
        expect(verbose.includes(FAKE)).toBe(false);
        expect(origin.includes(FAKE)).toBe(false);
        expect(origin.trim()).toBe("https://github.com/acme/repo.git");
      }

      const filled = execFileSync(GIT_BIN, ["credential", "fill"], {
        cwd: src,
        encoding: "utf-8",
        input: "protocol=https\nhost=github.com\npath=acme/repo.git\n\n",
      });
      expect(filled.includes("password=gh-helper-fake-credential")).toBe(true);
      expect(filled.includes(FAKE)).toBe(false);
    } finally {
      fakeAuth.restore();
    }
  });

  it("strips a credential embedded directly in the raw origin URL", async () => {
    const fakeAuth = installFakeGitHubCredentialSetup();
    try {
      const src = makeSourceRepo(`https://x-access-token:ghp_${FAKE}@github.com/acme/repo.git`);
      const { warn, worktreePath, response } = await createWorktreeFrom(src);
      expect(response?.[0]).toMatchObject({ success: true });
      expect(warn).toHaveBeenCalledTimes(1);
      for (const cwd of [src, worktreePath]) {
        expect(git(cwd, "remote", "-v").includes(FAKE)).toBe(false);
        expect(git(cwd, "config", "--get", "remote.origin.url").includes(FAKE)).toBe(false);
      }
    } finally {
      fakeAuth.restore();
    }
  });

  it("stays silent for a clean remote and for a token-like path", async () => {
    for (const url of ["https://github.com/acme/repo.git", `https://github.com/acme/ghp_${FAKE}@v2/repo.git`]) {
      const { warn } = await createWorktreeFrom(makeSourceRepo(url));
      expect(warn).not.toHaveBeenCalled();
    }
  });
});

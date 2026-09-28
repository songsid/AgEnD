/**
 * #855/#963: advisory warning for GitHub tokens embedded in HTTPS remote URLs.
 *
 * Every case calls the production detector (src/remote-credential-check.ts) or
 * the real InstanceLifecycle.handleCreate path; no parser or pattern is
 * duplicated here. All tokens are fake.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EMBEDDED_CREDENTIAL_REMOTE_WARNING,
  GITHUB_TOKEN_PREFIXES,
  httpsUserinfo,
  remoteListHasEmbeddedGitHubToken,
  urlHasEmbeddedGitHubToken,
} from "../src/remote-credential-check.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";

const FAKE = "FAKE0000000000000000000000000000";

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
    expect(urlHasEmbeddedGitHubToken("https://X-Access-Token@github.com/acme/repo.git")).toBe(true);
  });

  it("flags a token in the password position and a percent-encoded separator", () => {
    expect(urlHasEmbeddedGitHubToken(`https://oauth2:ghp_${FAKE}@github.com/acme/repo.git`)).toBe(true);
    expect(urlHasEmbeddedGitHubToken(`https://x-access-token%3Aghs_${FAKE}@github.com/acme/repo.git`)).toBe(true);
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
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function makeSourceRepo(remoteUrl: string, insteadOf?: { base: string; rewrite: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-963-src-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@test.invalid");
  git(dir, "config", "user.name", "AgEnD Test");
  writeFileSync(join(dir, "a.txt"), "init\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-qm", "init");
  git(dir, "remote", "add", "origin", remoteUrl);
  // Repository-local, so the test never touches the user's ~/.gitconfig.
  if (insteadOf) git(dir, "config", `url.${insteadOf.rewrite}.insteadOf`, insteadOf.base);
  return dir;
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
  await new InstanceLifecycle(makeCtx(warn)).handleCreate(
    { directory: sourceDir, branch: "feature-963", worktree_path: worktreePath, backend: "claude-code" },
    vi.fn(),
  );
  return { warn };
}

describe("handleCreate advisory check (real git)", () => {
  it("warns when a url.insteadOf rewrite puts a token in the effective remote — the #855 mechanism", async () => {
    const src = makeSourceRepo("https://github.com/acme/repo.git", {
      base: "https://github.com/",
      rewrite: `https://x-access-token:ghs_${FAKE}@github.com/`,
    });
    const { warn } = await createWorktreeFrom(src);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ repo: src }, EMBEDDED_CREDENTIAL_REMOTE_WARNING);
    // The warning never echoes the credential or the URL.
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(FAKE);
    expect(logged).not.toContain("github.com");
    // Advisory only: neither the remote nor the rewrite was touched.
    expect(git(src, "config", "--get", "remote.origin.url").trim()).toBe("https://github.com/acme/repo.git");
    expect(git(src, "config", "--get", "url.https://x-access-token:ghs_" + FAKE + "@github.com/.insteadOf").trim())
      .toBe("https://github.com/");
  });

  it("stays silent for a clean remote and for a token-like path", async () => {
    for (const url of ["https://github.com/acme/repo.git", `https://github.com/acme/ghp_${FAKE}@v2/repo.git`]) {
      const { warn } = await createWorktreeFrom(makeSourceRepo(url));
      expect(warn, url.replace(FAKE, "<fake>")).not.toHaveBeenCalled();
    }
  });
});

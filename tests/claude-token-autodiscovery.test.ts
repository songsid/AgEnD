import { describe, expect, it } from "vitest";
import { tokenFromShellRc, resolveClaudeAuth } from "../src/usage/providers.js";

/**
 * `claude setup-token` writes NO file — verified on 2026-08-02: there is no
 * ~/.config/claude-code, and the binary only ever reads
 * CLAUDE_CODE_OAUTH_TOKEN from the environment. It prints the token and the
 * user exports it, usually into a shell rc. A systemd daemon inherits none of
 * that, so the fleet could not see the login unless the user duplicated it into
 * ~/.agend/.env. This is the fallback that removes that step.
 */

function reader(files: Record<string, string>) {
  return (path: string): string => {
    const name = path.split("/").pop()!;
    if (!(name in files)) throw new Error("ENOENT");
    return files[name];
  };
}

describe("tokenFromShellRc", () => {
  it("finds an exported token", () => {
    expect(tokenFromShellRc(reader({
      ".bashrc": 'export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-abc"\n',
    }), "/home/u")).toBe("sk-ant-oat01-abc");
  });

  it("finds a bare assignment and tolerates spacing and comments", () => {
    expect(tokenFromShellRc(reader({
      ".bashrc": "# my token\n  CLAUDE_CODE_OAUTH_TOKEN = sk-ant-oat01-xyz  # work account\n",
    }), "/home/u")).toBe("sk-ant-oat01-xyz");
  });

  it("takes the last assignment, as a shell would", () => {
    expect(tokenFromShellRc(reader({
      ".bashrc": "export CLAUDE_CODE_OAUTH_TOKEN=old\nexport CLAUDE_CODE_OAUTH_TOKEN=new\n",
    }), "/home/u")).toBe("new");
  });

  it("searches the files in order and skips unreadable ones", () => {
    expect(tokenFromShellRc(reader({
      ".zshrc": "export CLAUDE_CODE_OAUTH_TOKEN=from-zsh\n",
    }), "/home/u")).toBe("from-zsh");
  });

  it("ignores a shell expansion rather than sending a dollar sign as a bearer", () => {
    expect(tokenFromShellRc(reader({
      ".bashrc": 'export CLAUDE_CODE_OAUTH_TOKEN="$MY_OTHER_VAR"\n',
    }), "/home/u")).toBeNull();
  });

  it("returns null when nothing exports it", () => {
    expect(tokenFromShellRc(reader({ ".bashrc": "export PATH=/usr/bin\n" }), "/home/u")).toBeNull();
    expect(tokenFromShellRc(reader({}), "/home/u")).toBeNull();
  });
});

describe("resolution order is unchanged above the fallback", () => {
  const FRESH = { accessToken: "file-token", expiresAt: Date.now() + 3_600_000, subscriptionType: "team" };

  it("a fresh credentials file still wins", () => {
    expect(resolveClaudeAuth(FRESH, { CLAUDE_CODE_OAUTH_TOKEN: "env-token" }))
      .toEqual({ token: "file-token", plan: "Team" });
  });

  it("the environment still beats the rc fallback", () => {
    // Anything already in process.env — including ~/.agend/.env, which
    // loadEnvFile applies before anything reads it — takes precedence.
    expect(resolveClaudeAuth(null, { CLAUDE_CODE_OAUTH_TOKEN: "env-token" }))
      .toEqual({ token: "env-token", plan: null });
  });

  it("falls through to the shell rc when neither the file nor the environment has it", () => {
    // The reported setup: `claude setup-token` exported into .bashrc, and the
    // systemd-launched daemon inherits none of that shell.
    expect(resolveClaudeAuth(null, {}, () => "rc-token"))
      .toEqual({ token: "rc-token", plan: null });
    // Even an expired file yields to it — a working token beats a stale error.
    expect(resolveClaudeAuth({ ...FRESH, expiresAt: Date.now() - 1 }, {}, () => "rc-token"))
      .toEqual({ token: "rc-token", plan: "Team" });
  });

  it("an expired file with no other source explains that it self-heals", () => {
    const stale = { ...FRESH, expiresAt: Date.now() - 1 };
    const auth = resolveClaudeAuth(stale, {}, () => null) as { error: string };
    // AgEnD runs claude instances itself and each run refreshes the file, so
    // this clears without a human — the old wording implied manual work.
    expect(auth.error).toContain("refreshes the next time");
  });
});

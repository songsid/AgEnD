import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The `Notify Discord` step posts the run's result to a webhook. Its two
// standing invariants are easy to break by hand and impossible to see in a
// diff: the four workflows must carry the same script, and that script must
// never interpolate a workflow expression, because a commit message is
// attacker-controlled text and `${{ … }}` written inline becomes part of the
// command that runs. So the tests here execute the step's own script, read out
// of the YAML, rather than restating what it is supposed to do.

const WORKFLOWS = ["ci.yml", "publish.yml", "gitleaks.yml", "deploy-website.yml"] as const;

type Step = {
  name?: string;
  if?: string;
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
  run?: string;
};
type Job = { steps: Step[]; if?: string; needs?: string[] };

const workflow = (file: string): Record<string, Job> => {
  const doc = yaml.load(readFileSync(join(process.cwd(), ".github", "workflows", file), "utf8")) as
    { jobs: Record<string, Job> };
  return doc.jobs;
};

const notifyStep = (file: string): { jobs: Record<string, Job>; job: string; step: Step } => {
  const jobs = workflow(file);
  const found = Object.entries(jobs).flatMap(([job, j]) =>
    j.steps.filter(s => s.name === "Notify Discord").map(step => ({ jobs, job, step })));
  expect(found, `${file} should have exactly one Notify Discord step`).toHaveLength(1);
  return found[0];
};

const script = (file: string): string => {
  const run = notifyStep(file).step.run;
  expect(run, `${file}: the Notify Discord step has no run:`).toBeTypeOf("string");
  return run as string;
};

describe("the Notify Discord step", () => {
  it("is present in every workflow, with the same script byte for byte", () => {
    const scripts = WORKFLOWS.map(script);
    for (const s of scripts) expect(s).toBe(scripts[0]);
  });

  it("never interpolates a workflow expression into the shell", () => {
    // Everything the script needs arrives through `env:`. An `${{ … }}` inside
    // `run:` is expanded before bash sees the line, so a commit message reading
    // `"; rm -rf / #` would be executed rather than quoted.
    for (const file of WORKFLOWS) expect(script(file), file).not.toContain("${{");
  });

  it("takes the webhook from a secret and reports whatever the run did", () => {
    for (const file of WORKFLOWS) {
      const { step } = notifyStep(file);
      expect(step.env?.DISCORD_WEBHOOK, file).toBe("${{ secrets.DISCORDWEBHOOK }}");
      // `always()` or a red run is never reported; `continue-on-error` or a
      // webhook that is down turns a green run red.
      expect(step.if, file).toBe("always()");
      expect(step["continue-on-error"], file).toBe(true);
    }
  });

  it("names a commit a person can actually find", () => {
    // On a pull_request run `github.sha` is the merge commit GitHub invents for
    // the occasion: it is in no branch, and `git show` on it fails for the
    // reader. Same trap as `ref_name` reading `123/merge` instead of the branch,
    // which the Branch field already dodges.
    for (const file of WORKFLOWS) {
      expect(notifyStep(file).step.env?.SHA, file)
        .toBe("${{ github.event.pull_request.head.sha || github.sha }}");
    }
  });

  it("reports on the whole run, not on whatever job happens to hold it", () => {
    for (const file of WORKFLOWS) {
      const { jobs, job, step } = notifyStep(file);
      if (step.env?.STATUS === "${{ job.status }}") {
        // One job, so its status is the run's — but only once every step before
        // it has finished. A step added after this one would fail unseen.
        expect(Object.keys(jobs), file).toHaveLength(1);
        expect(jobs[job].steps.at(-1), file).toBe(step);
        continue;
      }
      // Several jobs, so the step lives in one that waits for the others: a
      // step's `if: always()` cannot rescue a job that never starts.
      expect(step.env?.STATUS, file).toContain("needs.*.result");
      expect(jobs[job].if, file).toBe("always()");
      expect([...(jobs[job].needs ?? [])].sort(), file)
        .toEqual(Object.keys(jobs).filter(n => n !== job).sort());
    }
  });
});

// Distinctive enough that "this string never appears" means something: a
// coincidental match is not possible.
const WEBHOOK = "https://discord.com/api/webhooks/000/s3cr3t-must-never-be-logged";

describe("the Notify Discord step, run for real", () => {
  let bin: string;

  // Everything the script reaches for that we do not want reached: `curl`
  // records its arguments instead of making a request, and `python3` stays the
  // real one, because the payload is what is under test.
  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), "agend-notify-bin-"));
    const stub = join(bin, "curl");
    writeFileSync(stub, "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$CURL_ARGV\"\n");
    chmodSync(stub, 0o755);
  });

  afterAll(() => rmSync(bin, { recursive: true, force: true }));

  const run = (env: Record<string, string>) => {
    const work = mkdtempSync(join(tmpdir(), "agend-notify-"));
    try {
      const sh = join(work, "step.sh");
      writeFileSync(sh, script("ci.yml"));
      const argv = join(work, "curl.argv");
      const result = spawnSync("bash", [sh], {
        cwd: work,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          CURL_ARGV: argv,
          DISCORD_WEBHOOK: WEBHOOK,
          STATUS: "success",
          WORKFLOW: "CI",
          REPO: "songsid/AgEnD",
          REF_NAME: "main",
          HEAD_REF: "",
          SHA: "a6a4121a1b2c3d4e5f60718293a4b5c6d7e8f901",
          EVENT: "push",
          ACTOR: "changhansung",
          RUN_URL: "https://github.com/songsid/AgEnD/actions/runs/1234567890",
          COMMIT_MESSAGE: "chore: nothing in particular",
          ...env,
        },
      });
      return {
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
        payload: existsSync(join(work, "payload.json"))
          ? readFileSync(join(work, "payload.json"), "utf8")
          : null,
        curl: existsSync(argv) ? readFileSync(argv, "utf8").split("\n").slice(0, -1) : null,
        // Read before the directory goes away, or the canary check below would
        // pass for the wrong reason: nothing exists in a directory that is gone.
        wrote: readdirSync(work),
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };

  // Every one of these is a real command substitution, and every one of them
  // arrives from somewhere a stranger can write to: a commit subject, a fork's
  // branch name, a GitHub login.
  const HOSTILE = {
    COMMIT_MESSAGE: "fix: $(touch pwned) `touch pwned2` ${IFS} \"quotes\" {braces} \\slash",
    ACTOR: "$(touch pwned3)",
    HEAD_REF: "--upload-file=/etc/passwd",
    WORKFLOW: "`touch pwned4`",
  };

  it("does not let attacker-controlled text become a command", () => {
    const r = run(HOSTILE);
    expect(r.status, r.stderr).toBe(0);
    // The script itself is the only thing that should have written anything.
    expect(r.wrote.sort()).toEqual(["curl.argv", "payload.json", "step.sh"]);
  });

  it("builds valid JSON out of that text, and sends it as a file", () => {
    const r = run(HOSTILE);
    expect(r.status, r.stderr).toBe(0);
    const body = JSON.parse(r.payload as string);
    expect(body.embeds).toHaveLength(1);
    const fields = Object.fromEntries(
      body.embeds[0].fields.map((f: { name: string; value: string }) => [f.name, f.value]));
    // The text survives as text: quoted, whole, and inert.
    expect(fields.Commit).toContain("$(touch pwned)");
    expect(fields.Event).toContain("$(touch pwned3)");
    expect(fields.Branch).toBe("--upload-file=/etc/passwd");
    expect(body.embeds[0].title).toContain("`touch pwned4`");
    // curl reads the body from a file, so nothing hostile lands on its command
    // line, and the URL is a single argument rather than several.
    expect(r.curl).toContain("@payload.json");
    expect(r.curl?.at(-1)).toBe(WEBHOOK);
    expect(r.curl?.some(a => a.includes("pwned"))).toBe(false);
  });

  it("never writes the webhook to the log, on any path it takes", () => {
    // GitHub masks a secret it recognises, but only the whole value: a step
    // that echoes the URL while debugging, or interpolates it into a message,
    // publishes it to anyone who can read the run. The failure path is checked
    // below; this is the path that actually runs every day.
    const paths: Record<string, string>[] = [{}, HOSTILE, { STATUS: "failure" }, { STATUS: "neutral" }];
    for (const env of paths) {
      const r = run(env);
      expect(r.stdout + r.stderr, JSON.stringify(env)).not.toContain(WEBHOOK);
      expect(r.stdout + r.stderr, JSON.stringify(env)).not.toContain("s3cr3t");
      // Nor into the payload, where it would reach Discord's message content.
      expect(r.payload, JSON.stringify(env)).not.toContain("s3cr3t");
    }
  });

  it("keeps a commit body out of the embed", () => {
    const r = run({ COMMIT_MESSAGE: "fix: the subject\n\nthe body, which must not appear" });
    const body = JSON.parse(r.payload as string);
    const commit = body.embeds[0].fields.find((f: { name: string }) => f.name === "Commit").value;
    expect(commit).toContain("fix: the subject");
    expect(commit).not.toContain("the body");
  });

  it("skips quietly when no webhook is configured", () => {
    // A fork has no secret and has done nothing wrong.
    const r = run({ DISCORD_WEBHOOK: "" });
    expect(r.status).toBe(0);
    expect(r.curl).toBeNull();
    expect(r.stdout).toContain("skipping");
  });

  it("says so when the webhook is configured wrongly, without printing it", () => {
    // A real run failed this way: the stored secret had lost its leading "h",
    // and curl answered `Protocol "ttps" not supported`.
    const r = run({ DISCORD_WEBHOOK: "ttps://discord.com/api/webhooks/000/secret-token" });
    expect(r.status).not.toBe(0);
    expect(r.curl).toBeNull();
    expect(r.stderr).toContain("check the secret value");
    // GitHub masks only the whole secret, so a fragment in the log is a leak.
    expect(r.stderr).not.toContain("secret-token");
  });

  it("colours the result, and has an answer for a status GitHub has not invented yet", () => {
    const colour = (status: string) =>
      JSON.parse(run({ STATUS: status }).payload as string).embeds[0].color;
    expect(colour("success")).toBe(3066993);
    expect(colour("failure")).toBe(15158332);
    expect(colour("cancelled")).toBe(9807270);
    expect(colour("neutral")).toBe(15844367);
  });

  it("names the branch a person would recognise on a pull request", () => {
    // `github.ref_name` is `123/merge` on a PR run, which tells nobody anything.
    const r = run({ HEAD_REF: "feat/something", REF_NAME: "123/merge" });
    const body = JSON.parse(r.payload as string);
    const branch = body.embeds[0].fields.find((f: { name: string }) => f.name === "Branch").value;
    expect(branch).toBe("feat/something");
  });
});

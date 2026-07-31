import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashCompletion, zshCompletion, completionScript, COMPLETION_SHELLS, type CompletionSpec } from "../src/completion.js";

const SPEC: CompletionSpec = {
  topLevel: ["fleet", "attach", "ls", "completion", "health"],
  fleetSub: ["start", "stop", "restart", "status", "logs"],
  instanceCommands: ["attach"],
  fleetInstanceCommands: ["start", "stop", "restart"],
};

const INSTANCES = ["agend-dev1-t1503", "agend-leader-t1503", "agend-sol-t1527", "doupo-server-t1503"];

function have(bin: string): boolean {
  try { execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }); return true; }
  catch { return false; }
}

/**
 * Install the generated script into a throwaway shell and ask it what it would
 * complete. Asserting on real shell behaviour is the only way to catch the
 * class of bug that string assertions miss — a function-wide `IFS=$'\n'`, for
 * instance, parses fine but silently kills subcommand completion.
 */
function bashComplete(line: string, cword: number): string[] {
  const dir = mkdtempSync(join(tmpdir(), "agend-comp-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // Stub `agend` so the lookup is deterministic and never touches a real fleet.
  writeFileSync(join(bin, "agend"),
    `#!/bin/bash\n[ "$1" = "ls" ] && [ "$2" = "--names-only" ] && printf '%s\\n' ${INSTANCES.map(i => `'${i}'`).join(" ")}\n`);
  chmodSync(join(bin, "agend"), 0o755);
  writeFileSync(join(dir, "comp.bash"), bashCompletion(SPEC));
  const driver = `
export PATH="${bin}:$PATH"
source "${join(dir, "comp.bash")}"
COMP_WORDS=(${line.split(" ").map(w => `'${w}'`).join(" ")})
COMP_CWORD=${cword}
_agend_completion
printf '%s\\n' "\${COMPREPLY[@]}"
`;
  writeFileSync(join(dir, "drive.bash"), driver);
  const out = execFileSync("bash", [join(dir, "drive.bash")], { encoding: "utf-8" });
  return out.split("\n").filter(Boolean);
}

describe("completion script generation", () => {
  it("supports exactly bash and zsh", () => {
    expect([...COMPLETION_SHELLS]).toEqual(["bash", "zsh"]);
    expect(completionScript("bash", SPEC)).toBe(bashCompletion(SPEC));
    expect(completionScript("zsh", SPEC)).toBe(zshCompletion(SPEC));
  });

  it("registers itself with the shell", () => {
    expect(bashCompletion(SPEC)).toContain("complete -F _agend_completion agend");
    expect(zshCompletion(SPEC)).toContain("compdef _agend agend");
  });

  it("reads instance names from `ls --names-only`", () => {
    for (const script of [bashCompletion(SPEC), zshCompletion(SPEC)]) {
      expect(script).toContain("ls --names-only");
    }
  });

  it("drops names that could break out of the generated quoting", () => {
    const nasty = { ...SPEC, topLevel: ["ls", "a b", "x;rm -rf /", "$(evil)", "ok-1"] };
    for (const script of [bashCompletion(nasty), zshCompletion(nasty)]) {
      expect(script).not.toContain("rm -rf");
      expect(script).not.toContain("$(evil)");
      expect(script).toContain("ls ok-1");   // the safe ones survive, in order
    }
  });

  it("does not leave a function-wide newline IFS in the bash script", () => {
    // Regression guard: `local IFS=$'\\n'` at function scope makes compgen treat
    // each space-separated subcommand list as one word, so `agend at<tab>`
    // completes nothing. It must stay scoped to the instance-name helper.
    const script = bashCompletion(SPEC);
    const fnBody = script.slice(script.indexOf("_agend_completion() {"));
    expect(fnBody).not.toContain("IFS=");
  });
});

describe.skipIf(!have("bash"))("bash completion, executed in a real shell", () => {
  it("completes instance names for `attach`", () => {
    expect(bashComplete("agend attach agen", 2)).toEqual([
      "agend-dev1-t1503", "agend-leader-t1503", "agend-sol-t1527",
    ]);
    expect(bashComplete("agend attach doupo", 2)).toEqual(["doupo-server-t1503"]);
  });

  it("offers every instance when the prefix is empty", () => {
    expect(bashComplete("agend attach ", 2)).toEqual(INSTANCES);
  });

  it("completes top-level subcommands", () => {
    expect(bashComplete("agend at", 1)).toEqual(["attach"]);
    expect(bashComplete("agend ", 1)).toEqual(SPEC.topLevel);
  });

  it("completes fleet subcommands, then instance names", () => {
    expect(bashComplete("agend fleet st", 2)).toEqual(["start", "stop", "status"]);
    expect(bashComplete("agend fleet start agen", 3)).toEqual([
      "agend-dev1-t1503", "agend-leader-t1503", "agend-sol-t1527",
    ]);
  });

  it("completes the shell name for `completion`", () => {
    expect(bashComplete("agend completion b", 2)).toEqual(["bash"]);
  });

  it("offers nothing for commands that take no instance", () => {
    // Also guards against a stale COMPREPLY leaking in from a prior call.
    expect(bashComplete("agend ls foo", 2)).toEqual([]);
    expect(bashComplete("agend health foo", 2)).toEqual([]);
  });

  it("does not complete an instance in the wrong argument position", () => {
    expect(bashComplete("agend attach one two", 3)).toEqual([]);
    expect(bashComplete("agend fleet start one two", 4)).toEqual([]);
  });
});

// Runs only where zsh exists. Left in so the script is genuinely exercised on
// machines that have it, rather than only inspected.
describe.skipIf(!have("zsh"))("zsh completion, executed in a real shell", () => {
  it("parses under zsh", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-zsh-"));
    const file = join(dir, "comp.zsh");
    writeFileSync(file, zshCompletion(SPEC));
    // -n = parse only. Catches syntax errors without needing a completion context.
    expect(() => execFileSync("zsh", ["-n", file], { stdio: "pipe" })).not.toThrow();
  });
});

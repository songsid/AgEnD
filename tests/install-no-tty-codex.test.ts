/**
 * #2583: the Windows installer hung on "OpenAI Codex" (a real user, 2026-10-24). Codex's install.sh ends with
 * prompt_yes_no "Start Codex now?", which reads /dev/tty whenever `( : </dev/tty )` works. Under the installer's
 * Invoke-Watched → wsl.exe a controlling terminal exists, so it waited for an answer nobody could type. A stdin
 * redirect does not help: the prompt reads /dev/tty, not stdin. kiro's installer asks "Do you want to replace it?"
 * on /dev/tty the same way when kiro-cli is already there.
 *
 * Now:
 * - the Windows installer runs every backend's install with no controlling terminal (setsid, stdin /dev/null), and
 *   codex's with CODEX_NON_INTERACTIVE=1 (website/public/install-agend.ps1);
 * - `/login`'s install window, which nobody types into either, runs codex's with CODEX_NON_INTERACTIVE=1
 *   (BACKEND_INSTALLATION_INFO.codex.unattended);
 * - the command shown to a person to copy is unchanged.
 *
 * The bash wrapper is the installer's own text, run here in real bash under a real pseudo-terminal (python's pty: the
 * child is a session leader with that terminal as its controlling tty, as under wsl.exe).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { BACKEND_INSTALLATION_INFO } from "../src/instance-lifecycle.js";

const PS1 = readFileSync(join(import.meta.dirname, "..", "website", "public", "install-agend.ps1"), "utf8");
const template = PS1.match(/^\$UNATTENDED_INSTALL = @'\n([\s\S]*?)\n'@$/m)?.[1];
const dir = mkdtempSync(join(tmpdir(), "agend-no-tty-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * An installer that asks the way codex's prompt_yes_no does: on /dev/tty when it opens, else on stdin when stdin is a
 * terminal, else not at all (kiro's replace question is the /dev/tty half).
 */
const ASKS_ON_TTY = `#!/bin/sh
echo "installing"
if [ -z "\${CODEX_NON_INTERACTIVE:-}" ]; then
  if ( : </dev/tty ) 2>/dev/null; then
    printf 'Start Codex now? [y/N] ' >/dev/tty
    IFS= read -r answer </dev/tty
  elif [ -t 0 ]; then
    printf 'Start Codex now? [y/N] '
    IFS= read -r answer
  fi
fi
echo "installed"
`;
const fake = join(dir, "asks-on-tty.sh");
writeFileSync(fake, ASKS_ON_TTY, { mode: 0o755 });

/** Run a bash script under a fresh pseudo-terminal (it becomes the controlling tty); null when it timed out. */
function underPty(script: string, timeoutMs = 8000): { status: number | null; out: string } | null {
  const file = join(dir, `step-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, script);
  const r = spawnSync("python3", ["-c", "import pty,sys; sys.exit(pty.spawn(['bash', sys.argv[1]]) >> 8)", file],
    { encoding: "utf8", timeout: timeoutMs, input: "" });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") return null;
  return { status: r.status, out: r.stdout };
}
// Generate the actual outer private-session wrapper; UNATTENDED_INSTALL no longer detaches a second time.
const hasPwsh = spawnSync('pwsh',['-NoProfile','-Command','1']).status === 0;
function ownedWrapper(script: string): string {
  const path = join(dir, `owned-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(path, script);
  const installer=join(import.meta.dirname,'..','website','public','install-agend.ps1');
  const command=`$t=$null;$e=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile('${installer}',[ref]$t,[ref]$e);$f=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-OwnedWslStepScript'},$true);. ([scriptblock]::Create($f.Extent.Text));Get-OwnedWslStepScript '${path}' '${path}.cancel' 5`;
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',timeout:15000});
  if(result.status!==0)throw Error(result.stderr);
  return result.stdout;
}
const hasPython = spawnSync("python3", ["-c", "import pty"]).status === 0;

describe("install-agend.ps1: a backend's install never waits on /dev/tty", () => {
  it("the installer has the wrapper, and every backend's install goes through it", () => {
    expect(template).toBeTruthy();
    expect(template).toContain("__AGEND_INSTALL__");
    expect(template).toContain('agend_install </dev/null');
    expect(PS1).toContain('setsid timeout --signal=TERM --kill-after=2s ');
    expect(PS1).toContain('New-WslScriptFile (Get-OwnedWslStepScript $wslFile');
    expect(PS1).toContain(`$cmd = $UNATTENDED_INSTALL.Replace('__AGEND_INSTALL__', "$BACKEND_PATH; $nodePrep$($b.Install)")`);
    expect(PS1).not.toMatch(/\$cmd = "\$BACKEND_PATH; \$nodePrep\$\(\$b\.Install\)"/);
  });

  it("codex's install runs with CODEX_NON_INTERACTIVE=1, on the sh that reads install.sh", () => {
    const codex = PS1.match(/Key="codex";[^\n]*Install='([^']+)'/)?.[1];
    expect(codex).toBe("curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh");
  });

  it.skipIf(!hasPython)("control: under a terminal, the bare installer waits for an answer (so the next test can fail)", () => {
    expect(underPty(`bash ${fake}\n`, 3000)).toBeNull();
  });

  it.skipIf(!hasPython || !hasPwsh)("through the wrapper, the same installer under the same terminal finishes at once", () => {
    const r = underPty(ownedWrapper(template!.replace("__AGEND_INSTALL__", `bash ${fake}`)));
    expect(r).not.toBeNull();
    expect(r!.status).toBe(0);
    expect(r!.out).toContain("installed");
    expect(r!.out).not.toContain("Start Codex now?");
  });

  it.skipIf(!hasPython)("with CODEX_NON_INTERACTIVE=1 the bare installer asks nothing even under a terminal (what the codex line relies on)", () => {
    const r = underPty(`CODEX_NON_INTERACTIVE=1 bash ${fake}\n`);
    expect(r).not.toBeNull();
    expect(r!.out).toContain("installed");
  });

  it.skipIf(!hasPython || !hasPwsh)("the wrapper keeps the install's exit code, so a failed install still reads as failed", () => {
    const r = underPty(ownedWrapper(template!.replace("__AGEND_INSTALL__", "echo partial; exit 3")));
    expect(r).toEqual({ status: 3, out: expect.stringContaining("partial") });
  });
});

describe("/login's install window: codex's install asks nothing", () => {
  it("the unattended command sets CODEX_NON_INTERACTIVE=1; the command shown to a person is unchanged", () => {
    expect(BACKEND_INSTALLATION_INFO.codex!.unattended).toBe("curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh");
    expect(BACKEND_INSTALLATION_INFO.codex!.install).toBe("curl -fsSL https://chatgpt.com/codex/install.sh | sh");
  });
});

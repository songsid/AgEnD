# Windows stage-1 path conversion failure (#2710)

The real Windows test installed Ubuntu 24.04 as `AgEnD` on WSL 2.6.1, then passed `echo WSL_OK` before failing in `New-WslScriptFile`. The user's read-only diagnostic narrowed the cause:

```text
wsl -d AgEnD -u root -- wslpath -u C:\ProgramData
wslpath: C:ProgramData
```

This is a shell argument bug, not incomplete Ubuntu provisioning. WSL's `--` stops option parsing but keeps default-shell execution. The unquoted Windows path is passed through `$SHELL -c`, which consumes its backslashes. The script file has no whitespace under the normal ProgramData path, so the old command-line builder leaves it unquoted. `wslpath` receives `C:ProgramDataAgEnD-installstep-….sh`, fails, and its diagnostic used to be discarded. A rerun takes the same conversion path and fails again.

## Primary-source proof

These links pin Microsoft WSL **2.6.1** to commit `642331364dda7a3d88bf64acb87e7056918a5fc9`:

- [Option parsing](https://github.com/microsoft/WSL/blob/642331364dda7a3d88bf64acb87e7056918a5fc9/src/windows/common/WslClient.cpp#L1635-L1644): `--exec` selects exec mode; `--` does not.
- [Launch modes](https://github.com/microsoft/WSL/blob/642331364dda7a3d88bf64acb87e7056918a5fc9/src/windows/common/WslClient.cpp#L1790-L1817): normal commands use the shell; exec mode uses Windows argv parsing.
- [OOBE gate](https://github.com/microsoft/WSL/blob/642331364dda7a3d88bf64acb87e7056918a5fc9/src/windows/service/exe/WslCoreInstance.cpp#L204-L207): both the executable and command line must be empty before OOBE is allowed. Neither the root echo nor wslpath command meets that condition.
- [Windows argv rules](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-commandlinetoargvw#remarks) preserve backslashes before ordinary characters. [Bash escaping](https://www.gnu.org/software/bash/manual/html_node/Escape-Character.html) explains their removal in shell mode.

Modern Ubuntu uses `/etc/wsl-distribution.conf` to configure its first interactive launch. [Canonical's image guide](https://github.com/canonical/ubuntu-pro-for-wsl/blob/main/docs/howto/custom-ubuntu-distro.md) names `/usr/lib/wsl/wsl-setup`. Its interactive user-creation flow is irrelevant to this explicit-command failure. No user creation or distro configuration change is required to fix it.

## Why earlier installs and tests missed it

Before #2658 (`ac17a8666`), `New-WslScriptFile` already used shell mode, but fell back to a manually constructed `/mnt/<drive>/…` path whenever conversion did not return an absolute Linux path. That fallback masked this defect. #2658 correctly removed the unverified fallback and required conversion success, exposing the path bug. This is independent of selecting an existing Ubuntu versus installing a separate distro.

The earlier pwsh shims stubbed `New-WslScriptFile` itself or returned canned native output. They did not simulate the additional Linux-shell parse. The new native-process shim runs an actual Bash command for `--` and literal argv for `--exec`, then verifies exactly what the fake wslpath received. The real Windows backslash-loss evidence remains the user's diagnostic above; Linux shim coverage is not native Windows acceptance.

## Fix and Windows-path call audit

`ConvertTo-WslScriptPath` uses `-d <selected distro> -u root --exec wslpath -u <literal Windows path>`. It requires one absolute Linux path, retains failures, and never guesses a mount root. `New-WslScriptFile` removes its unused Windows temp file if conversion fails.

| Boundary | Path kind | Result |
| --- | --- | --- |
| All `Invoke-BoundedWsl` calls, including network probe, auth/version/config reads, root probe and cancellation boot-id check | Commands, Linux paths or bounded shell programs; no other raw Windows-path argument | No shell mode change needed |
| `New-WslScriptFile`, used by config/network/backend/login/setup/service steps and their owned cancellation wrapper | Windows ProgramData path | Fixed to `--exec` |
| `wsl --install … --location <Windows path>` | WSL host option | Parsed by Windows, never by a Linux shell |
| `wsl --import <name> <Windows location> <Windows image>` | WSL host options | Parsed by Windows, never by a Linux shell |
| `install.ps1` | Downloads/launches the Windows script; no Windows path sent to a Linux command | Unchanged |
| Shared desktop shortcuts | Linux shell snippets, no raw Windows-path argument | Same commands; explicit UTF-8 native diagnostics |

Failed conversion, invalid returned paths, root probes, default-version changes and config reads retain exit/output through a bounded, redacted diagnostic formatter. The config-merge exception includes the final streamed step output (redacted before retaining/truncating the tail); the complete stream still goes to the existing install log. The original setup observer runs exactly once per line. Native probes explicitly request `WSL_UTF8=1` so WSL's own error messages are readable too. The shared shortcut template stays identical, including its existing command-size guard.

## Compatibility and proof

The change runs before npm installation and adds no AgEnD command, flag, API, config key or file dependency. npm `latest` stays unchanged.

In one disposable networkless PowerShell 7.4.2 container (Node 22.22.2, 1 CPU, 1 GiB, private HOME; all WSL/backends stubbed):

- New path/diagnostic tests: 14 pass, including the original failing shell-mode diagnostic, literal spaces/Unicode/metacharacters, fresh/rerun paths, simulated first-launch failure output, exit 1/37/124, malformed output and redaction.
- WSL-root, shortcut, browser-sign-in and readiness focused cases pass. The shortcut's unchanged 30,000-character ceiling is retained.
- The exec-to-shell reverse mutation fails the path-preservation/rerun cases; restored afterwards.
- Both actual published packages **2.3.1** and **2.3.2-beta.11** pass the current generated readiness program with their actual inert auth handlers (`/signin` 200, program exit 0). `/ui` remains protected. The original pre-#2707 program still fails as expected (401, exit 1).
- Their actual CLI capability probes run with every native child/listener forbidden: 2.3.1 returns unknown-option/exit 1 and the installer retains console fallback; beta.11 returns the supported browser-checklist contract/exit 0.

No real account, fleet, Windows desktop, WSL distro or provisioning program was used for these tests. Real Windows 5.1/WSL argv behavior is grounded in the pinned implementation and user's repro, not claimed as executed in the container.

## User next step and read-only confirmation

After the fixed installer is live: **在原本同一個 Windows 帳號再貼一次同一行安裝指令；會沿用 AgEnD 發行版並從未完成步驟繼續，不用刪除或重裝 Linux。**

Optional read-only comparison in PowerShell (the first reproduces the old failure; the second should print `/mnt/c/ProgramData` with the default mount layout):

```powershell
wsl -d AgEnD -u root -- wslpath -u 'C:\ProgramData'
wsl -d AgEnD -u root --exec wslpath -u 'C:\ProgramData'
```

Risk: narrow command-boundary and diagnostic changes; distro/account/data remain intact. Rollback is reverting this PR, which restores the known stage-1 failure. No Linux deletion, reinstallation, OOBE completion or fresh account is part of recovery. Install-drive selection is a separate follow-up.

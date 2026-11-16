# M-3224: authorized Windows x64 proof

Outcome: **9/9 controls passed; the one real answer failed the file-read check. Activation remains held.**

Source: `3137a53c35df8d52e28fb43e822ab269477a9c63`. This was a standalone background profile on the authorized host, not a Runtime service, pairing or installed application. Windows 11 Enterprise x64 **10.0.26100.9711**, Node **26.13.1**, Codex **0.165.0**, Claude Code **2.1.323**. No support claim follows from the OS version alone.

The nine controls are listed individually in [result.json](result.json): effective isolation flags/prompt/MXC, synthetic access-only OAuth, shared read, outside-read refusal with positive control, auth-read refusal, junction refusal, write refusal, network refusal with positive local control, and Claude headless safety flags. The command controls used synthetic authentication; only the final turn used the existing Windows Codex access token, staged without refresh authority. Original authentication bytes were unchanged. No sign-in, sign-out or refresh was performed.

The sole model attempt completed its final-answer protocol but said: “I couldn’t read `allowed.txt`: the shell failed to access the shared folder.” The marker check failed. Raw event output was not retained, so the exact shell command chosen by the model is not claimed.

Local, no-model follow-ups reproduced an independently observable failure: under the same named MXC profile, PowerShell 7 could not load `Get-Content`, and explicit module import reported that drive C did not exist. Node, cmd and Windows PowerShell 5 read the marker. Adding the PowerShell binary directory to read roots, changing/removing PSModulePath, and changing only the disposable home/AppData/work did not resolve it. Those experimental settings were not applied to product code. The underlying PowerShell/MXC initialization failure is still unresolved.

The product bug addressed by this follow-up is narrower: readiness checked only a sandboxed Node process, so it declared this unusable shell ready. It now also requires a sandboxed PowerShell read of a constant canary in the job's private work directory, with exact readback. Failure is `profile-unavailable` before any model turn. Shell selection follows [the inspected Codex 0.165 discovery order](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/shell-command/src/shell_detect.rs). The filesystem and network permission policy is unchanged. This is a fail-closed availability fix, not proof that PowerShell 7 now works.

Cleanup: all proof/diagnostic children had exited; exact-root process query returned zero. Every private stage was removed, then only the uniquely marked scratch root (including the owned junction) was deleted. [cleanup-ledger.json](cleanup-ledger.json) and [primary-stage-ledger.json](primary-stage-ledger.json) list the owned paths. Both before and after `cmd.exe /c ver` returned exit 0 with build **10.0.26100.9711**. The Windows Runtime pairing, service, scheduled tasks, PATH/profile, WSL interop/binfmt and wslrelay were untouched. No visible windows were opened.

Verification of the availability fix: two regression assertions failed before the fix (Node-only false-ready and missing staged canary); 30 tests in four files passed afterward. Removing exact shell readback validation makes the new negative fail. Source and test TypeScript programs both exit 0. No second model turn or repeated Windows campaign was run.

Next: resolve or explicitly reject the affected Codex setup, obtain another bounded real-answer authorization through the leader if a second turn is needed, then complete the previously held registration and host/UI acceptance. Do not count this packet as a successful real answer.

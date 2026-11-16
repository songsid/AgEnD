# Authorized Windows x64 acceptance

The one post-login Claude Code turn passed on **Windows 11 Enterprise x64 10.0.26100.9711**, Node **26.13.1**, Claude Code **2.1.323**. It read the synthetic shared file and returned its exact marker through the final-answer parser. There was one model turn, no retry. The two original Windows account/config files stayed byte-identical during this access-only staged turn. The previous failed attempts retain their recorded scopes; they are not counted as successful answers.

The owner explicitly authorized the normal Windows Claude login first. The stock `claude auth login --claudeai` flow ran through the existing hidden Runtime sign-in adapter with browser opening suppressed. Only the URL went to the leader; one privately forwarded code was verified and consumed without echo/logging, and the code file was unlinked before submission. Login succeeded; its new expiry was verified and reported privately to the leader. Credentials were intentionally refreshed by that authorized login, then left unchanged by the proof. No token, code, OAuth URL, account identity or credential hash is included here.

Profile source was `3137a53c35df8d52e28fb43e822ab269477a9c63`. Against the registration tree, the worker and final-answer reader are byte-identical; profile/stage differences are the later Codex-only canary constants/branch from #4071. The Claude launch/staging path is unchanged. This is a standalone real Windows profile turn. The earlier Hub HTTPS/WSS journey uses an inert Windows peer; this packet does not turn that separate test into a combined real-vendor end-to-end claim.

The earlier nine synthetic controls remain listed with their original scope in [result.json](result.json). Availability must come from each computer's own check, never an OS version list. Claude passed here. Codex remains unavailable in this host's one-folder profile.

## PowerShell 7 investigation (zero model requests)

PowerShell **7.4.22** could not initialize its filesystem commands under Codex **0.165.0** MXC with root denied. The exact PowerShell module directory and shared file were readable by Node, while root `C:\` metadata/list/statfs returned EPERM. Provider-qualified reads, explicit module import and an explicit drive attempt still failed.

A synthetic-only causal control changed the sandbox's default root access from deny to read: PowerShell then read the shared marker. It also read our **owned outside-folder canary**, proving that change would break the one-folder boundary. Restoring deny reproduced the failure. The separate attempt to grant literal `C:\` was refused by MXC as not losslessly representable. [powershell-controls.json](powershell-controls.json) records the successful deny/read/deny discriminator.

No broad-root policy is shipped. The experimental configurations were restored and the stages removed. #4071's real-shell preflight keeps this Codex setup unavailable before a model turn. These results establish the root-access conflict on the tested combination; they do not claim a metadata-only upstream repair or general Windows support.

## Cleanup and interop

Both uniquely marked disposable roots were removed, with no owned process or private stage left. The proof cleanup also removed one empty CLI-created `temp/claude` directory. [cleanup-ledger.json](cleanup-ledger.json) lists every retained path and each transient stage. The normal refreshed Claude sign-in remains in place as authorized. No visible window was opened; the existing Runtime pairing/service/tasks, WSL interop/binfmt/wslrelay, Windows PATH and shell profile were untouched. Login and proof `cmd.exe /c ver` checks all exited 0 with build **10.0.26100.9711**.

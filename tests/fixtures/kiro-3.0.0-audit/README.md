# Kiro CLI3.0.0 retirement and login captures (2026-11-04, #3047)

Real supplied Linux x86_64 binary: SHA256 `7473674c41fbf124574ea6fcaadfabdea2bf94828a03a33c80a9a19b459d8d8c`;
release tar: `2ebb8688b84765e4baf46d6e28b3e79780e7724e198591c22d0528d03a88a282`.

- `chat-help.txt` is actual `kiro-cli chat --help`. It still advertises retired V1 and `--legacy-ui`.
- `classic-120/80.pane.txt` are real `chat --legacy-ui --agent-engine=v1 --trust-all-tools` captures, at their named
  widths. The retirement wording wraps identically at these two widths. No harness was saved in these homes.
- `v2-notice.pane.txt` is the same Classic command with `chat.agentEngine=v2` already in its scratch settings.
- `tui-explicit-saved-v2.pane.txt` is `--tui --agent-engine=v2 --trust-all-tools` with the same saved V2 setting:
  it reaches the ordinary trust prompt and must not be refused by the retirement check.
- `login-required.pane.txt` is a fresh signed-out home. Deliberate `login` still uses the existing method menu.

Offline, disposable network-none container, scratch HOME/XDG and a private tmux socket; final captures are uid1000.
Only a never-valid dummy stored token bypassed sign-in for the menu captures. No actual account, model turn,
provider-home mount, menu answer or migration. `scripts/manual/kiro3-compatibility` reproduces the final control,
real-binary pre-launch refusal and production-method Needs-you replay with forbidden pane/config writes.

The six literals gone from3.0 remain in the code for2.x. No real sign-in/success or expired-token refresh was done.
Additional older-glibc/three-choice variants use upstream documentation, not these captures; matching them can only
hold, never answer. This startup/attention audit does not certify3.0 model/tool/delivery/steering behavior.

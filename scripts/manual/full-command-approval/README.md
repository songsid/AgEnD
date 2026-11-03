# Complete-command approval acceptance

Run from the repository root after `npm ci`:

```sh
npx tsx scripts/manual/full-command-approval/mock-tmux.mts .artifacts/mock-proof
npx tsx scripts/manual/full-command-approval/acceptance.mts .artifacts/native-proof
```

The first rig uses inert terminal processes on a unique private tmux socket. A command changes its prefix after Down while keeping the same long tail. The production answer walk must withhold Enter. An unchanged control must receive exactly Down, Enter. Replacing the request hash with the old ten-line tail makes the replacement receive Enter and fails this acceptance.

The second runs the installed **Linux Claude Code** TUI, on another private tmux socket, in a new HOME and working directory. Its API is a synthetic loopback Anthropic server, with a fake key. It does not use an account, the Windows CLIs, a fleet, systemd, or the operator's Claude settings. All optional external traffic and self-update are disabled. The mock offers a real Bash tool request long enough to wrap beyond the former row limit. The receipt checks every command character is shown (ignoring physical wrapping), a changed prefix invalidates the card, and a verified refusal sends one Enter without creating its sentinel.

Only synthetic pane captures and summary receipts are retained. Both scripts remove their owned tmux server and scratch HOME; the real-CLI rig also confirms its recorded child PID exited before removing its HOME. A failed cleanup retains the scratch path instead of claiming success. The transcript and settings in that scratch HOME are synthetic, not copied from an account. Neither script targets the live tmux server.

These are terminal-rendering and input-boundary proofs, not a provider-account, network-proxy, or Windows acceptance claim. The capture must contain the complete command; a viewport or provider-truncated request is held rather than approved from a suffix.

# Telegram shutdown acceptance

The regression suite starts real grammY against a loopback-only Bot API fixture whose updates remain pending until a later `getUpdates` offset acknowledges them. No real token or account is used:

```sh
npx vitest run tests/telegram-shutdown-ingress-2411.test.ts tests/telegram-pending-restart-2395.test.ts tests/stop-all-idempotent.test.ts tests/fleet-stop-budget-1071.test.ts tests/exec-helper-stop-wait-2364.test.ts
npm run typecheck
npm run typecheck:tests
```

The tests hold receive shutdown before instance stop, release a fetched batch after the receive fence, exercise the SDK's final offset ACK, retain outbound notices, restart from the private update floor and cancel a pending polling reconnect. Reversing the shutdown wait, middleware floor fence, API offset fence or reconnect generation must fail the corresponding regression.

For the real-CLI acceptance, use a disposable Linux container with `--network none`, a fresh home, its own tmux namespace and no host mounts or credentials. Run the built fleet with real Claude Code 2.1.318 and Codex 0.165.0, each pointed at local mock model APIs, and a local mock Telegram server implementing offset-based acknowledgement. Expose no ports. The mock model emits one reply tool call for each distinct canary and can hold an active response to keep each CLI busy; it must support the real CLI's tool-discovery and resume formats.

Check both CLIs idle, busy with a queued second message, and immediately after session resume. Every canary must produce exactly one reply. While both CLIs are busy, SIGTERM only the owned scratch fleet, wait for `/health` to report 503 while its PID is still alive, and inject two new Telegram canaries. Record whether the old PID was alive at injection, the mock's getUpdates call count/offsets, daemon logs and reply calls. Before restarting there must be no reply or new offset acknowledgement for those two canaries. Restart the same scratch fleet/home, check the retained sessions resume, and require one reply to each pending canary. A notice send remains possible during receive shutdown.

Save the evidence before removing the owned container. This is a real CLI / mock-provider check, not a live vendor, chat platform or account test. Never use the host fleet, its tmux server, credentials or system service. No container privilege, binfmt change, host network change or trust-store edit is needed.

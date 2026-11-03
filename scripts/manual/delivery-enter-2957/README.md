# Delivery Enter acceptance (#2957)

From the repository root, build with `npm run build`, then run:

```sh
node scripts/manual/delivery-enter-2957/acceptance.mjs dist .artifacts/enter-2957-acceptance.json
```

This creates a unique private tmux socket and scratch AGEND_HOME under `.artifacts`, and drives an inert Node mock through the real TmuxManager and Daemon. It starts no fleet, provider CLI, account, or systemd service. The mock switches from a captured Claude composer to its permission card after a real bracketed paste. Initial-submit and idle-to-busy retry must withhold Enter, a normal composer must receive exactly one, and a failed capture must withhold it. Cleanup removes the exact private socket and scratch files. The receipt contains the source head, tracked-clean status and built daemon hash, with no conversation or credentials.

For the regression mutation, remove the final capture/composer gate in `sendDeliveryEnterAfterAvailability`, rebuild, and run the same script: it must fail because the permission card receives Enter. Restore source and rebuild afterwards. Also run `tests/delivery-enter-guard-2957.test.ts` and `tests/claude-idle-proof-transcript.test.ts`; the latter verifies the durable attempt stays uncertain with one paste and no automatic replay.

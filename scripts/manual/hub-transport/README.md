# Hub S1 isolated transport acceptance

This recipe exercises the experimental Hub transport library. It opens TLS/WSS listeners only on `127.0.0.1`, creates private test keys and SQLite files in disposable scratch directories, and uses an inert directory callback and fake restricted operations. It never connects to a real directory, fleet, provider or tunnel, installs a service, changes a trust store, or starts an AI CLI.

Run from a checkout with the lockfile installed:

```sh
npm ci
npx vitest run tests/hub-protocol.test.ts tests/hub-identity.test.ts tests/hub-pairing.test.ts tests/hub-tls-mount.test.ts tests/hub-network.test.ts tests/hub-member-journal.test.ts tests/hub-version-floor.test.ts tests/hub-init-s1-provider.test.ts --maxWorkers=1
npm run typecheck
npm run typecheck:tests
```

The network suite uses actual self-signed certificates and outbound WSS. It covers code/owner/admin pairing, the exact certificate pin, connection replacement and revocation, an observed Hub/issuer identity change, one question whose admission waits for an authorization reply on the same socket, a lost reply with no retry, and bounded work discarded after its connection retires. The pin-swap test records whether a credential reached the replacement server; the expected count is zero.

The journal suite inserts into an inert restricted outbox in the same SQLite transaction. It checks message-ID/context conflicts, exact message/exposure leases, policy changes during authorization, one durable input intent, reopening after an interrupted input, positive receipt retention, scoped revocation, answer deduplication and ciphertext binding. A large question/escaped answer control fits two real protocol frames and survives reopening.

The file-floor suite uses real private revision files. Missing or corrupt existing state, unsafe modes, symlinks, rollback and a failed audit publication remain held. A failed audited write advances the independent floor before the SQLite transaction can commit; reopening cannot silently accept the older state. There is no automatic reset/repair operation.

The initializer integration uses S1's actual private keys with S5a's confirmed initializer. It interrupts after identity creation, confirms and resumes the same operation, verifies the issuer seal against the current configuration, and checks that a later config change prevents mounting. Availability inspection itself loads no TLS/key provider and creates nothing. Native Windows hosting remains unavailable until a private-file ACL adapter exists; WSL uses the POSIX path.

## Composition boundary

This is transport acceptance, not a complete Hub web or agent-runtime trial. S1 supplies strict DTOs, pairing, TLS/WSS, the member journal and a manifest-gated mount with injected services. S2 supplies the directory; S3 supplies authorization and exposure/room handlers; S4 supplies an isolated restricted outbox/executor; S5b supplies the shared private stores, audit and FleetManager lifecycle composition. Missing services must refuse rather than mount a partial Hub. Ordinary fleet routes, credentials and local agent conversations are not used by this library.

Both Hub switches default off. No listener, store, key generation, LDAP import or timer is started by merely importing the lightweight types/mount/provider-availability modules. Full runtime readiness and any later real-CLI acceptance belong to the composed slices. Production trials must use a fake directory until separately authorized.

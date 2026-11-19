# Preview fixture listener reservations (M-3370, first family)

At base `8db3a240`, `tests/helpers/hub-preview-rig.ts:26–30` selects
member, web and preview ports, closes all three sockets, then initializes
and starts the Hub. Another worker can take any of the addresses meanwhile.
The new deferred-start regression actually binds three competing sockets
in that interval: the base fails with `EADDRINUSE` at the real listener.

The fixture now uses the existing `hubListenerPorts()` helper. All three
OS-assigned sockets stay bound through initialization and deferred startup;
the real TLS listeners adopt them. Real trusted HTTPS requests to the Hub
shell and preview frame succeed. There is no production change, retry or
timeout increase. The shared lease helper itself is unchanged.

Two existing fixture contracts remain explicit:

- `start: false` retains reservations until the caller starts the service.
  The preview-off deferred rig can still opt into preview during Runtime reload.
- An already-started `preview: false` rig releases the unused preview reservation.
  The negative test proves that address is free as well as unadvertised.

The intentional occupied-preview test releases just that reservation before
binding its competitor. After the failed partial start it releases the never
started web reservation. Its member-port probe remains dependent on production
teardown; the fixture does not close that claimed handle before the probe.

Cleanup is idempotent and runs on initialization/start failure. A separate
injected startup-failure regression checks release of all ports, removal of
generated certificate/state directories, and restoration of the listener hook.
Owned services close before their lease reservations.

Validation commands/results are in `validation.json`. All endpoints, keys,
people and state are disposable synthetic fixtures. Full CI and the parity
review remain separate gates. Main has no preview rig, so there is no twin.

This PR covers only the preview fixture family and its existing consumer.
M-3370 remains open for the other families inventoried in
`docs/evidence/hub-join-ports-m3369/README.md`.
Rollback reverts these test helpers, cases and evidence; no product setting,
authentication file or persisted Hub data changes.

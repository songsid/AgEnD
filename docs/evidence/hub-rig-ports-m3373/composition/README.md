# Composed initialization fixture ports (M-3373, S-191)

At base `b3c1e36e`, the private `initializedHub()` in
`tests/hub-compose.test.ts` chose and closed two sockets before initialization
and mount. It retried duplicate selections up to 20 times. Its directory
runtime helper also retried initial mount collisions with up to three homes.
Neither retry held an address across the selection/start window.

The two existing allocation controls now try real competing binds in the
pre-start hook. On the base, each competitor acquires its selected member or
web port: both cases fail semantically (`expected EADDRINUSE, received bound`).
With held sockets, each competitor is refused and the original home mounts
ready on its first attempt, serving a trusted HTTPS session response.

`initializedHub()` now uses the existing, unchanged `hubListenerPorts()`.
Its real member and web TLS listeners adopt the bound sockets. All allocator
scopes close before scratch roots are removed after each case, including
fixtures that never start. The selection and mount retry loops are removed;
ordinary lifecycle remounts continue using the original configured ports.
No reservation is automatically re-armed after a listener has stopped.

## Preserve the negative checks

The deliberate occupied-web control explicitly releases its unclaimed
reservation, binds an owned competitor and requires failure after exactly one
home/attempt. Nonmatching readiness errors still propagate after one attempt.

Closed-listener probes discard only reservations that never became real
listeners:

- Partial/foreign/missing-secret refusal: neither listener started; release both.
- Missing protected-retention port: factory construction refused; release both.
- Changed material at member-await: the member listener did start. Release only
  the unclaimed web reservation; the member probe still tests production teardown.
- Before-publication and later stop/remount cases already claimed their sockets.
  Their genuine teardown and occupied-port checks retain their original meaning.

The independent TCP self-connection test still uses its intentionally closed
address. The shared lease helper, production code and timeout values are unchanged.

Final validation runs the whole file once (144 cases) and the final single-attempt
control separately after its test-only bookkeeping refinement. Commands and
results are in `validation.json`. Other fixture families remain separate subtasks
and PRs; they are not part of this result.

All TLS, directory and storage state belongs to disposable test fixtures. No
real account, vendor CLI, model, Fleet, Windows or browser campaign runs. Main
has no Hub composition test, so there is no twin. Rollback reverts this test-file
change and evidence only; no product settings, authentication or Hub data change.

# M3144 PR1 — idle-admission foundation

This is a reusable, unmounted controller, not the full Hub update feature. No updater, npm, Fleet lifecycle or
child-process call exists in this module. Tests use an in-memory SQLite database, fake time and a spy named spawn.

- idle-red.log: TDD baseline had no launch/expiry transition. The first two cases failed semantically (zero launches
  after idle; waiting after 24h). The third could not enter preparation yet; do not count it as a semantic assertion red.
- idle-final.log: 14/14 pass. Covers busy wait/idle launch, claim consumption, exact deadline and preparation expiry,
  cancel/revocation/fence, activity returning during preparation, one active request, request conflicts, restart before
  and after claim, persistence failure before spawn, and unknown activity.
- idle-native-source.log / idle-native-tests.log: TypeScript7 source/test programs exit0.

No sleeps, real updates, network, browser, TLS or mutation campaign. Source and generic port documented in
../../design/hub-fleet-updates-api.md. The future host owns service/opt-in/npm checks, owner notices, final-spawn wiring
and update-marker outcome reconciliation. Until it is composed there is no user-visible flow; built-in skill change N/A.
Rollback reverts the unmounted module and retains any additive queue data used by later composition.

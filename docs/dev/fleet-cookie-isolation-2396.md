# Fleet cookie isolation (#2396)

## Root cause and scope

The old session/device names were fixed, with host-only `Path=/` cookies. Cookie
storage uses name/domain/path, not the listener port. This differs from browser
storage and the same-origin policy; see [RFC 6265 §8.5](https://httpwg.org/specs/rfc6265.html#s8.5).

| Dashboard pair | Old collision |
| --- | --- |
| HTTP, same localhost or LAN hostname/IP, different ports | Yes, plain session and device names |
| HTTPS, same hostname, different ports | Yes, `__Host-` session and device names |
| HTTP and HTTPS on the same host | Session/device names differ by `__Host-`; they do not directly overwrite the same slot |
| localhost and 127.0.0.1, or two distinct LAN hostnames | No: different host-only jars |
| Distinct quick-tunnel or named-tunnel hostnames | No: different host-only jars |
| Two pre-fleet setup pages | Already separated by their random `/s/<sid>/` paths |

Two real scratch HTTP listeners with one host-scoped jar reproduce A=401 after
B signs in on the old code. The fixed code returns 200 for both. No fleet,
backend, adapter, tmux or tunnel is started by this harness.

## Names and trust

`fleetCookieName` appends a domain-separated truncated HMAC of persisted
`web.token`. Ports are not inputs. It survives restarts and port moves without a
new identity file. Intentional token rotation changes the namespace and already
invalidates the prior sessions/device signatures. The suffix is public naming,
not authentication: session ids still require the owning store and token epoch;
returning devices still require its signature and registry. Origin/CSRF,
surface, public-exposure ownership and expiry checks remain in force.

Production session, secure-session, device, secure-device and setup issuers use
the suffix. `__Host-` cookies retain Secure, Path=/ and no Domain. The terminal
cookie is already unique per random terminal sid and terminal path.

Setup loads/creates `web.token` after its fleet lock and inside startup cleanup,
before opening listeners. This creates that existing file earlier on a fresh
install. Setup sessions are ephemeral and already end with their process; they
do not migrate across an upgrade. Foreign/legacy setup names are ignored rather
than consuming the new page's five attempts.

## Migration and sign-out

Current names are tried first, then legacy candidates. A candidate is never
accepted merely because its name matches. The fleet checks its own hashed
session store/epoch/surface/exposure or its device HMAC/registry. A stale or
foreign candidate cannot hide a later valid owned one.

A successful `/auth/session` or protected request rewrites an owned legacy
session to the current name, preserving its id, CSRF value and absolute expiry.
`/auth/device` similarly rewrites a verified legacy returning device without
extending its server expiry. Migration does not delete the shared legacy slot.
A cookie already overwritten before upgrade cannot be recovered; that browser
must sign in again.

Sign-out, sign-out-everywhere, current-session revocation and failed durable
revocation clear the fleet's current session names plus its owned legacy names
(and absent old slots). If a legacy slot demonstrably does not authenticate to
this fleet, it is left intact: deleting it would sign a different, not-yet-
migrated fleet out. New sign-in retires all presented owned prior session ids.
Returning-device cookies remain on sign-out as before: they can request a new
private code but do not authorize a session.

The client does not read/write cookie names. Its localStorage/sessionStorage
keys are origin scoped (scheme, host and port), so they need no change for these
port-separated dashboards. Public and guest clients use the same server cookie
paths. A same-origin path-multiplexed reverse proxy is outside this layout.

## Evidence and rollback

Focused tests cover real listeners/shared jar, migration, foreign renamed ids,
sign-out/all-session clearing, preserving another fleet's old slot, devices,
reconstruction/port moves, secure attributes, setup attempts and public admin/
guest downgrades. Isolated Chromium uses one context across two real auth
listeners; it verifies simultaneous sessions, migration, logout isolation,
foreign rejection and per-port localStorage, with no external requests. Its
separate cookie-only matrix checks HTTP/HTTPS port collisions and distinct hosts
without making network requests to those hosts.

Fifteen independent mutations are caught; source is hash-restored. Local heavy
jobs run in private MemoryMax=4G/CPUQuota=200% units. Existing auth, public, guest,
setup and session regression suites retain their semantic assertions.

Rollback is a normal revert. No session/device record format changes. Old code
does not read the suffixed cookies, so rollback may require a fresh sign-in; its
returning-device identity can be re-established by a new private code. Existing
legacy cookies, if still present and valid in that fleet, keep their old behavior.

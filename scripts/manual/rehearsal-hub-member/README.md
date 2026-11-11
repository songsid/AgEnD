# Hub + member-fleet rehearsal kit

A small, copyable rig for rehearsing Hub ↔ member-fleet behaviour on a **real install**:
- both accounts are installed from a private registry and run as systemd user services;
- a real sealed Hub, made by the production initializer, uses an Active Directory profile against a fake LDAPS directory;
- a member fleet pairs over the real HTTPS/WSS member endpoint.

There is no vendor CLI and no real account: the member's agents use the mock backend, and its chat channel is a local Telegram mock.

Use it for setup, pairing, revoke and reconnect, member address, and update checks. It has no update or rollback legs and no tmux legs. Everything stays inside the container or on a private Docker network, and nothing touches the host's AgEnD.

## Safety

- Containers run **without `--privileged`**. `rig.sh` uses exactly
  `--cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined --cgroupns=private --tmpfs /run --tmpfs /run/lock`.
  A privileged systemd container once reset the host's `binfmt_misc`, so the image masks the binfmt units.
- Only the private registry is used. `publish` always names it with `--registry` and a kit-owned `--userconfig`, so `~/.npmrc` is never read or written.
- Passwords are dummies (`Dummy-<login>-only`). The CAs are generated per container and expire after 7 days.
- Don't run `agend` on the host against these files. Use separate container names per rig (`RIG=…`).

## Quick start

```bash
cd scripts/manual/rehearsal-hub-member
export RIG=agend-rhkit            # name prefix: image, network, registry
./rig.sh image                    # the rig image (Ubuntu 22.04, systemd, Node 22)
./rig.sh registry                 # private verdaccio on 127.0.0.1:4890 (REG_PORT)
npm pack                          # from a clean checkout of the commit under test, or use a published tarball
./rig.sh publish /path/to/songsid-agend-<version>.tgz alpha
./rig.sh start agend-rhkit-1 19499            # dashboard proxy on 127.0.0.1:19499
./rig.sh run agend-rhkit-1 setup <version>    # Hub account + member fleet, not paired
./rig.sh run agend-rhkit-1 pair               # admin pairing → paired/online
./rig.sh run agend-rhkit-1 status
```

### Other phases (`./rig.sh run <container> <phase>`)

| Phase | What it does |
| --- | --- |
| `revoke` | alice revokes the member on the Hub. The member reads `held/revoked`; after `restart-member` it reads `held/rejected` (#3615). |
| `restart-member`, `restart-hub` | restart that account's service and wait |
| `update rh\|hub <version>` | `agend update --version <version>` for that account, then restart |
| `trust-hub-ca` | put the rig Hub's CA in the container's OS store. Company-join discovery uses OS trust roots; restart the member afterwards. |

## What is where (inside the container)

| | Address |
| --- | --- |
| Hub web | `https://hub.example.test:18601` |
| Hub member endpoint | `https://hub.example.test:18602` (both resolve to 127.0.0.1 via `/etc/hosts`) |
| Hub account health | `:19380` |
| Member dashboard | `:19280` (proxied to the host port given to `start`) |
| Telegram mock | `:18443` |
| Fake AD | `:636` (`ad.example.test`) |

- **Directory people:** `alice` is the Hub administrator; `alice` and `carol` are in `CN=Owners`, `dave` in `CN=Other`.
- **Hub API as a person:** `drive.mjs hub <login> GET|POST|PUT <path> [json]`, run as `rh`.
- **Member API as its local admin:** `drive.mjs member GET|POST <path> [json]`.
- **`drive.mjs policy`:** turns on group permissions (Owners: chat + connect a fleet).
- **`drive.mjs quickpair <label>`:** pairs this member as carol.

### Browser access

`proxy2.mjs` serves the member dashboard on the published port. It also answers `CONNECT hub.example.test:<port>`, so a host browser can open the Hub's own pages, for example a company sign-in. Launch the browser with `--proxy-server=http://127.0.0.1:<port>` and `--ignore-certificate-errors`, since the rig CA is not trusted on the host. Loopback addresses bypass the proxy by default.

## Files

- **`rig.sh`** (host): image, registry, publish, start, run.
- **`hub-member.sh`** (container): the phases.
- **`hubinit.mjs`**: the production Hub initializer, non-interactive.
- **`ad.mjs`**: the fake LDAPS directory, using `ldapts`' BER from the installed package.
- **`drive.mjs`**: HTTP hands for the Hub and the member.
- **`tg-mock.mjs`**: the Telegram mock.
- **`proxy2.mjs`**: the dashboard and CONNECT proxy.
- **`image/`**: the rig image.
- **`verdaccio.yaml`**: the registry config. `@songsid/agend` is local only; everything else proxies npmjs.

The member's mock agents use `e2e/mock-servers/mock-claude.mjs` from this repo, copied in by `start`.

# systemd 249: the private socket, byte for byte (#1804)

`capture.json` holds real exchanges with a systemd **249.11-0ubuntu3.22** user manager (ubuntu:22.04, root's user
manager, no dbus-user-session, so there is no `/run/user/0/bus`), made over `/run/user/0/systemd/private` by this
repository's own `peerCodec()`, as `systemdPeerBus` makes them. Each entry is the busctl-style arguments, the
request bytes that systemd answered, and the whole reply message, all hex.

The units behind them:

```
# t.service: argv and environments that `systemctl show` cannot print losslessly
[Service]
Type=simple
ExecStart="/bin/sl eep" "a b" c "d\"e" "f'g" "h\\i" "%%" "$$x" ";"
Environment="P=a b" "Q=x\"y" R=z$$w "S=t\\u" T=
UnsetEnvironment="U=a b" V "W=$$x"

# t2.service: two EnvironmentFile= lines (one optional)
EnvironmentFile=/root/x.env
EnvironmentFile=-/root/y.env

# slow.service: Type=notify, started with --no-block, so a start job is queued (Job=7)
```

The manager environment had `systemctl --user set-environment "Q=a b" NODE_OPTIONS="--require /x.js"`, which
`systemctl show-environment` prints as `NODE_OPTIONS=$'--require /x.js'`. `nosuch.service` has no unit file.

Protocol facts found on this host, which the client follows:

- busctl over this socket fails with `Call failed: Invalid request descriptor`: busctl always sends Hello(), and a
  peer connection has no bus driver. busctl 249 has no option to skip it.
- systemd drops bytes that arrive in the same read as `BEGIN`: a call written right behind `BEGIN` is never answered.
  systemctl sends `AUTH`…`BEGIN` up front and its call only after the server's `OK`; so does `systemdPeerBus`.

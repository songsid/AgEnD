# Hub initialization: local interface and port checks

`agend hub init` configures a standalone Hub with two specific listeners: browser HTTPS and member transport. It needs no agent or model login. The existing local-owner confirmation still binds the exact plan; these checks grant no authority and change no network settings.

After collecting the listeners, the wizard resolves each name (a two-second deadline) and tries an exclusive TCP bind. Numeric IP addresses need no DNS. It holds the first socket while binding the second, catching conflicts even when different names resolve to the same endpoint. Every successful temporary socket is closed before the check returns; it serves no application traffic and immediately drops incoming connections.

Invalid and wildcard addresses, unavailable interfaces, occupied ports and permission failures produce bounded EN/zh-TW guidance. No exception text or credentials are printed. The owner can correct the listeners before certificate setup or directory sign-in. Nothing stops another process or changes firewall, DNS, routes, trust stores or port permissions.

The daemon also starts its existing loopback dashboard and preview. The preflight reserves those configured endpoints even when the daemon is stopped: `health_port` (default 19280) and the enabled `web.preview_port` (default health port + 1). It reads the current local configuration at each check. These reservations do not prohibit the same port on a different specific interface.

The wizard repeats the check immediately after the owner confirms and before initializer commit. Resume checks the saved listeners before requesting the bind secret, then checks again after confirmation; it never silently changes a sealed plan. Other wizard tests inject an inert checker where networking is outside their scope; the network suite exercises the real default checker with owned loopback sockets and scratch homes.

This is a point-in-time local bind preflight, not a port reservation through service startup. Another process can take a port afterward; runtime listener startup retains its ordinary fail-closed cleanup. Advertised HTTPS origins may differ from local endpoints behind an explicitly arranged reverse proxy. The wizard therefore says that local success does not prove remote DNS, firewall access, TLS trust or proxy routing, and asks the owner to test both advertised HTTPS addresses from a member computer after startup.

No schema, persisted configuration shape, migration, service control or access policy changes. Rollback is a code revert; existing initialized Hubs are unchanged.

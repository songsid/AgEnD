# Memory-deferred startup (#2461)

Build the candidate and an unmodified pre-fix checkout with the same dependencies
in capped jobs first. Check `free -m`; run at most two heavy jobs fleet-wide and
only one rehearsal container at once. Run from the candidate checkout:

```sh
bash scripts/manual/startup-memory/run.sh /absolute/path/to/baseline/dist
```

The existing `agend-rh-b16-bus` systemd249 image is required. The runner uses a
private PID/cgroup/network namespace, no network, no host mounts, 1.5GiB RAM,
zero swap and two CPUs. It removes only its nonce-labelled container. No host
AgEnD CLI, fleet, tmux, account or vendor call is made. Evidence remains under
`.artifacts/startup-memory-*`.

The persistent user unit comes from actual `agend install --no-activate`; the
manager reloads a test-only eight-second start timeout and 768MiB inner cap.
The real fleet, gate, notification transport, dashboard and mock backend run.
Only the memory-reader input is controlled (critical then healthy); this
reproduces admission deferral without allocating a memory hog or thrashing
the host. A second control injects a non-memory lifecycle hang.

Baseline must restart at least twice from actual systemd startup timeouts.
Candidate must remain activating in the same PID beyond twice the deadline,
withhold READY, serve the dashboard, then become active without a restart
after pressure release and answer through its mock sibling. A non-memory
hang must still time out. This proves timeout convergence, not resistance to
an uninterruptible kernel wait or a main event loop frozen beyond WatchdogSec.

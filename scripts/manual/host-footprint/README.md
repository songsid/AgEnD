# Optional footprint measurement and real-app captures

Run these only in an owned worktree. They create a scratch monitoring runtime and one owned idle Node process, never start the Fleet, a CLI session, tmux, an account or a model, and never scan a workspace or Fleet state recursively. Monitoring and footprint are explicitly enabled in the rig. Local history and incident files use the production capped worker.

The measurement takes at least one real hour. Its process reader, attribution and history are production modules. The owned helper's positive liveness observation is cached before sampling, with a conservative one-second margin; it is not a future timestamp fabricated after the snapshot began. The rig stops the window on a lost root and records observation, snapshot, native-start and pinned-start evidence. Logs and snapshots are private. Do not use an incomplete window as acceptance.

```sh
OUT="$PWD/.artifacts/footprint-hour" nice -n 10 ionice -c 3 node --import tsx scripts/manual/host-footprint/measure.mts
node scripts/manual/host-footprint/validate.mjs "$PWD/.artifacts/footprint-hour/measurement-private.json"
```

Resource counters cover the Node process and its history worker threads, plus CPU from reaped child commands. Peak RSS is the Node process peak, **not** the aggregate peak of child processes (including the source loader and transient process reader). This source rig includes loader overhead that a packaged JavaScript runtime need not incur. `/proc/self/io` write_bytes is the Linux charged storage-write counter, not a device endurance measurement; cancelled/delayed writes can differ ([Linux kernel I/O accounting documentation](https://docs.kernel.org/filesystems/proc.html#proc-pid-io-display-the-io-accounting-fields)). Instrumentation work and its small log writes are included. There is one native idle root, not a native 32- or 128-agent workload. Maximum root/process/batch sizes have separate bounded fixture tests.

Use the completed private cache to render the real app, with synthetic labels and aliases for every opaque disk identifier. Metric values, sample times and recorded buckets stay actual. These are retained cache views, not a claim that the scratch helper is still running after cleanup.

```sh
REPO="$PWD" PW_DIR="$PWD/node_modules" CHROME="/path/to/chrome" \
MEASUREMENT="$PWD/.artifacts/footprint-hour/measurement-private.json" \
OUT="$PWD/.artifacts/footprint-captures" \
nice -n 10 ionice -c 3 node --import tsx scripts/manual/host-footprint/capture.mts
```

Inspect all original images before publication, and publish neither the private snapshot nor raw identifiers. The final UI remains on user-look hold until the assigning administrator releases it.

## Measured acceptance window and precision delta

The accepted window lasted 3,600,132 ms with 60 process samples, 119 host observations, and 59 populated agent CPU/RSS history buckets. Combined CPU was 0.113% of one core / 0.0188% of this six-logical-CPU host, peak Node RSS 134.5 MiB, charged storage writes 13.85 MiB/hour, history 4.18 MiB. Both monitoring options were enabled throughout; this is combined overhead, not a separately measured incremental footprint cost.

Earlier windows are not claimed as acceptance. An instrumented control caught the same live process's ps epoch start shifting back one second. The Linux binder now uses stable kernel start ticks. The final window used that correction. One post-start arithmetic change made the birth-age precision bound more conservative (ceiling boot/tick fractions). Commands, reads, cadence, identity pins and history stayed unchanged. A replay using the final production binder and attribution policy admitted all 60 captured numeric frames, minimum margin 548 ms. This replay proves admission equivalence; it is not a second resource measurement or a claim of a byte-identical final-source hour. The tiny arithmetic delta is outside the measured CPU scope.

```sh
node --import tsx scripts/manual/host-footprint/replay-birth.mts private-run.log 100 private-birth-replay.json
```

For before views, set CAPTURE_PHASE=before and REPO to the clean baseline checkout; the script serves that checkout's actual app assets and records response SHA-256s. Candidate views use REPO at the candidate. Both use the same completed host cache; only candidate views include the recorded agent data. Settings seeds effective and raw scratch configuration consistently. No live configuration is changed. The retained footprint goes through the production snapshot staleness check, with no clock or sample-time rewriting.

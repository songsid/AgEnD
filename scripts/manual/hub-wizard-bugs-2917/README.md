# Hub initializer regression rehearsal (#3658 / M-2917)

Run `bash scripts/manual/hub-wizard-bugs-2917/rehearse.sh [output-directory]` from an owned checkout with dependencies installed. `WIZARD_IMAGE` selects an existing local Ubuntu image containing Node 22, Python, OpenSSL and bash; the recorded run uses `agend-rh-b16-bus-nobinfmt`. No image pull or installation is performed. `WIZARD_BASE` defaults to the tested alpha baseline.

The script builds baseline and candidate, records Git/source/harness and full compiled-tree digests, checks the container copies, then drives the actual CLI with PTYs in both languages. It uses only an owned unprivileged wizard account, separate AGEND_HOME per case, container-loopback fake LDAPS and generated disposable certificates/passwords. No service is installed or started. Docker has no external network, host mounts, published ports or privileged capabilities. Cleanup removes only its own container and temporary baseline tree. The existing Lumen review container is never used.

Cases: empty LDAPS endpoint; Enter at fetched fingerprint; misplaced password at method choice; complete handoff; company-join certificate guidance before the certificate choice. The baseline secret canary in the sanitized transcript is replaced with `<ECHOED-SECRET-CANARY>`. The candidate asserts absence from output/history/unintended files, plus exact bytes and 0600 on the intended private secret. Fixture credentials never enter argv or shell commands.

`python3 scripts/manual/hub-wizard-bugs-2917/mutations.py` runs ten sequential semantic regressions, restoring exact product bytes in a finally block. Run only in an owned checkout without concurrent source edits or tests. Outputs go to `.artifacts/wizard-2917/mutations`. No timeout, test threshold, authority, network trust, or initializer seal is relaxed.

The fake LDAP peer is a plain-JS adaptation of `tests/support/hub-group-directory-wire.ts`, reused from Lumen's Hub UX rehearsal. It models initialization service lookup only; it is not a real AD server or company-join end-to-end test.

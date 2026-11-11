# #3633 acceptance

The source-bound receipt and logs record two fresh Ubuntu 24.04 containers under real local HTTP `curl | bash`. `baseline.log` shows tzdata consuming the remaining script, pipeline exit 0 and missing agend (127). `fixed.log` runs the exact shell bytes in `receipt.json`: zero timezone prompts, full installation, pipeline exit 0 and a separate PATH version check returning 2.3.4/exit 0. The synchronized root and website scripts have the same hash.

Reproduce with [`run.sh`](../../../scripts/manual/install-pipe-3633/run.sh); the adjacent README defines the isolated boundary and cleanup. Node/npm were preinstalled in the fixture; apt/dpkg/debconf and npm installation are real. Supported non-apt paths and nvm are tested with hostile stdin-reading children; no claim of actual macOS/dnf/pacman execution.

`unit.log` is 51/51; `fail-first.log` runs the nine new cases against the unchanged baseline, all red. Native test typecheck, shell syntax, changelog and diff checks pass. The ordinary build/pack/global-install smoke succeeds, including installed `agend --version`; an initial extra runtime-guard assertion used a `v`-prefixed version incorrectly, and `install-smoke-guard.log` records the corrected signature passing without network.

No host packages or system configuration were changed; no model CLI, service, accounts or fleet were started. The containers are ordinary default-capability containers with a memory cap and a read-only evidence mount; no host ports are published. The installer PR remains **deployment HOLD until the Leader's GO**, because merging the website copy deploys it to Pages. No fleet format changes; rollback is a revert of both installer copies.

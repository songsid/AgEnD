Published-package contract evidence for #2704 / M-2038, 2026-10-26.

The tarballs were fetched with `npm pack --ignore-scripts`; packages.json records their exact versions, hashes and sizes. Actual auth handlers were imported in one networkless disposable Linux container (PowerShell 7.4.2, Node 22.22.2, scratch HOME/AGEND_HOME, 1 CPU/1 GiB). No fleet, backend, account, Windows desktop or real WSL was started. Health responses were explicit inert snapshots.

The original live installer generated program follows `/` to protected `/ui` and fails with 401; the corrected generated program uses public `/signin` and succeeds. The replay helper is scripts/manual/installer-compat/verify-published.mjs. The original live install-agend.ps1 SHA256 was 7ab82968cb12cc639bc1b71872b51028d8a6cae3945f46278ec70364799349f5.

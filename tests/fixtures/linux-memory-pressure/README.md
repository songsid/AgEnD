# Linux pressure fixture

Reported WSL2 measurements from #1707 (2026-10-12): RAM total32098 MiB, available17351 MiB; swap8192 MiB, free330 MiB. Alert-time diagnostics were16171/384 MiB. Both have ample available RAM. `total=0` counters are synthetic because the report supplied only averages; counters do not drive policy. No host/account details or live reads. Format: https://docs.kernel.org/accounting/psi.html .

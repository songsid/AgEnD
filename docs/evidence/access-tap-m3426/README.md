# Settings Access tap target — M-3426

The Cloudflare connector-token card's Set token action is a direct child of a Settings card. `.btn-sm` sets a 30px minimum height; the existing phone rule raises row actions to `--tap` (44px), but excludes standalone card actions. The full Settings gate enables this action while exercising the form and reports the undersized target.

Introduced by commit 43d1ba5a025483b4a1e8442edaf6644b578baaf0, #2321 (21 October 2026): the card added direct `.btn.btn-sm` actions while the shared phone rule covered only rows. The same defect reproduces on unchanged main 304d328a.

The shared phone rule now gives every Settings `.btn` button a minimum width and height of `--tap`. It uses the existing phone breakpoint and leaves desktop rules unchanged. Thirteen obsolete small-button allowances are removed; no allowance is added. Applying this only to standalone card buttons would leave two heights for the same Settings button kind, so the common button rule covers both standalone and nested actions. No authentication, token handling or routing changes.

Validation: unchanged main Access-only gate fails on the reported target (1 failure). Final normal CI Settings matrix passes 94 checks; the full eight-case Settings matrix passes 479 checks, including every section, intermediate desktop widths, self-tests and the stale-allowance check. CSS balance passes 10 tests; changelog validation passes. Direct desktop/phone measurements and the real-app phone Access original are under `captures/`. The capture fills a synthetic token to enable Set token but never submits it, calls a provider or starts a Fleet. Main merges first; the dev twin follows from its actual current tip. Both post-merge CI results are required for completion.

Rollback: revert the shared CSS rule; no data migration or saved preference changes.

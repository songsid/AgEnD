These are real Chrome 156 screenshots from isolated product HTTP/HTTPS listeners, with a scratch fleet/Hub database and fixture-only people/content. No live fleet, CLI or Windows host was used.

Before: alpha `9f91511e2` (common fleet sources also audited against main `6535679d9`). Chrome DevTools network emulation applies 150 ms latency, 250,000 bytes/s download and 100,000 bytes/s upload. The relevant initial request is held until the PNG is saved, then released. Desktop is 1366×900; phone is 390×844. EN uses light and zh-TW uses dark. Both languages are captured at both sizes.

The scripts are `scripts/manual/smoke/smoke-loading-audit.mts` (normal, `MODE=extras`, `MODE=readiness`) and `smoke-hub-loading-audit.mts` (normal and `ONLY=hub-new-chat`). They import the checkout named by `REPO`; Playwright is supplied through `PW_DIR`. The pending search-context fixture is synthetic. Other initial reads use the real fixture listener; screenshot timing does not claim real backend latency.

Agent Details is a passing control: its existing skeleton is retained. Needs/Notices captures wait for their actual panels to mount, so the shell's earlier module-loading skeleton is not mistaken for the page's own state.

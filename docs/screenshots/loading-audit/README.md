These are real Chrome 156 screenshots from isolated product HTTP/HTTPS listeners, with a scratch fleet/Hub database and fixture-only people/content. No live fleet, CLI or Windows host was used.

Before: alpha `9f91511e2` (common fleet sources also audited against main `6535679d9`). Chrome DevTools network emulation applies 150 ms latency, 250,000 bytes/s download and 100,000 bytes/s upload. The relevant initial request is held until the PNG is saved, then released. Desktop is 1366×900; phone is 390×844. EN uses light and zh-TW uses dark. Both languages are captured at both sizes.

The scripts are `scripts/manual/smoke/smoke-loading-audit.mts` (normal, `MODE=extras`, `MODE=readiness`) and `smoke-hub-loading-audit.mts` (normal and `ONLY=hub-new-chat`). They import the checkout named by `REPO`; Playwright is supplied through `PW_DIR`. The pending search-context fixture is synthetic. Other initial reads use the real fixture listener; screenshot timing does not claim real backend latency.

Agent Details is a passing control: its existing skeleton is retained. Needs/Notices captures wait for their actual panels to mount, so the shell's earlier module-loading skeleton is not mistaken for the page's own state.

`before-main` is an additional matching baseline from main `6535679d9`; use it with `after-main`. Alpha's newer Settings layout differs from main, so the original `before` folder is reserved for alpha comparisons. `after-main-skew` serves main's old app.css **and** ui-states.js with current panels. It checks visible fallback bars, reduced motion, a stable surrounding frame and termination after the held read is released. zh-TW cases use reduced motion. No new skeleton export is required by a lazy panel.

The browser also compares the full Profile card and sign-in card bounds during the held read and after it completes (2 px tolerance); the form stays reserved and inaccessible during loading. Profile retains its original field spacing.

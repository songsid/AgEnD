# Company-account Hub join — design mockups

**Design proposal only. Not implemented UI, runtime acceptance or approval to build.** These PNGs accompany the company-account Hub join design requested on 2026-11-08 (decision48495ef8). The public design issue is the authority for the proposed flow; these images illustrate its user-facing states.

| PNG | Proposed state |
| --- | --- |
| [01-fleet-company-link.zh-TW.png](01-fleet-company-link.zh-TW.png) | Fleet Settings → Hub, prefilled company link; automatic identity match; one Start action |
| [02-hub-company-signin.zh-TW.png](02-hub-company-signin.zh-TW.png) | AD credentials entered on the company Hub, showing the target Fleet origin |
| [03-fleet-connected.zh-TW.png](03-fleet-connected.zh-TW.png) | Back on the Fleet after its pinned link is ready; no automatic agent sharing |
| [04-fleet-first-use.zh-TW.png](04-fleet-first-use.zh-TW.png) | Typed address/TOFU: explicitly first use, not verified company provenance |
| [05-fleet-identity-changed.zh-TW.png](05-fleet-identity-changed.zh-TW.png) | Changed identity stops before sign-in; no continue-anyway action |
| [06-hub-no-permission.zh-TW.png](06-hub-no-permission.zh-TW.png) | Company account lacks connect-fleet permission; no credential issued |
| [07-admin-once.zh-TW.png](07-admin-once.zh-TW.png) | One-time group policy and company-link distribution, no per-Fleet approval |
| [08-fleet-company-link-dark.zh-TW.png](08-fleet-company-link-dark.zh-TW.png) | Start proposal using the existing dark tokens |

All screenshots are zh-TW desktop1366×900, rendered from static mockup HTML with the repository's existing `tokens.css` and `app.css` at source86d8f3899406f91370ad25b82af02fef01a0811e. Shared visual language: `.card`, `.s-section-layout`, `.field`, `.btn`, `.btn-primary`, `.btn-danger`, `.tag`, `.note`, `.err`. No product component or stylesheet changes.

Rendered with local Chromium156.0.8078.4 and Noto Sans CJK TC. All eight have a visible “設計提案 · 尚未實作” banner. Geometry checks found no horizontal or main-panel vertical overflow; visual review checked CJK, action visibility, light/dark contrast and the distinction between link identity matching and TOFU. A native-looking numeric field and muted disconnect action were corrected to the existing field/destructive-button treatments and reinspected.

Example `.test` hosts, names and credentials are fictional. No Fleet, Hub runtime, CLI, directory, model, account, pilot, tmux or deployment was run for these mockups. Only design PNGs and this index are committed. Runtime/real-browser protocol acceptance is a future implementation gate, not established by these images.

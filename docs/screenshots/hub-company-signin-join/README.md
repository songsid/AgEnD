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

All screenshots are zh-TW desktop 1366×900. **01, 03, 04, 05 and 08 were refreshed after the user's layout feedback:** they now render the real `app.html`, app sidebar, Settings section menu (Hub selected), PageHead and existing Settings framing from source `9b06e6bdb`. The product web server runs through the existing isolated smoke fixture, with a scratch HOME and no Fleet daemon start. Only the lazy `HubMembershipSettings` component is replaced in the browser with proposed content. Both navigation columns and the rest of the shell are unchanged.

02, 06 and 07 remain static Hub-side design studies using `tokens.css` and `app.css` from source `86d8f3899406f91370ad25b82af02fef01a0811e`; they must follow web-claude's new Hub shell when that design is approved. They do not claim to show that pending shell.

Rendered with local Chromium 156.0.8078.4 and Noto Sans CJK TC. The five refreshed Fleet images have a visible “設計提案 · 尚未實作” label inside the proposed card, the actual Settings sub-navigation, no horizontal overflow, no page errors and no CSP reports. Visual inspection checked CJK, action visibility, light/dark contrast and the distinction between link matching and TOFU. Shared visual language: `.card`, `.s-group`, `.s-row`, `.field`, `.btn`, `.btn-primary`, `.btn-danger`, `.tag`, `.note`, `.err`. No product component or stylesheet changes.

Example `.test` hosts, names and credentials are fictional. No live Fleet, CLI, directory, account, pilot, tmux, model or deployment is used. The Fleet refresh uses only the owned test web listener and browser. These are **proposed content in the real shell**, not implemented join behavior or protocol acceptance. Only PNGs and this index are committed on this design branch.

# S-118 unified-input PNG proposal

Latest user direction: one box accepts six-digit authenticator codes and eight-character device sign-in codes. No name field, Settings-name row or “switch to device code” action. Complete values are intended to submit automatically; the Sign in button remains visible. This supersedes the separate fallback-mode proposal at68392df6.

| Language / screen | Primary | Wrong code (6-digit route) | Paused | Wait for next code (proposal) | Reach help |
| --- | --- | --- | --- | --- | --- |
| zh-TW / desk-light | [PNG](desk-light-zh-TW-primary.png) | [PNG](desk-light-zh-TW-wrong.png) | [PNG](desk-light-zh-TW-paused.png) | [PNG](desk-light-zh-TW-next-code.png) | [PNG](desk-light-zh-TW-reach.png) |
| zh-TW / phone-dark | [PNG](phone-dark-zh-TW-primary.png) | [PNG](phone-dark-zh-TW-wrong.png) | [PNG](phone-dark-zh-TW-paused.png) | [PNG](phone-dark-zh-TW-next-code.png) | [PNG](phone-dark-zh-TW-reach.png) |
| en / desk-light | [PNG](desk-light-en-primary.png) | [PNG](desk-light-en-wrong.png) | [PNG](desk-light-en-paused.png) | [PNG](desk-light-en-next-code.png) | [PNG](desk-light-en-reach.png) |
| en / phone-dark | [PNG](phone-dark-en-primary.png) | [PNG](phone-dark-en-wrong.png) | [PNG](phone-dark-en-paused.png) | [PNG](phone-dark-en-next-code.png) | [PNG](phone-dark-en-reach.png) |

All20 frames check overflow, common top, one empty input, no switch/name, and44px controls. The zh helper is exactly one line: 也可以貼上 8 字元裝置登入碼. The six requested zh primary/wrong/paused originals receive a full-size visual check. Disabled states use the existing semantic text/background tokens; receipts record resolved colours/opacity for contrast checks (light5.57:1/dark5.49:1). The wrong-code PNGs depict the authenticator route’s401; rejected eight-character codes keep their existing route-specific guidance, not the authenticator-clock hint. SHA256SUMS pins each image.

Real #3548 sign-in shell; presentation-only DOM/CSS projections, every POST refused. Automatic submission is a design requirement, not a working feature in this branch. Junsion owns the core matching/next-code response; no guessed status, timer or identity disclosure is shown. The pause illustrates five minutes rather than a fixed policy.

Alphabet check found A–Z/2–7, fixed length8. Full values separate by length, but a device code can have a six-digit prefix, so a “never submit a partial device code” guarantee during incremental typing needs a rule before implementation. See the [design note](../../design/authenticator-signin-s118.md). No core alphabet/route change is made.

User PNG approval, Junsion core merge and explicit Leader GO are required before product implementation. No real account, fleet, CLI, tunnel, Devices overview, sign-in/security/SKEW/release acceptance. Older Settings-name/fallback images remain in git history only. Existing8碼 Settings wording will receive the authorized glossary alignment in the eventual PR, not this design commit.

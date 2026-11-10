# S-118 presentation-only mockups

Real alpha sign-in shell at `b394feedc1ce7619a607b0fd114604c8bdd7ebdf`, with a proposed DOM presentation.
No production source is changed. Authentication POSTs are refused; no real account, fleet, CLI, tunnel or authenticator is used.
The per-admin new-device sign-in contract is not provided by #3503; see [the design note](../../design/authenticator-signin-s118.md).

| State | Desktop, light, zh-TW | Phone, dark, zh-TW |
|---|---|---|
| Authenticator primary | [PNG](desk-light-zh-TW-primary.png) | [PNG](phone-dark-zh-TW-primary.png) |
| How the phone reaches AgEnD | [PNG](desk-light-zh-TW-reach.png) | [PNG](phone-dark-zh-TW-reach.png) |
| Eight-character code fallback | [PNG](desk-light-zh-TW-fallback.png) | [PNG](phone-dark-zh-TW-fallback.png) |
| Wrong or used code | [PNG](desk-light-zh-TW-wrong.png) | [PNG](phone-dark-zh-TW-wrong.png) |

English primary: [desktop](desk-light-en-primary.png), [phone](phone-dark-en-primary.png).

Hashes, base, browser version and geometry: [receipt.json](receipt.json).

All 10 captures pass the geometry checks (no sideways scroll, reachable card top, visible actions at least 44px high).
The unchanged baseline `tests/signin-outside-3008.test.ts` passes 6/6 and retains the current outside-entry-only boundary.
No successful authentication or SKEW acceptance is claimed by these mockups.

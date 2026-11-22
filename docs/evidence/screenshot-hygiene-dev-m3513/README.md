# Legacy screenshot privacy refresh — dev (M-3513)

The original fixture exposed prohibited instance suffixes in public evidence screenshots. This packet replaces affected current views with explicit example identities, retains two historical Usage-dialog details as crops, and withdraws historical/retained controls that today’s bounded replay did not reproduce honestly. Git history is not rewritten.

Both branches were inventoried conservatively through November19 around #4198:2626 original paths and2100 distinct images. Every distinct image was visually checked at native-resolution regions; supplemental OCR did not replace visual inspection. No unresolved originals remain. Main’s separate packet merged in #4333 as `5d94cdf10e60f98808b787ae5272962f6717833a`; its five post-merge workflows passed.

Dev’s original2555 paths contain731 affected paths:517 are recaptured, two historical dialog details cropped,212 withdrawn. Each affected family README and `privacy-refresh-m3513.json` explains its scope, exact replacement hash and historical limitations. The original source/test receipts remain historical; a new PNG never silently renews those behavioral claims.

- [Original inventory](dev-inventory.json): original blob/date, visual index and disposition status.
- [Every affected path](dispositions.json): replacement/withdrawal/crop binding.
- [Audit summary](audit-summary.json): per-family counts, manifest checks and limits.
- [Visual bindings](replacement-visual-check.json): every changed present PNG was privacy-checked.
- [Known affected blobs](known-affected-blobs.json) and [guard results](known-blob-check.json): base is red; current tree has no known affected blob, including duplicates at another path. This is a remnant guard, not a new image detector.

Current captures use owned scratch homes/listeners, synthetic roster and inert provider/IPC/updater inputs. Original legacy phone/header selectors remain strict by default; explicit current-only capture paths use today’s context sheet and Settings-owned navigation. No production UI, permission, action, timeout or retry behavior changes.

Limits include narrow Settings wrapping, truncated long labels, scrolled menu content, some transitional first-open frames and unavailable reaction words. These are documented per family; this hygiene work does not claim layout repair, complete offscreen reachability, provider/native execution or old-client parity. Two Usage crops retain the original overlap defect and exclude private background. Rollback should retain the sanitized images or withdraw them; reverting to known affected PNGs would reintroduce the privacy issue.

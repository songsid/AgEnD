# AgEnD 2.3 — development preview

This page tracks the 2.3 feature branch; it does not describe 2.2 stable.

- Settings → Web appearance manages Canvas Worker effect files and saves chat or personal choices. Opted-in local signed-in Chat plays its placed effects, with Pause/Resume in More → Effects. Personal page/header/sidebar/box choices play across supported stock pages in that same pool, with slot Pause/Resume in Appearance. The host cursor uses a static image and keeps stock pointer/text/resize fallbacks, without running Worker code. Widgets are drawn by the host, never supplied HTML.
- Agents can offer Try cards. Only a local admin click starts a clipped temporary sample; nothing is applied or saved. Custom CSS must be off, and closing, navigating, blurring or opening another menu/dialog stops it.
- A chat can show a static poster behind content when preview is unavailable, consent is missing, motion/data settings prevent playback or the page is a public link. Safe mode and the show switch hide it; no poster means no image. Public links get no Worker code or Effects playback controls. Their show switch stays in this browser, separate from host defaults.
- Personal choices stay separate for each platform sign-in. Web-only host-operator sign-ins explicitly share host-wide choices. An unshared personal effect remains saved but unavailable until Clear; future resource reads are refused, while its reference is retained. Chat placements keep their separate retained-runtime policy.
- Before playback, the host must prove stock UI ordering and protected paint. Agent foreground effects stay paused while custom CSS is active, loading or unknown; their status links to Appearance. Human placements retain that agent-rule exemption. Behind effects still need proven ordering; menus/dialogs, safe mode, consent, caps and performance restrictions still apply.

A trusted foreground/paint-containment plane is a later 2.3.x follow-up (#1940). See the [stock paint design](design/1629-stock-effect-trust.md) and [owner choices](design/1629-owner-effect-client.md) for current limits.

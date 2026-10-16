# AgEnD 2.3 — development preview

This page tracks the 2.3 feature branch; it does not describe 2.2 stable.

- Settings → Appearance manages Canvas Worker effect files and saves chat or personal choices. **Playback is not connected yet**; saving does not start an effect. Widgets are drawn by the host, never supplied HTML.
- Personal choices stay separate for each platform sign-in. Web-only host-operator sign-ins explicitly share host-wide choices. An unshared personal effect remains saved but unavailable until Clear; future resource reads are refused, while its reference is retained. Chat placements keep their separate retained-runtime policy.
- Before playback, the host must prove stock UI ordering and protected paint. Agent foreground effects stay paused while custom CSS is active, loading or unknown; their status will link to Appearance. Human placements retain that agent-rule exemption. Behind effects still need proven ordering; menus/dialogs, safe mode, consent, caps and performance restrictions still apply.

A trusted foreground/paint-containment plane is a later 2.3.x follow-up (#1940). See the [stock paint design](design/1629-stock-effect-trust.md) and [owner choices](design/1629-owner-effect-client.md) for current limits.

# Hint spacing follow-up

The Leader requested matching field-hint spacing before the user look. The only production delta is `.hub-signin-form .note { margin: 0 0 14px; }` in the scoped Hub sign-in stylesheet, matching the existing14px field gap. No words, authentication, throttle, DOM contract or disabled-state behavior changed;「AD 帳號」stays.

The actual real-app capture driver measures14px above and below the hint in all8 form views. In the refused desktop state, the Sign in button was enabled, hovered and opacity0.88; after moving the pointer away it remained enabled at opacity1. This confirms the darker old frame was hover styling, not disabled (disabled styling is opacity0.6). Current refused frames use the resting enabled appearance.

Only10 changed originals were retaken:8 form views plus2 refusal views. Both signed-in PNGs remain byte-identical to1ffb1668 and were not recaptured. The10 changed originals were individually inspected by the builtin image viewer: balanced separation/readability, no overflow/clipping/privacy finding. All browser contexts/listeners/scratch homes closed. Runtime asset generation passes; the315 focused tests and production compiler/build at1ffb1668 carry for unchanged JS/authentication scope; no test/compiler campaign was repeated for this scoped CSS edit. New exact-head CI is required.

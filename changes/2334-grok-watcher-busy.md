---
section: Fixed
---
- **Grok: Watchers panel animation no longer keeps instances stuck in "busy" (#2334).** Grok Build's Watchers panel uses braille spinner glyphs and an elapsed timer, matching the old busy pattern even after the active turn finished. The pattern now requires the `[stop]` cancel button that Grok shows on all real turn-status lines (`Waiting for response`, `Compacting`, `Run Read …`, etc.) — the Watchers panel does not carry `[stop]`, so it is correctly ignored.

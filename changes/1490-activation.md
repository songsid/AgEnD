---
section: Fixed
---
- Updates use the actual restart outcome: pending returns exit 75 and retains repair copies, while failed activation returns exit 1 instead of success (#1490). A failed systemd start can restore this update's package and unit preimages only with unchanged loaded/disk ownership and a confirmed stopped runtime; recovery proves the old loaded target before starting it and still reports the update as failed. Unknown/changed owners and detached failures require operator inspection. System-source Node mismatches now explain user-unit, system-unit and launchd recovery without weakening restart checks.

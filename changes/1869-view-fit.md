---
section: Fixed
---
- **Web: View's terminal fits the window again (#1869).**
  - With Fit (the default), a wide pane is no longer held at a 12 px minimum that pushed it past the window. It is never sized larger than what fits, down to a 6 px floor.
  - A slightly smaller window now always shrinks the text.
  - Choosing S / M / L on Chat or any other page no longer turns View's Fit off. Only View's own **Text size** button does.
  - Devices whose Fit was turned off that way get it back once.

---
section: Fixed
---
- **Memory · other containers no longer slow AgEnD's agent starts.** On WSL the system-wide memory-pressure figure also counts other distros and Docker containers; one container squeezed against its own memory limit could make AgEnD report "elevated" pressure with gigabytes free and hold back new agents. AgEnD now judges by its own processes' memory pressure, and shows the system-wide figure only as a labelled host-wide value.

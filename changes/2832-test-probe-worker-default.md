---
section: Fixed
---
- Isolate test-triggered model discovery with a shared fake probe Worker by default, preventing unrelated Settings saves from reaching real backend CLIs. Intentional native Worker tests retain an explicit opt-in under the process guard.

---
section: Fixed
---
- A Settings change to a fleet.yaml value shared through a YAML anchor and alias (`&admins` … `*admins`) now changes only the place it names (#2208). Before, adding a user to one connection's access list either failed with "Expected YAML collection" or saved and gave the user access on the other connection too. Each place is its own value when loaded; a written place gets its own copy; untouched anchors stay; a save that would change anything else is refused.

---
section: Upgrade Notes
---
- **Kiro upgrade recovery (#906, #1624, #1800).** Resumed conversations keep their saved agent: AgEnD does not automatically type /agent swap, and does not retry that suspended switch on later launches. New instances without identity or launch history may adopt an unclaimed latest conversation only when peer-directory ownership is known safe; a conflict or unknown ownership starts fresh. Existing conversation claims prevent another instance taking the same ID. Untagged legacy steering files are retained with a warning; remove them manually only after coordinating all fleets using the directory. See the Kiro upgrade-recovery guide.

---
section: Security
---
- Windows Runtime checks custom and default profile permissions before reading state. New directories are private from creation; shared, replaceable or unverifiable existing paths are refused without rewriting their ACLs or unrelated files. Very large profiles may exceed the bounded check; choose a dedicated private directory.

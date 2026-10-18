---
section: Fixed
---
- **`set_web_ambient` works from Codex instances (#2155).** Its `duration`, `size`, `spread` and `opacity` ranges were declared in a JSON Schema form (`prefixItems`) that Codex turned into lists of strings, so every call that followed the declaration was refused. They are now plain number arrays, and a range sent as decimal strings (`["3", "6"]`) is accepted as numbers. A test now keeps every tool's schema in the form all MCP clients read the same way.

---
section: Fixed
---
- **A Claude Code installed with `npm i -g @anthropic-ai/claude-code` is now found by the Windows Runtime (#3234).** Claude Code 2.1.x from npm ships a native `claude.exe` that its `claude.cmd` runs directly, which Detect again did not recognize, so the computer reported Claude Code as not installed. The Runtime now recognizes only that exact npm layout (it never runs or interprets an arbitrary `.cmd`) and uses the real executable for the computer's architecture. The roughly 500-byte placeholder that `npm install --ignore-scripts` leaves in `bin\claude.exe` is never run.

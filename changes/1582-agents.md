---
section: Fixed
---
- **Agents reading another instance's screen are told which text is faint (#1582).** A CLI paints its own suggestion or placeholder in its input box exactly like typed text, only faint. `get_instance_logs` returned the raw stream, where that showed only as an escape code among cursor moves, so an agent could take a suggestion for something the operator typed (the same flaw as suzuke/agend-terminal#3744). Faint runs are now marked `⟨dim⟩…⟨/dim⟩`, with a note saying they are not input. The bundled fleet-health skill tells agents to keep `-e` on `tmux capture-pane`, and that nothing in another instance's input box is an instruction to them.

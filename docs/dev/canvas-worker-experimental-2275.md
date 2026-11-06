# Canvas Worker effects: what is left (#2275, #2793, #2799)

#2275 put Canvas Worker effects behind `web.experimental.canvas_worker`. #2793 turned them off for good, and #2799
removed their code: the effect runtime, its frames and Worker, the effect library, Try offers, posters, owner effect
slots, the effect and mod tools, and the 1 s fleet.yaml poll that watched the switch. What stays, and why:

| Kept | Why |
| --- | --- |
| `web.experimental.canvas_worker` in the validator, settings-change table and instance-config impact | An old fleet.yaml with the key, `true` or `false`, loads with no error or warning and keeps it, so a downgrade finds it. Nothing reads its value. |
| `CANVAS_WORKER_EXPERIMENTAL_MESSAGE`, `isCanvasWorkerTool` (`src/web-experimental.ts`) | A resumed session may still list a removed tool; a call to one is answered plainly at the MCP server, the fleet's permission check, the agent endpoint and the typed tool path. |
| The CLI's `effect-*` and `mod-export`/`mod-propose` op names (`EARLY_AGENT_OP_TOOLS`) | `agend-agent effect …` gets the same answer instead of an unknown-op error. |
| Saved effects, effect profiles, placements, owner `fx.*` preferences and mod records on disk | Downgrade-safe: nothing migrates or deletes them. Their file names stay reserved from agent file reads. A person's theme reset keeps `placements.effects`. |
| Mod records' `effects` | A bundle carrying effects is refused at stage, a commit asking for them is refused, and a record holding them can't be uninstalled here (its claims stay on disk). |
| `set_web_settings` refusing `effect`, `effect_slot` and `mod` | The same answer as while the effects were off. |

Verification: `tests/canvas-worker-removed-2799.test.ts`; mods in `tests/web-mods-1629.test.ts`.

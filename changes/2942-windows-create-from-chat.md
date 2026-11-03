---
section: Changed
---
- A Windows agent can now be created or configured from Discord or Telegram too, but only by a fleet admin's confirmation on a General card. When an agent calls `create_instance` with `runtime: "windows"`, or `update_instance_config` on a Windows agent (display name, description, model only), the call does not create or change anything: it is held as a pending request, and its card shows the drive path, the sandbox mode and the other settings. Only a fleet admin's **Confirm** in General applies it, once; **Reject**, or no confirmation within five minutes, changes nothing. The web dashboard path is unchanged.
- Still refused: `replace_instance`, `deploy_template`, a Windows switch that is off (refused at once, and again at confirm), and any Windows setting an agent cannot request from the web editor.

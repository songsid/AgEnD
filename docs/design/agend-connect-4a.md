# Local personal-app connector — phase 4a (M-3221)

`agend connect` is a stdio MCP server for the local person's app. It implements row 2 of §7 and phase 4a of the [approved connector design](https://github.com/songsid/AgEnD/blob/9cf2a9edc/docs/design/agend-connector.md). It reuses M-3183's static catalog rule, existing Fleet chat delivery/reply history, and the task board's read projections. It does not introduce the later module registry or remote/Hub connector.

## Use

Keep your Fleet running. In **Settings → Chat & connections → Connect your app**, choose Claude Code, Codex or another MCP app, then copy the setup prompt into that app. Review the prompt before using it. It contains only the stdio command and arguments, with no token or credentials. For a Windows app talking to WSL, it uses `wsl.exe -d <distribution> -- agend connect`. A named nondefault Fleet adds `--home <directory>`. When a system service lacks `WSL_DISTRO_NAME`, the card asks for the exact distribution name instead of guessing the Windows default.

The four tools are `list_agents`, `send_message`, `read_answer`, and `task_board`. A message is ordinary chat; slash commands are refused. `send_message` returns after the handoff, not after the agent's turn. Use its `after` cursor with `read_answer`. Those reads are the selected agent's chat replies and can include replies to other conversations; the connector does not claim exact turn correlation. Returned agent text and task text are data, not instructions.

## Owner and lifetime

The Fleet owns a separate `operator/connect.sock`, with a 0700 directory and 0600 socket under the private, UID-checked AgEnD home. Apps do not connect to an agent's channel socket. Caller names, session names, owner fields, tool profiles and administrative operations are not accepted. Same-OS-user access is the owner boundary, consistent with the existing operator controls; it does not isolate mutually untrusted processes running as that same user. Native Windows apps use WSL, not a new TCP listener.

The Fleet selects the configured agent and rechecks its configuration identity across a wake and handoff. The app cannot create/delete agents, change settings, approve anything or create a verified human receipt. Messages are labelled “Local app”; their origin is not proof of a person's go-ahead. Existing agents' role/profile ceilings are unchanged.

The catalog is fixed and local: listing tools never reads Fleet or Hub state. Calls to an absent Fleet return a readable refusal. Each private-port request has bounded bytes, clients and time. Shutdown fences admission synchronously and closes the owned socket in the Fleet drain; it never removes an unrelated file.

The Fleet retains up to 512 send outcomes in the current process. A repeated returned `operation_id` must match the original agent/text and only reads that outcome, including an uncertain one. Unknown IDs after restart are refused; they never become fresh sends. If the connection loses an outcome before returning an ID, read answers before explicitly starting another message. There is no automatic input replay or durable send-retry claim. Answer cursors include the history boot identity; large reads are bounded and report truncation/more.

## Validation and rollback

The acceptance packet distinguishes SDK/Unix-port tests, inert FleetManager/SQLite delivery, headless WSL Settings checks and real isolated CLI clients. It does not claim live-Fleet, AD, Windows desktop or Hermes execution. Unchanged agent tools and the Hub remain independent of this door.

Rollback removes the command, Settings card and private listener. It changes no Fleet config schema, agent role, personal CLI configuration or persisted agent history. Removing a copied MCP entry is the app user's choice; stopping the Fleet makes calls unavailable while the static catalog remains readable.

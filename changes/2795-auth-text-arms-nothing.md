---
section: Changed
---
- An agent that merely quotes a login error ("Please run /login", "401 Unauthorized") no longer makes AgEnD treat it as signed out while the sign-in check runs. Before, messages to it carried "showed an authentication error message … Check its credentials", and its stuck alert and MCP auto-restart were held until the check, which on our host came back fine every time. Now only a failing sign-in check counts. A real expired login is still caught, paused and reported with the /login button exactly as before.

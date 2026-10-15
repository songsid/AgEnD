---
section: Fixed
---
- **The check after a `/login` install no longer stalls the fleet (#1877).** After an install, AgEnD asks a login shell where the new CLI is. A login profile that starts something in the background could hold that check, and with it the whole fleet, for 10 seconds: no messages, no deliveries, no systemd watchdog ping. The check now runs in the background and ends when the shell does. If the shell outlives its time limit, prints too much, or leaves something holding its output, that lookup's processes are stopped.
- **A missed systemd watchdog ping is now logged.** If AgEnD skips a ping because `fleet.pid` names another process, or `systemd-notify` fails, the fleet log says so (at most once every 10 minutes). Before, the ping just stopped and systemd's restart had no visible cause.

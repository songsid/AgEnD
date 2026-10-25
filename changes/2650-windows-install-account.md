---
section: Fixed
---
- **The Windows installer no longer installs for the wrong Windows account (#2650).** WSL, AgEnD, the desktop shortcuts and the automatic resume after a restart all belong to the account the installer runs as. When a standard account approved the Administrator prompt with another administrator's password, the installer used to put all of it in that other account's profile. Now it stops before changing anything, names both accounts, and says what to do: ask IT to give the account administrator rights for the install, or sign in as the other account. Before a restart, the installer names the account to sign in with, since the resume and the saved progress only exist under that account.

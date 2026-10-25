---
section: Changed
---
- **kiro never updates itself under AgEnD (#2598).** Every kiro chat AgEnD starts now carries `KIRO_NO_AUTO_UPDATE=1`: the instance launch, and the version, help and model-list checks. kiro-cli 3.0 drops the classic engine most kiro instances run on, and a self-update to it would break them in place. AgEnD now keeps each instance on the kiro version that was installed and checked. To turn off updates for kiro-cli itself as well, set `app.disableAutoupdates` to `true` in `~/.kiro/settings/cli.json`.

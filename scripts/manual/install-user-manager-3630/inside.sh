set -euo pipefail
export HOME=/root AGEND_HOME=/test-data XDG_RUNTIME_DIR=/run/user/0
unset VITEST DBUS_SESSION_BUS_ADDRESS
mkdir -p /test-data /root/.config/systemd/user
printf 'defaults:\n  locale: zh-TW\ninstances: {}\n' > /test-data/fleet.yaml
systemctl start user@0.service
systemctl --user start dbus.socket
cat > /root/.config/systemd/user/com.agend.fleet.service <<'UNIT'
[Unit]
Description=3630 inert stand-in; never an AgEnD Fleet
[Service]
ExecStart=/usr/bin/sleep infinity
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user start com.agend.fleet.service
old=$(systemctl --user show com.agend.fleet.service -p MainPID --value)
test "$old" -gt 1
# Only these container-owned /run tmpfs entries are unlinked. Their manager remains active.
python3 - <<'PY'
import os
for p in ['/run/user/0/bus','/run/user/0/systemd/private']: os.unlink(p)
PY
systemctl is-active user@0.service
! test -e /run/user/0/bus
! test -e /run/user/0/systemd/private
set +e
(cd /before && node --import tsx src/cli.ts install) > /tmp/before.txt 2>&1
before=$?
(cd /candidate && node --import tsx src/cli.ts install) > /tmp/after.txt 2>&1
after=$?
set -e
test "$before" -eq 1
test "$after" -eq 1
grep -q 'Run manually: systemctl --user daemon-reload' /tmp/before.txt
grep -q '仍在執行，但連線用的兩個通訊端不見了' /tmp/after.txt
grep -q '環境變數無法重建' /tmp/after.txt
grep -q '會停止 Fleet 和其中所有 Agent' /tmp/after.txt
systemctl is-active user@0.service
kill -0 "$old"
! test -e /run/user/0/bus
! test -e /run/user/0/systemd/private
printf '\nBASELINE OUTPUT\n'; cat /tmp/before.txt
printf '\nCANDIDATE OUTPUT\n'; cat /tmp/after.txt
# Install wrote a real service definition, but it was never started. Restore an inert stand-in before recovery.
printf '[Service]\nExecStart=/usr/bin/sleep infinity\n[Install]\nWantedBy=default.target\n' > /root/.config/systemd/user/com.agend.fleet.service
systemctl restart user@0.service
export XDG_RUNTIME_DIR=/run/user/0
unset DBUS_SESSION_BUS_ADDRESS
systemctl --user start dbus.socket
systemctl --user daemon-reload
systemctl --user enable --now --no-block com.agend.fleet.service
systemctl --user is-active com.agend.fleet.service
test -S /run/user/0/bus
test -S /run/user/0/systemd/private
! kill -0 "$old" 2>/dev/null
printf '\nPASS: active manager/missing sockets diagnosed; inert process survived diagnosis, was interrupted by manual restart; sockets and inert unit recovered. No real Fleet or agent started.\n'

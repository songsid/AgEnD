#!/bin/bash
# hub-member.sh <phase> [args] — inside a rig container (rig.sh start), as root. A dedicated Hub account and a member fleet, each
# its own systemd user service, installed from the rig's PRIVATE registry; a fake Active Directory (LDAPS :636, this container
# only, dummy passwords); a Telegram mock for the member's chat channel; mock agents only (no vendor, no real account).
#   setup <version>   both accounts install <version>, the Hub is initialized by the real initializer (sealed), the member fleet
#                     starts with hub_member enabled; nothing is paired yet
#   pair              alice (the Hub admin) issues an admin pairing; the member connects, both confirm, the admin approves
#   status            versions, Hub server state, the member's pairing (state/link or hold)
#   revoke            alice revokes the member's fleet on the Hub (the member then reads held/revoked; after a restart, rejected)
#   restart-member    restart the member fleet's service and wait;  restart-hub: the same for the Hub account
#   update <who> <version>   `agend update --version <version>` for rh (member) or hub, then restart
#   trust-hub-ca      add the rig Hub's CA to the container's OS store (company-join discovery uses OS roots); restart the member after
# Names: Hub web https://hub.example.test:18601, member endpoint :18602 (both 127.0.0.1 in /etc/hosts); member dashboard :19280,
# Hub account health :19380. Directory people: alice (Hub admin) and carol in CN=Owners, dave in CN=Other; password Dummy-<login>-only.
set -u
O=/opt/rh; PH=${1:?phase}
FAILS=0
check() { if eval "$2"; then echo "  ✓ $1"; else echo "  ✗ FAIL: $1"; FAILS=$((FAILS+1)); fi; }
note() { echo "  ℹ $1"; }
id -u hub >/dev/null 2>&1 || { useradd -m -s /bin/bash hub; loginctl enable-linger hub; }
mkenv() { local u=$1 h=/home/$1 id; id=$(id -u $1)
  echo "export HOME=$h USER=$u LOGNAME=$u XDG_RUNTIME_DIR=/run/user/$id DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$id/bus NPM_CONFIG_PREFIX=$h/.npm-global PATH=$h/.npm-global/bin:/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8; umask 022; unset TMUX TMUX_PANE"; }
as() { setpriv --reuid rh --regid rh --init-groups -- bash -c "$(mkenv rh); cd ~; $1"; }
ash() { setpriv --reuid hub --regid hub --init-groups -- bash -c "$(mkenv hub); cd ~; $1"; }
UNIT=com.agend.fleet; A=/home/rh/.agend; HA=/home/hub/.agend
PKG=/home/rh/.npm-global/lib/node_modules/@songsid/agend; HPKG=/home/hub/.npm-global/lib/node_modules/@songsid/agend
show() { $1 "systemctl --user show $UNIT -p ActiveState,SubState --value" 2>/dev/null | tr '\n' ' '; }
health() { curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:$1/health; }
hubstate() { curl -s -m 3 http://127.0.0.1:19380/health | python3 -c 'import json,sys
try: d=json.load(sys.stdin); print((d.get("hub") or {}).get("server","none"))
except Exception: print("down")'; }
ver() { $1 'agend --version 2>&1 | tail -1'; }
waitm() { for i in $(seq 1 60); do case "$(show as)" in active\ running*) break;; esac; sleep 2; done
  for i in $(seq 1 40); do [ "$(health 19280)" = 200 ] && break; sleep 3; done; echo "  member: unit=[$(show as)] health=$(health 19280) version=$(ver as)"; }
waithub() { for i in $(seq 1 60); do case "$(show ash)" in active\ running*) break;; esac; sleep 2; done
  for i in $(seq 1 60); do [ "$(hubstate)" = "${1:-ready}" ] && break; sleep 3; done; echo "  Hub account: unit=[$(show ash)] hub.server=$(hubstate) version=$(ver ash)"; }
mockin() { as "P=\$(npm root -g)/@songsid/agend; mkdir -p \$P/e2e/mock-servers && cp $O/mock-claude.mjs \$P/e2e/mock-servers/"; }
D() { as "node $O/drive.mjs $(printf '%q ' "$@")"; }
J() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s);console.log(eval(process.argv[1]))}catch{console.log('')}})" "$1"; }
pend() { echo "$1" | J 'v.body.pending_change && v.body.pending_change.state==="pending" ? v.body.pending_change.id : ""'; }
# A change the signed-in local admin proposes is usually confirmed at once; one still pending is confirmed on this computer.
confirm() { if [ -n "$1" ]; then as "agend settings confirm $1 --yes" 2>&1 | tail -1; else echo "applied by the signed-in admin"; fi; }
pairing() { D member GET /api/hub/member/pairing | J 'v.body.pairing ? v.body.pairing.state+"/"+(v.body.pairing.link||v.body.pairing.hold) : v.body.state'; }
waitpair() { local want=$1 i; for i in $(seq 1 ${2:-40}); do [ "$(pairing)" = "$want" ] && break; sleep 3; done; }

if [ $PH = setup ]; then
  V=${2:?version}
  echo "=== setup ($(date -u +%FT%TZ)): $V on two systemd accounts (Hub; member fleet); node=$(as 'node --version')"
  grep -q hub.example.test /etc/hosts || printf '127.0.0.1 hub.example.test\n127.0.0.1 ad.example.test\n' >> /etc/hosts
  for i in $(seq 1 30); do [ -S /run/user/$(id -u hub)/systemd/private ] && [ -S /run/user/$(id -u rh)/systemd/private ] && break; sleep 1; done
  (setsid node $O/tg-mock.mjs > /tmp/tg.log 2>&1 < /dev/null &)
  for u in as ash; do $u "printf 'prefix=%s/.npm-global\nregistry=http://registry:4873/\n' \$HOME > ~/.npmrc"; done
  echo "  npm install $V: member rc=$(as "npm install -g @songsid/agend@$V > /tmp/npm-m.log 2>&1; echo \$?") ($(ver as)); hub rc=$(ash "npm install -g @songsid/agend@$V > /tmp/npm-h.log 2>&1; echo \$?") ($(ver ash))"
  # Fake AD with its own CA; dummy passwords only.
  mkdir -p /opt/acc /opt/adtls && cd /opt/adtls && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.pem -days 7 -subj /CN=rig-ad-ca 2>/dev/null &&
    openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ad.key -out ad.csr -subj /CN=ad.example.test 2>/dev/null &&
    printf "subjectAltName=DNS:ad.example.test\nextendedKeyUsage=serverAuth\n" > ext.cnf &&
    openssl x509 -req -in ad.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out ad.pem -days 7 -extfile ext.cnf 2>/dev/null; cd /
  cp /opt/adtls/ca.pem /opt/acc/ad-ca.pem
  node -e 'const g="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",o="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",u=(l,id,gs)=>({id,login:l,dn:`CN=${l},DC=example,DC=test`,password:`Dummy-${l}-only`,groups:gs});
    console.log(JSON.stringify([u("alice","11111111-1111-4111-8111-111111111111",[g]),u("carol","33333333-3333-4333-8333-333333333333",[g]),u("dave","44444444-4444-4444-8444-444444444444",[o])]))' > /opt/acc/users.json
  rm -rf /opt/adlib && cp -a $PKG /opt/adlib && (setsid node $O/ad.mjs /opt/adtls/ad.pem /opt/adtls/ad.key /opt/acc/users.json > /tmp/ad.out 2>&1 < /dev/null &)
  for _ in $(seq 1 20); do grep -q "AD READY" /tmp/ad.out && break; sleep 0.5; done; note "fake AD: $(head -1 /tmp/ad.out)"
  ash 'mkdir -p ~/hubtls && cd ~/hubtls && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.pem -days 7 -subj /CN=rig-ca 2>/dev/null &&
    openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout server.key -out server.csr -subj /CN=hub.example.test 2>/dev/null &&
    printf "subjectAltName=DNS:hub.example.test\nextendedKeyUsage=serverAuth\n" > ext.cnf &&
    openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem -days 7 -extfile ext.cnf 2>/dev/null && chmod 600 *.key'
  cp /home/hub/hubtls/ca.pem /opt/acc/hub-ca.pem; chmod -R a+rX /opt/acc
  echo "--- the dedicated Hub account: the real initializer, then its own systemd service"
  ash "node $O/hubinit.mjs $HPKG $HA" 2>&1 | sed 's/^/  | /'
  ash "printf 'health_port: 19380\n' >> $HA/fleet.yaml; chmod 700 $HA"
  check "sealed: init-manifest + issuer key present, private" "ash 'test -s $HA/hub/init-manifest.json && test -s $HA/hub/keys/issuer-key.pem && [ \$(stat -c %a $HA/hub/keys/issuer-key.pem) = 600 ]'"
  ash "agend install > /tmp/svc-hub.out 2>&1; echo RC=\$? >> /tmp/svc-hub.out"; waithub
  check "the Hub is up from its own service: hub.server=$(hubstate)" "[ \"\$(hubstate)\" = ready ]"
  echo "--- the member fleet"
  as "mkdir -p $A ~/w-general ~/w-probe && for d in general probe; do git -C ~/w-\$d init -q; done; cat > $A/fleet.yaml <<Y
health_port: 19280
channel:
  type: telegram
  mode: topic
  bot_token_env: AGEND_BOT_TOKEN
  group_id: -1001234567890
  telegram_api_root: http://127.0.0.1:18443
  access: { mode: locked, allowed_users: [111222333] }
hub_member: { enabled: true }
instances:
  general: { working_directory: /home/rh/w-general, backend: mock, general_topic: true, topic_id: 1 }
  probe: { working_directory: /home/rh/w-probe, backend: mock, topic_id: 4242 }
Y
printf 'AGEND_BOT_TOKEN=123456:rehearsal\n' > $A/.env; chmod 700 $A"
  mockin; as "agend install > /tmp/svc.out 2>&1; echo RC=\$? >> /tmp/svc.out"; waitm; sleep 20
  check "the member runs $V: $(ver as)" "[ \"\$(ver as)\" = $V ]"
  note "member pairing: $(pairing)"
  echo "=== setup done: FAILS=$FAILS"
fi

if [ $PH = pair ]; then
  echo "=== pair ($(date -u +%FT%TZ)): alice's admin pairing → the member connects, both sides confirm, alice approves"
  for _ in $(seq 1 60); do pairing | grep -q unpaired && break; sleep 2; done
  CODE=$(D hub alice POST /hub/v1/admin/pairings '{"login":"alice"}' | J 'v.body.code')
  [ -n "$CODE" ] || note "admin pairing code refused: $(D hub alice POST /hub/v1/admin/pairings '{"login":"alice"}' | cut -c1-300)"
  for _ in $(seq 1 60); do CONN=$(D member POST /api/hub/member/pairing/connect "{\"address\":\"https://hub.example.test:18602\",\"code\":\"$CODE\"}"); echo "$CONN" | grep -q fleet_starting || break; sleep 2; done
  confirm "$(pend "$CONN")" | sed 's/^/  connect: /'
  FP=$(D member GET /api/hub/member/pairing | J 'v.body.pairing.fingerprint.digest')
  confirm "$(pend "$(D member POST /api/hub/member/pairing/confirm "{\"digest\":\"$FP\"}")")" | sed 's/^/  confirm: /'
  PID=$(D hub alice GET /hub/v1/pairings | J "v.body.pairings.find(p=>p.fingerprint==='$FP').id")
  D hub alice POST /hub/v1/pairings/$PID/confirm "{\"fingerprint\":\"$FP\"}" >/dev/null; D hub alice POST /hub/v1/admin/pairings/$PID/approve "{\"fingerprint\":\"$FP\"}" >/dev/null
  waitpair paired/online 30
  check "the member is paired and online: $(pairing)" "[ \"\$(pairing)\" = paired/online ]"
  echo "=== pair done: FAILS=$FAILS"
fi

[ $PH = status ] && echo "member $(ver as) [$(show as)] pairing=$(pairing) | Hub $(ver ash) [$(show ash)] hub.server=$(hubstate)"

if [ $PH = revoke ]; then
  FID=$(D hub alice GET /hub/v1/admin/overview | J 'v.body.fleets.filter(f=>f.status==="active").map(f=>f.id)[0]')
  note "revoke $FID: $(D hub alice POST /hub/v1/admin/fleets/$FID/revoke '{}' | cut -c1-120)"; sleep 5; note "member pairing: $(pairing)"
fi
if [ $PH = restart-member ]; then as "systemctl --user restart $UNIT"; waitm; sleep 15; note "member pairing: $(pairing)"; fi
if [ $PH = restart-hub ]; then ash "systemctl --user restart $UNIT"; waithub; fi
if [ $PH = update ]; then
  WHO=${2:?rh|hub}; TO=${3:?version}; U=as; [ $WHO = hub ] && U=ash
  $U "agend update --version $TO > /tmp/upd-$WHO.out 2>&1; echo RC=\$? >> /tmp/upd-$WHO.out"; tail -2 /tmp/upd-$WHO.out | sed 's/^/  | /'
  [ $WHO = rh ] && { mockin; as "systemctl --user restart $UNIT"; waitm; } || { ash "systemctl --user restart $UNIT"; waithub; }
fi
if [ $PH = trust-hub-ca ]; then
  cp /opt/acc/hub-ca.pem /usr/local/share/ca-certificates/rig-hub-ca.crt && update-ca-certificates >/dev/null 2>&1
  note "OS store has the rig Hub CA: $(node -e 'const t=require("tls"),x=require("crypto");console.log(t.getCACertificates?t.getCACertificates("system").some(p=>new x.X509Certificate(p).subject.includes("rig-ca")):"n/a (Node < 22.15)")')"
fi

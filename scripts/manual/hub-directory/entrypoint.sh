#!/bin/sh
# Builds a throwaway directory in /run/rig (a tmpfs): a test CA and server certificate, generated passwords, the
# seed entries, then runs slapd in the foreground on ldaps://:1636 and a plaintext ldap://:1389 the Hub must refuse. Nothing persists.
set -eu
R=/run/rig
umask 077
mkdir -p "$R/tls" "$R/data" "$R/secrets"

# Test CA + server certificate (SAN: directory.test and 127.0.0.1 only, so "localhost" is a name mismatch), plus an
# unrelated CA the tests use to prove a certificate from the wrong CA is refused.
cd "$R/tls"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 7 -subj "/CN=AgEnD Hub rig test CA" \
  -keyout ca.key -out ca.pem 2>/dev/null
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 7 -subj "/CN=Unrelated test CA" \
  -keyout other-ca.key -out other-ca.pem 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=directory.test" \
  -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:directory.test,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > ext.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 7 -extfile ext.cnf -out server.pem 2>/dev/null
rm -f ca.key other-ca.key server.csr ext.cnf ca.srl

gen() { openssl rand -hex 18; }
ADMIN=$(gen); READER=$(gen); SEED=$(gen)
printf '%s' "$ADMIN" > "$R/secrets/admin"; printf '%s' "$READER" > "$R/secrets/reader"; printf '%s' "$SEED" > "$R/secrets/seed"
hash() { slappasswd -s "$1"; }
guid() { openssl rand -base64 16; }
esc() { printf '%s' "$1" | sed 's/[\/&]/\\&/g'; }

sed -e "s/@ADMIN_HASH@/$(esc "$(hash "$ADMIN")")/" -e "s/@READER_HASH@/$(esc "$(hash "$READER")")/" \
  /rig/slapd.conf.in > "$R/slapd.conf"
sed -e "s/@READER_HASH@/$(esc "$(hash "$READER")")/" -e "s/@SEED_HASH@/$(esc "$(hash "$SEED")")/g" \
  -e "s/@ERIN_GUID@/$(esc "$(guid)")/" -e "s/@FRANK_GUID@/$(esc "$(guid)")/" /rig/seed.ldif.in > "$R/seed.ldif"

# Seed through a running slapd (not slapadd) so the memberof overlay fills memberOf. The local socket is for this
# seeding only; ready is written once every entry is in.
LDAPI="ldapi://%2Frun%2Frig%2Fldapi"
slapd -d 0 -f "$R/slapd.conf" -h "ldap://0.0.0.0:1389/ ldaps://0.0.0.0:1636/ $LDAPI" &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT
i=0; until ldapwhoami -x -H "$LDAPI" -D "cn=admin,dc=example,dc=test" -y "$R/secrets/admin" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 100 ] || { echo "slapd did not start" >&2; exit 1; }; sleep 0.1
done
ldapadd -x -c -H "$LDAPI" -D "cn=admin,dc=example,dc=test" -y "$R/secrets/admin" -f "$R/seed.ldif" >/dev/null
: > "$R/ready"
echo "fake directory ready"
wait "$pid"

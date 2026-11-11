#!/bin/bash
set -euo pipefail
mkdir -p /opt/adlib /opt/rh /opt/fixture
printf '{"type":"module"}\n' > /opt/adlib/package.json
ln -s /opt/node_modules /opt/adlib/node_modules
for tree in base candidate; do ln -s /opt/node_modules /opt/$tree/node_modules; done
cd /opt/fixture
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.pem -days 2 -subj /CN=wizard-test-ca 2>/dev/null
for name in hub directory; do
 openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$name.key" -out "$name.csr" -subj "/CN=$name.example.test" 2>/dev/null
 printf 'subjectAltName=DNS:%s.example.test\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' "$name" > "$name.ext"
 openssl x509 -req -in "$name.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -out "$name.pem" -days 2 -extfile "$name.ext" 2>/dev/null
 cat "$name.pem" ca.pem > "$name-chain.pem"
done
printf '[{"id":"11111111-1111-4111-8111-111111111111","login":"alice","dn":"CN=alice,DC=example,DC=test","password":"Dummy-person-unused","groups":[]}]\n' > users.json
node -e 'require("node:fs").writeFileSync("service-password", require("node:crypto").randomBytes(24).toString("hex"), {mode:0o600})'
chmod 600 *.key
chown -R wizard:wizard /opt/fixture
node /opt/rh/fake-directory.mjs /opt/fixture/directory-chain.pem /opt/fixture/directory.key /opt/fixture/users.json > /opt/fixture/ad.log 2>&1 &
echo $! > /opt/fixture/ad.pid

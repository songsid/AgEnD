# Hub fake directory (test rig)

A throwaway LDAP directory in a container for the AgEnD Hub directory sign-in tests (`src/hub/directory`, S-43 under
#3095). It is OpenLDAP with:

- **LDAPS** on 1636 with a test CA that is generated at start-up. The certificate names `directory.test` and
  `127.0.0.1` only, so `localhost` is a name mismatch on purpose. A second, unrelated CA is generated too, so the tests
  can show that a certificate from the wrong CA is refused.
- **Plain ldap:// on 1389**, left open on purpose. It would accept a plaintext bind. The Hub refuses to use it (LDAPS
  only), and the tests prove the refusal comes from the client, not the server.
- **Both identity styles:**
  - OpenLDAP people: `entryUUID`, `uid`, and the ppolicy administrative lock as "disabled".
  - AD-shaped people: from a small private test schema (`fake-ad.schema`), with a binary `objectGUID`,
    `sAMAccountName`, the `userAccountControl` disable bit and `accountExpires`.
- **Groups and departments:** `memberOf` (memberof overlay), `departmentNumber` / `department`.

Nothing persists. Certificates, passwords and data all live in the container's tmpfs, and every password is random
per start.

## Run rules

These follow fleet policy:
- The rig never uses `--privileged`, systemd, binfmt, or the host network, and makes no iptables, route or resolv
  changes.
- `run.sh` starts the container as the unprivileged `ldap` user with every capability dropped, `no-new-privileges`
  and a read-only root.
- Ports are published on 127.0.0.1 only.

Never point these tests at a real directory, and never point a real Hub at this rig.

## Use

```sh
scripts/manual/hub-directory/run.sh up            # prints the path of rig.env (URLs, CA paths, generated passwords)
AGEND_HUB_RIG_ENV="$(scripts/manual/hub-directory/run.sh env)" npx vitest run tests/hub-directory-rig.test.ts
scripts/manual/hub-directory/run.sh down
```

`OUT=<dir>` changes where `rig.env` and the CA files go. The default is
`~/.cache/agend-hub-directory-rig/<name>`. A second argument names the container, which allows several rigs side by
side.

Without `AGEND_HUB_RIG_ENV`, `tests/hub-directory-rig.test.ts` is skipped. The CI job `hub-directory` starts the rig
and runs it.

## Seed

All seed passwords are `AGEND_HUB_RIG_SEED_PASSWORD` from `rig.env`.

| Login | Style | State |
| --- | --- | --- |
| alice | OpenLDAP | enabled, group engineering |
| bob | OpenLDAP | disabled (administrative lock; the server also refuses his bind) |
| carol | OpenLDAP | for the rename scenario |
| dave | OpenLDAP | for the recreate scenario |
| erin | AD-shaped | enabled (`userAccountControl` 512) |
| frank | AD-shaped | disabled (`userAccountControl` 514) |

The service account the Hub searches with is `cn=hub-reader,ou=service,dc=example,dc=test`. It can read and not
write. People can only bind.

## Scenarios by hand

The tests create their own people. To try a scenario by hand, run these with the admin password from `rig.env`
(`A=...`):

```sh
R=scripts/manual/hub-directory/run.sh
# rename carol → carol2 (her entryUUID stays the same)
$R exec -- ldapmodrdn -x -H ldaps://127.0.0.1:1636 -D cn=admin,dc=example,dc=test -w "$A" -r uid=carol,ou=people,dc=example,dc=test uid=carol2
# recreate dave (same login, new entryUUID)
$R exec -- ldapdelete -x -H ldaps://127.0.0.1:1636 -D cn=admin,dc=example,dc=test -w "$A" uid=dave,ou=people,dc=example,dc=test
# disable alice (ppolicy administrative lock)
printf 'dn: uid=alice,ou=people,dc=example,dc=test\nchangetype: modify\nadd: pwdAccountLockedTime\npwdAccountLockedTime: 000001010000Z\n' |
  docker exec -i -e LDAPTLS_CACERT=/run/rig/tls/ca.pem agend-hub-directory-rig ldapmodify -x -H ldaps://127.0.0.1:1636 -D cn=admin,dc=example,dc=test -w "$A"
```

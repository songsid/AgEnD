# Fake directory for the AgEnD Hub sign-in tests (S-43). Test-only: OpenLDAP with LDAPS, a test CA made at
# start-up, and AD-shaped attributes from a small private schema. Runs unprivileged; see README.md for the run rules.
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache openldap openldap-back-mdb openldap-overlay-ppolicy openldap-overlay-memberof \
      openldap-overlay-refint openldap-clients openssl
COPY fake-ad.schema slapd.conf.in seed.ldif.in entrypoint.sh /rig/
USER ldap
EXPOSE 1389 1636
ENTRYPOINT ["/bin/sh", "/rig/entrypoint.sh"]

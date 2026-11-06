# Hub browser certificate setup

`agend hub init` accepts an existing certificate chain and matching unencrypted private key, or the explicit word `generate`. Generation creates a 30-day self-signed server certificate for the selected browser address: an IP SAN for IPv4/IPv6, or a DNS SAN for a hostname. The wizard displays its SHA-256 fingerprint and expiry before confirmation. Self-signed certificates still require the owner's explicit warning acceptance; generating one does not install trust or allow plaintext sign-in.

Only the person running the existing local-owner initializer can request generation or complete setup. The final confirmation binds the plan and exact certificate/key material through the existing initializer. Directory users, Hub askers and agents gain no setup authority.

The guarded OpenSSL invocation has fixed command options, a bounded duration/output, no shell and no network operation. Its key file is 0600 inside an owner-only 0700 staging directory under the selected AgEnD home. Key bytes never enter command arguments, terminal output or config. The initializer copies the selected material into its existing private browser-TLS location. The member transport certificate, issuer and pin remain separate.

Cancelled or completed setup removes generated staging; imported files remain the owner's files. An interrupted initialization retains the exact generated files for the existing same-plan resume. A saved generated marker and private hash record permit cleanup after resume. Changed files, directory replacement or uncertain initialization state retain material with a local notice instead of deleting it.

This slice covers initialization and import. Confirmed renewal for an already running Hub is a separate install-UX change. Existing browser certificate validation remains in force for all paths; there is no expiry, hostname or key-match bypass.

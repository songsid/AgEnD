---
section: Added
---
- Fleet Settings → Hub can now trust a valid self-signed test certificate with one “Trust this Hub and continue” press, keeping any join code and continuing company sign-in. The exact certificate is saved for that Hub address; a changed certificate stops the connection until explicitly trusted again. The Fleet pilot-trust switch defaults on in alpha builds and off in stable builds. Turning it off requires ordinary certificate trust. Expired certificates, incorrect host names and untrusted issuing chains retain their certificate error.

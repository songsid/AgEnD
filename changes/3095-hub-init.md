---
section: Added
---

- Experimental (Hub, off by default): `agend hub init`, and a first question in a fresh `agend quickstart` ("this machine is: my own fleet / a team Hub"), set up a team Hub. The wizard asks for:
  - the Hub's addresses;
  - a browser HTTPS certificate (there is no plain-HTTP sign-in);
  - your organisation's directory over LDAPS, with a test sign-in;
  - who the administrator is;
  - how long records are kept.

  It warns and asks for confirmation if this account already runs a fleet, and installs the service only when asked. It changes nothing until the final confirmation. In this build it stops before asking anything, because the Hub's key generation ships with the Hub transport. (#3095)

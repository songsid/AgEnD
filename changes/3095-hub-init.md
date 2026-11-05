---
section: Added
---

- Experimental (Hub, off by default): `agend hub init` sets up a team Hub. Once this build can set one up, a fresh `agend quickstart` also asks first: "this machine is: my own fleet / a team Hub". The wizard asks for:
  - the Hub's addresses;
  - a browser HTTPS certificate (there is no plain-HTTP sign-in);
  - your organisation's directory over LDAPS, with a test sign-in;
  - who the administrator is;
  - how long records are kept.

  It warns and asks for confirmation if this account already runs a fleet, and installs the service only when asked. It changes nothing until the final confirmation. Until the Hub's key generation ships with the Hub transport, `agend hub init` stops before asking anything, and quickstart doesn't ask the question. (#3095)

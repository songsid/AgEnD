---
section: Added
---

- Experimental (Hub, off by default): the groundwork for directory sign-in. It checks people against an LDAP / Active Directory server over verified LDAPS only and knows them by the directory's permanent ID, so a renamed account stays the same person and a recreated one does not. It checks again on every request and refuses when the directory can't be reached. Nothing uses it until the Hub is switched on. (#3095)

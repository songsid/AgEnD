---
section: Security
---
- **Web: the public link can no longer change the fleet-wide sidebar order (#1665).** `POST /api/sort-order` was still allowed over a temporary public link, although the page no longer used it. It is now off the public link's route list, and the handler refuses it there as well (403). Reading the order is unchanged.

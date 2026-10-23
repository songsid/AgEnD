---
section: Changed
---
- **Web: every Settings field shows the value in effect (#2347).** A setting nobody set in `fleet.yaml` shows the value AgEnD uses, marked "default", instead of a grey "48 (default)" placeholder (an empty field reads "In effect: 48 h"); Advanced's read-only list shows each default too. In an agent's or a ClassicBot room's dialog, an inherited field says what it inherits and links to where it is set ("Inherited: 30 min · change in Agent defaults"; a room takes ClassicBot defaults first). A link or search result to a setting inside Advanced now opens it.

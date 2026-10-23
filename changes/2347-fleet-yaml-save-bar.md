---
section: Changed
---
- **The fleet.yaml editor saves with Settings' Save bar (#2347).** In Settings → Advanced, Apply in the editor no longer writes at once. It adds the edit to the Save bar as unsaved changes, and Save writes them with any other unsaved change. Discard drops them. If a Save doesn't land all of the edit, the rest comes back to the bar and the editor shows the edit again. The editor and the forms that write the same settings (agents, agent defaults, connections) don't mix. While an edit waits, those forms and the setup wizard are off, with a link to the editor. While those forms have unsaved changes, the editor is for reading until they are saved or discarded.

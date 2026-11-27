# M-3883: Hub › Roles and permissions, today and redesigned (real app)

Both sets were captured in the real Hub (production runtime, HTTPS, SQLite; the repo's `scripts/manual/hub-roles-m3223`
fixture with more made-up people and three made-up AD groups), headless Chromium, at dev tip `0aff702d8`.
Nothing here is a drawing.

- `now/`: today's page.
- `new/`: the prototype. The browser is served the files in `prototype/` in place of the page's own script and
  stylesheet (`hub-roles.js`, `hub-role-forms.js`, `hub-role-view.js`, `hub-roles.css`); the server is untouched.
- Desktop is 1440 × 1200, the phone 390 × 844. zh-TW: desktop light, phone dark. English: desktop light, phone light.
- `receipt.json` lists every frame with its sha256 and the commit.

| Frame (`new/`) | What it shows |
|---|---|
| `1-matrix` | Roles as columns, permissions as rows; on a phone, the list of roles |
| `2-role-members` | A role's Members table |
| `2b-members-selected` | One row ticked: the tinted row, the header's dash, the bulk bar |
| `3-role-permissions` | A role's permissions as three short lists |
| `4-add-empty` | The add drawer as it opens |
| `4b-add-picked` | Two people and one AD group ticked across two searches; the foot says what is missing |
| `4c-add-scope` | An AD group chosen as the scope; Review is ready |
| `4d-add-review` | The server's own check of that change |
| `5-people` | People as a table |

| Frame (`now/`) | What it shows |
|---|---|
| `1-list` | The roles list |
| `2-role-people`, `3-role-permissions` | A role's page |
| `4c-assign-picked` | The assign drawer with one person picked |
| `5-people` | The People view |

All names, sign-in names and groups are made up.

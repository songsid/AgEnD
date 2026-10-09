---
section: Security
---
- **Settings secret endpoints: 403 for public-link (gateway) sessions.** Six endpoints that write or verify connection tokens/secrets (`/secrets/:id/verify`, `/secrets/:id/apply`, `/connections/:id/secret/verify`, `/connections/:id/secret/apply`, `/connections/:id/binding/verify`, `/connections/:id/binding/apply`), plus the quickstart probe endpoint that receives raw bot tokens for verification, now return 403 for gateway (`surface: "gateway"`) sessions. Local dashboard sessions are unaffected. (#1519)
- **Docs: `create_instance` and `update_instance_config` privilege boundaries described separately.** `tool_set` and `skipPermissions` can only be set through Settings or `fleet.yaml`. `update_instance_config` explicitly refuses `tool_set`; `skipPermissions` is not an accepted field (Zod strips it). `create_instance` refuses both fields explicitly. (#1519)

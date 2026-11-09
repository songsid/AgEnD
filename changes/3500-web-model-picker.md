---
section: Added
---
- Web model pickers have an explicit Refresh models action that runs bounded discovery for the selected account/backend, keeps the selected value and retains usable choices on failure. Chat adds backend/model entries on desktop and inside the phone composer, marks the current model, and separates Refresh and Claude’s More models from model choices. Backend switching retains the reasoning-effort step and final fresh-conversation confirmation; the phone’s latest-message button clears message content (#3500). Native Windows refresh uses the selected Runtime computer and account; unsupported peers retain their prior choices instead of using the coordinator’s catalog.
- Preserve model-catalog loading and source notes on alpha. Late reads cannot undo an explicit refresh, and native Windows discovery respects case-insensitive account-home variables without falling back to ambient credentials.

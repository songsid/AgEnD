---
type: entity
title: "Fleet Commands"
tags: [feature, command, telegram, discord]
sources: [changelog-v2.0.3, dev-workflow]
created: 2026-06-20
updated: 2026-06-20
---

# Fleet Commands

## Overview

Slash commands across TG and DC. 🔒 = admin only.

## TG Fleet (forum group scope)

| Command | Permission |
|---------|------------|
| `/status` | All |
| `/sysinfo` | All |
| `/ctx` | All |
| `/compact` | All |
| 🔒 `/restart` | Admin |
| 🔒 `/update` | Admin |
| 🔒 `/doctor` | Admin |
| 🔒 `/collab` | Admin |
| 🔒 `/dashboard` | Admin |

## TG Classic (default scope)

| Command | Permission |
|---------|------------|
| 🔒 `/start` | Admin |
| 🔒 `/stop` | Admin |
| 🔒 `/compact` | Admin |

## Discord (global)

| Command | Permission |
|---------|------------|
| `/start` | All |
| `/stop` | All |
| `/chat <message>` | All |
| `/status` | All |
| `/sysinfo` | All |
| `/ctx` | All |
| 🔒 `/restart` | Admin |
| 🔒 `/update` | Admin |
| 🔒 `/doctor` | Admin |
| 🔒 `/compact` | Admin |
| 🔒 `/collab` | Admin |
| 🔒 `/save <filename>` | Admin |
| 🔒 `/load <filename>` | Admin |

## Permission model

- **Fleet admin**: `fleet.yaml` → `channel.access.allowed_users`
- **ClassicBot admin**: `classicBot.yaml` → `defaults.admin_users`
- **All**: no check (within fleet/classic access)

## Sources

- [[changelog-v2.0.3]]
- [[changelog-v2.0.5]]

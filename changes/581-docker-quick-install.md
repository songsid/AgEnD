---
section: Added
---
- **A runbook for running AgEnD in Docker (#581).** [AgEnD in Docker](docs/docker.md) is written for an agent: give it to General, or any agent, and it sets up AgEnD in a container for you and maintains it. It covers the questions to ask, the Dockerfile and compose file (non-root, named volumes, the dashboard on `127.0.0.1:19280`), installing and pinning the AI CLIs, the first fleet.yaml, verification, updates by rebuilding the image, CLI upgrades, backups, logs and troubleshooting. General agents get a `docker-install` skill that points to it. AgEnD itself has nothing Docker-specific.

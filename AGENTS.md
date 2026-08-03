# Deployment entry rules

When Codex works from this repository:

1. Read `CODEX_DEPLOYMENT.md` before handling a deployment ticket.
2. Start with `scripts/deploy.py inspect`; do not download or write during inspection.
3. Wait for the user's explicit approval before `apply --confirm-write YES`.
4. Never print, commit, log, or quote a complete ticket URL or package URL with query parameters.
5. Never add customer packages, tickets, credentials, customer files, local absolute paths, or private configuration to this repository.
6. Treat every `releases/<version>/` manifest and published version tag as immutable. A changed package requires a new version and tag.
7. Do not automatically roll back. Show the exact backup record and wait for separate explicit approval.


# Security

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting instead (*Security → Report a vulnerability* on this repository). You will get a reply within a few days.

## Scope notes

- The dashboard API (`src/server/api_server.ts`) is a **local, single-tenant development adapter**. It has no authentication and binds to loopback only by design, so exposing it on a network is out of scope.
- The MCP server treats its client as untrusted. Paths are sandboxed (outputs under `output/`, no hidden files, no symlink escapes) and CLIs run through `execFile` with no shell.
- Secrets live only in `.env`, which is git-ignored. Paid providers are disabled unless you explicitly turn them on.

# Dashboard

A local, read-only visual view of the pipeline state. It renders the same
artifacts that `/fd-status` reads — no new data, no schema changes.

## Start

```bash
bun run dashboard -- --slug <slug> [--topic <topic>] [--port <port>]
```

Defaults to port 4321 and binds to `127.0.0.1` only. The browser page polls
the API every ~5 seconds; there are no websockets and no build step.

## What it shows

- **Pipeline stage** — the `/fd-task` → `/fd-done` phases from
  `~/.fd-plan/<slug>/checkpoint.json` (falling back to `STATE.md`)
- **Plan steps** — the `- [ ]` / `- [x]` steps of the topic's `plan.md`
- **Blockers** and live worktrees
- **Token budget** — estimate derived from the topic's planning artifacts
- **Recent runs** — from `~/.fd-plan/<slug>/.codebase/RUNS.jsonl`
- **Audit log** — tail of `~/.fd-plan/<slug>/.codebase/AUDIT.jsonl`

When a topic or the audit log does not exist yet, the page shows an empty
state with a "run /fd-task eerst" hint.

## Read-only

The dashboard only reads `~/.fd-plan/<slug>/`. It exposes two GET endpoints
plus the static page, rejects all other methods, and never writes to the
planning directory.

## No secrets in the UI

Paths are shortened to `~` form, long strings are truncated, and
`prompt`/`args`/env fields are never passed to the browser.

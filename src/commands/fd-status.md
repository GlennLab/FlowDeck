---
description: Show the current pipeline stage, artifact status, and blockers for the active topic
argument-hint: [--topic=<slug> | --all] [--format=<text|json>]
---

# Status

Show where the current task sits in the pipeline and what is blocking it. A live visual view of the same state is available from the read-only local dashboard: `bun run dashboard -- --slug <slug> --topic <topic>` (see `docs/reference/dashboard.md`).

**Input:** $ARGUMENTS — optional `--topic=<slug>` for a specific topic, `--all` to list
every topic in the project.

## Options

- `--format=<text|json>` — output format (default `text`). With `--all`, json
  outputs an array of topic objects.

## Default: active topic

Read `~/.fd-plan/<slug>/checkpoint.json` first, falling back to
`~/.fd-plan/<slug>/STATE.md`. Resolve `<topic>` from `--topic`, else from `topic` in
STATE.md.

```
════════════════════════════════════════════════════════════
Project: <slug>   Topic: <topic>
Updated: <timestamp>   Source: checkpoint.json | STATE.md
────────────────────────────────────────────────────────────
Pipeline
  ✅ fd-task     — artifacts confirmed
  ✅ fd-review   — 0 blocking findings
  🔄 fd-execute  — wave-2  ← current
  ⬜ fd-verify
  ⬜ fd-done
────────────────────────────────────────────────────────────
Artifacts   task.md ✅  architecture.md ✅  affect.md ✅  plan.md ✅
Plan        <X> steps (<Y> complete)
Risk        <low|medium|high>   (from affect.md)
Worktrees   <names, or "none">
Blockers    <list, or "none">
Sync        <clean|dirty|conflict>   remote: <remote>
            last push: <time, or "never">   last pull: <time, or "never">
════════════════════════════════════════════════════════════
Next: <next command in the pipeline>
```

When `~/.fd-plan/<slug>/sync.json` is absent, show `Sync        none` instead.

Stage markers:
- `✅` — recorded complete in `checkpoint.json` `phases`, or implied by STATE.md status
- `🔄` — the stage named by `current_command`
- `⬜` — not yet reached
- `⏭️` — skipped, with the logged reason shown inline (trivial tasks only)

## All topics (`--all`)

List every topic directory under `~/.fd-plan/<slug>/`:

```
════════════════════════════════════════════════════
TOPICS — <slug>
════════════════════════════════════════════════════
  ✅ add-oauth-login    — done       | updated <time>
  🔄 refactor-router    — execute    | updated <time>  ← active
  ⬜ cache-invalidation — task       | updated <time>
────────────────────────────────────────────────────
Total: 3 topics | 1 done | 1 in progress | 1 planned
════════════════════════════════════════════════════
```

Read each topic's stage from its artifacts on disk: `plan.md` present but no commits →
`task`; `steps_complete` non-empty → `execute`; STATE.md `status: complete` → `done`.

## Blockers

When blockers exist, show them with the command that clears each one:

```
Blockers:
  ❌ affect.md missing            → run /fd-task
  ❌ verification failed: 2 tests → run /fd-execute, then /fd-verify
```

## Sync

Read `~/.fd-plan/<slug>/sync.json` — purely local, **no network calls**. Show the
`state` (`clean` | `dirty` | `conflict`), the `remote`, and the last-push and
last-pull timestamps. A corrupt `sync.json` is treated as absent (show `Sync
none`); a missing file means sync has never run.

## JSON output

With `--format json`, print a single JSON object on stdout and nothing else.
Errors go to stderr and exit with code 1.

```json
{
  "project": "<slug>",
  "topic": "<topic>",
  "stage": "<current_command>",
  "stage_status": "<current_stage>",
  "artifacts": { "task": true, "affect": true, "plan": true, "architecture": true },
  "blockers": [],
  "saved_at": "<ISO timestamp>",
  "sync": {
    "state": "clean",
    "remote": "<remote>",
    "last_push": "<ISO timestamp or null>",
    "last_pull": "<ISO timestamp or null>"
  }
}
```

- `stage` = `checkpoint.json` `current_command`; `stage_status` = `current_stage`;
  `saved_at` = `checkpoint.json` `saved_at` (fallback: STATE.md).
- `sync` = `sync.json` (`state`, `remote`, `last_push.at`, `last_pull.at`);
  `null` when `sync.json` is absent or corrupt.
- `artifacts` booleans from file existence under `~/.fd-plan/<slug>/<topic>/`
  (architecture.md at slug level).
- No `phases` field: `checkpoint.json` `phases` is a wave-number→status map, not
  a pipeline-stage map — `stage` + `stage_status` + `artifacts` describe the state
  without derivation ambiguity.
- With `--all`: `{"project": "<slug>", "topics": [ <one object per topic> ]}`.

## Error Handling

- `~/.fd-plan/<slug>/` not found → `"No planning workspace. Run /fd-task first."`
- `--topic` names a topic that does not exist → `"Topic '<topic>' not found."` followed
  by the available topics.
- `checkpoint.json` unreadable → fall back to STATE.md and note the fallback in the
  output rather than failing.

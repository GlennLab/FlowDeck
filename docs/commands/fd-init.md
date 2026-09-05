---
description: Initialize the FlowDeck planning directory for this project (no task started)
argument-hint: [project-slug]
---

# Init

Initialize the FlowDeck planning directory for this project without starting a
task. `/fd-task` remains the pipeline entrypoint.

**Input:** $ARGUMENTS — optional project slug. Default: basename of the current
working directory.

## Step 1: Resolve slug

Resolve `<slug>` from `$ARGUMENTS`, else the basename of the current working
directory.

If `~/.fd-plan/<slug>/` already exists, print
`Already initialized at ~/.fd-plan/<slug>/` and stop. Do not overwrite anything.

## Step 2: Create the workspace

1. Create `~/.fd-plan/<slug>/`.
2. **MUST create `STATE.md` immediately after creating the planning directory.** Write
   `createDefaultState()` to `~/.fd-plan/<slug>/STATE.md`, then call
   `planning-state action:update` with:
   - `updates.status: "in_progress"`
   - `updates.last_action: "fd-init complete"`
   - `updates.next_action: "run /fd-task"`

   Do NOT set a topic — none exists until `/fd-task` runs. Then create
   `~/.fd-plan/<slug>/config.json` with `createDefaultConfig()`.
3. Map the codebase with the graph:
   - Run `fdx-graph action:status` — it reports build age without paying for a build.
   - Absent or stale → run `fdx-graph action:build`. A no-op build is cheap and
     leaves the cache untouched.
   - Run `fdx-graph action:report` and read the generated `GRAPH_REPORT.md` for god
     nodes and cluster orientation.
   - For anything the graph does not cover (tech stack, dependency versions), read
     `package.json` / `go.mod` / `Cargo.toml` / `pyproject.toml` plus the `src/` tree.
4. Write `~/.fd-plan/<slug>/architecture.md` with the regular file `write` tool —
   NOT `codebase-state`, which writes under `~/.fd-plan/<slug>/.codebase/`.
   Cover: tech stack, module layout, entry points, key conventions.

## Step 3: Report

Print: `"Initialized ~/.fd-plan/<slug>/ — architecture mapped. Next: /fd-task"`

## Examples

```
/fd-init
```

Initialize `~/.fd-plan/<current-dir-name>/` using the basename of the current
working directory.

```
/fd-init my-project
```

Initialize `~/.fd-plan/my-project/` for a specific slug.

## Error Handling

- Graph build fails → warn and continue with a minimal `architecture.md`.
- Permission denied on `~/.fd-plan/` → error message and stop. No partial state.

## Related Commands

- `/fd-task` — start a new topic (pipeline entrypoint)
- `/fd-status` — show the pipeline position once a topic exists

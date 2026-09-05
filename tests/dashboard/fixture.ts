/**
 * Shared fixture helpers for dashboard tests: unique slugs under a temp
 * planning root (never the real ~/.fd-plan) with complete planning
 * artifacts, cleaned up per test.
 *
 * The root is a temp dir because Bun's `os.homedir()` caches $HOME at
 * process start — runtime env overrides do not reach `fdPlanRoot()`, so the
 * data/server APIs take an explicit root parameter instead.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"

export const SECRET_PROMPT = "SECRET_PROMPT_CONTENT_DO_NOT_LEAK"
export const SECRET_TOKEN = "sk-SECRET1234567890"

export interface Fixture {
  slug: string
  root: string
  topic: string
  topicDir: string
}

let planningRoot: string | null = null

/** Temp planning root shared by all fixtures in this process. */
export function planningRootForTests(): string {
  if (planningRoot === null) {
    planningRoot = mkdtempSync(join(tmpdir(), "fd-dash-plan-"))
  }
  return planningRoot
}

/** Remove the temp planning root (call from afterAll). */
export function cleanupPlanningRoot(): void {
  if (planningRoot !== null) {
    rmSync(planningRoot, { recursive: true, force: true })
    planningRoot = null
  }
}

export function createFixture(): Fixture {
  const slug = "fd-dash-test-" + process.pid + "-" + Math.random().toString(36).slice(2, 8)
  const root = join(planningRootForTests(), slug)
  const topic = "demo-topic"
  return { slug, root, topic, topicDir: join(root, topic) }
}

/** Reset to an empty topic dir (slug dir + topic dir exist, nothing else). */
export function resetFixture(f: Fixture): void {
  rmSync(f.root, { recursive: true, force: true })
  mkdirSync(f.topicDir, { recursive: true })
}

export function cleanupFixture(f: Fixture): void {
  rmSync(f.root, { recursive: true, force: true })
}

export function writeFixtureFile(f: Fixture, rel: string, content: string): void {
  const p = join(f.root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, "utf-8")
}

/** Complete topic: STATE.md, checkpoint.json, plan/task/affect/architecture, audit + runs. */
export function writeCompleteFixture(f: Fixture): void {
  writeFixtureFile(
    f,
    "STATE.md",
    `---
phase: 2
topic: "${f.topic}"
status: in_progress
plan_confirmed: true
steps_complete: [1, 2]
last_action: "wave-1 done"
next_action: "run /fd-execute wave-2"
blockers: ["awaiting review"]
lastUpdatedAt: "2026-09-05T06:00:00.000Z"
---

# Planning State
 `,
  )
  writeFixtureFile(
    f,
    "checkpoint.json",
    JSON.stringify({
      version: "1",
      project: f.slug,
      topic: f.topic,
      saved_at: "2026-09-05T06:30:00.000Z",
      current_command: "fd-execute",
      current_stage: "wave-2",
      phases: {
        "fd-task": { status: "complete" },
        "fd-review": { status: "complete" },
        "fd-execute": { status: "in_progress", wave: "2" },
        "fd-verify": "pending",
        "fd-done": "pending",
      },
      worktrees: ["fd-demo-wave-2"],
      blockers: [],
    }),
  )
  writeFixtureFile(
    f,
    `${f.topic}/plan.md`,
    `# Plan: demo

## Wave 1 — data
- [x] \`src/x.ts\`: implement reader
- [ ] \`src/y.ts\`: implement writer

## Wave 2 — server
- [ ] \`src/z.ts\`: server
 `,
  )
  writeFixtureFile(
    f,
    `${f.topic}/task.md`,
    `# Task: demo topic

## Requirements
- R-01: something
 `,
  )
  writeFixtureFile(
    f,
    `${f.topic}/affect.md`,
    `# Affect: demo

## Risk Level
medium
 `,
  )
  writeFixtureFile(f, `${f.topic}/architecture.md`, `# Architecture: demo\n`)
  writeFixtureFile(
    f,
    ".codebase/AUDIT.jsonl",
    [
      JSON.stringify({
        kind: "guard.allow",
        session_id: "ses_x",
        tool: "bash",
        decision: "allow",
        details: { prompt: SECRET_PROMPT, token: SECRET_TOKEN },
        timestamp: "2026-09-05T06:00:00.000Z",
      }),
      "this line is not json",
      JSON.stringify({
        kind: "guard.block",
        agent: "backend-coder",
        tool: "write",
        decision: "block",
        reason: "path outside workspace",
        timestamp: "2026-09-05T06:01:00.000Z",
      }),
      JSON.stringify({ kind: "lifecycle.transition", timestamp: "2026-09-05T06:02:00.000Z" }),
    ].join("\n") + "\n",
  )
  writeFixtureFile(
    f,
    ".codebase/RUNS.jsonl",
    JSON.stringify({
      run_id: "run-1",
      session_id: "ses_x",
      command: "fd-execute",
      args: { prompt: SECRET_PROMPT, token: SECRET_TOKEN },
      started_at: "2026-09-05T06:00:00.000Z",
      ended_at: "2026-09-05T06:30:00.000Z",
      status: "complete",
      files_touched: [join(f.root, f.topic, "plan.md")],
      event_ids: ["e1"],
      risk_score: 2,
      outcome: "done",
    }) + "\n",
  )
}

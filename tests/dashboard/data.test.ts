import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest"
import { homedir } from "os"
import {
  isValidName,
  readAuditTail,
  readTopicStatus,
  slugDir,
} from "../../src/dashboard/data"
import {
  SECRET_PROMPT,
  SECRET_TOKEN,
  cleanupFixture,
  cleanupPlanningRoot,
  createFixture,
  planningRootForTests,
  resetFixture,
  writeCompleteFixture,
  writeFixtureFile,
  type Fixture,
} from "./fixture"

let f: Fixture

beforeAll(() => {
  planningRootForTests()
})

afterAll(() => {
  cleanupPlanningRoot()
})

beforeEach(() => {
  f = createFixture()
  resetFixture(f)
})

afterEach(() => {
  cleanupFixture(f)
})

describe("data validation", () => {
  it("should reject empty names and names with path separators or traversal", () => {
    expect(isValidName("")).toBe(false)
    expect(isValidName("x/y")).toBe(false)
    expect(isValidName("x\\y")).toBe(false)
    expect(isValidName("..")).toBe(false)
    expect(isValidName("a..b")).toBe(false)
    expect(isValidName("a/../../etc")).toBe(false)
  })

  it("should accept plain slugs and topic names", () => {
    expect(isValidName("FlowDeck")).toBe(true)
    expect(isValidName("le4-dashboard")).toBe(true)
    expect(isValidName("flowdeck-00wA19")).toBe(true)
  })

  it("should return null for invalid slug or topic instead of throwing", () => {
    const root = planningRootForTests()
    writeCompleteFixture(f)
    expect(readTopicStatus("a/b", f.topic, root)).toBeNull()
    expect(readTopicStatus("../x", f.topic, root)).toBeNull()
    expect(readTopicStatus("", f.topic, root)).toBeNull()
    expect(readTopicStatus(f.slug, "", root)).toBeNull()
    expect(readTopicStatus(f.slug, "..", root)).toBeNull()
    expect(readTopicStatus(f.slug, "a/b", root)).toBeNull()
  })

  it("should build slug dirs only under the planning root", () => {
    const root = planningRootForTests()
    expect(slugDir(f.slug, root)).toBe(f.root)
    expect(slugDir("../x", root)).toBeNull()
    expect(slugDir("a/b", root)).toBeNull()
  })

  it("should return null when the topic directory does not exist", () => {
    expect(readTopicStatus(f.slug, "no-such-topic", planningRootForTests())).toBeNull()
  })

  it("should keep fixtures out of the real planning root", () => {
    expect(planningRootForTests().startsWith(homedir() + "/")).toBe(false)
    expect(f.root.startsWith(homedir() + "/")).toBe(false)
  })
})

describe("readTopicStatus (complete topic)", () => {
  beforeEach(() => {
    writeCompleteFixture(f)
  })

  it("should parse stage, phases, and steps from checkpoint and plan", () => {
    const s = readTopicStatus(f.slug, f.topic, planningRootForTests())
    expect(s).not.toBeNull()
    expect(s!.stage).toBe("fd-execute")
    expect(s!.stageStatus).toBe("wave-2")
    expect(s!.status).toBe("in_progress")
    expect(s!.savedAt).toBe("2026-09-05T06:30:00.000Z")
    expect(s!.phases).toEqual([
      { name: "fd-task", status: "complete" },
      { name: "fd-review", status: "complete" },
      { name: "fd-execute", status: "in_progress" },
      { name: "fd-verify", status: "pending" },
      { name: "fd-done", status: "pending" },
    ])
    expect(s!.stepsTotal).toBe(3)
    expect(s!.stepsComplete).toBe(1)
    expect(s!.steps[0]).toEqual({ text: "`src/x.ts`: implement reader", done: true })
    expect(s!.steps[2].done).toBe(false)
  })

  it("should parse task title, risk, blockers, worktrees, and artifacts", () => {
    const s = readTopicStatus(f.slug, f.topic, planningRootForTests())
    expect(s!.taskTitle).toBe("Task: demo topic")
    expect(s!.risk).toBe("medium")
    expect(s!.blockers).toEqual([])
    expect(s!.worktrees).toEqual(["fd-demo-wave-2"])
    expect(s!.artifacts).toEqual({
      task: true,
      plan: true,
      affect: true,
      architecture: true,
    })
    expect(s!.lastAction).toBe("wave-1 done")
    expect(s!.nextAction).toBe("run /fd-execute wave-2")
  })

  it("should build a budget from planning artifact bytes", () => {
    const s = readTopicStatus(f.slug, f.topic, planningRootForTests())
    expect(s!.budget).not.toBeNull()
    expect(s!.budget!.total).toBeGreaterThan(0)
    expect(s!.budget!.context).toBeGreaterThan(0)
    expect(s!.budget!.remaining).toBe(s!.budget!.total)
  })

  it("should list traces without args, files, or session ids", () => {
    const s = readTopicStatus(f.slug, f.topic, planningRootForTests())
    expect(s!.traces).not.toBeNull()
    expect(s!.traces).toHaveLength(1)
    const t = s!.traces![0]
    expect(t.runId).toBe("run-1")
    expect(t.command).toBe("fd-execute")
    expect(t.status).toBe("complete")
    expect(t.filesTouched).toBe(1)
    expect(t.riskScore).toBe(2)
    expect(t.outcome).toBe("done")
    const dumped = JSON.stringify(t)
    expect(dumped).not.toContain("args")
    expect(dumped).not.toContain("files_touched")
    expect(dumped).not.toContain("session_id")
  })
})

describe("readTopicStatus (tolerance)", () => {
  it("should return null fields for an empty topic without throwing", () => {
    const s = readTopicStatus(f.slug, f.topic, planningRootForTests())
    expect(s).not.toBeNull()
    expect(s!.stage).toBeNull()
    expect(s!.stageStatus).toBeNull()
    expect(s!.status).toBeNull()
    expect(s!.savedAt).toBeNull()
    expect(s!.phases).toEqual([])
    expect(s!.steps).toEqual([])
    expect(s!.stepsTotal).toBe(0)
    expect(s!.risk).toBeNull()
    expect(s!.taskTitle).toBeNull()
    expect(s!.blockers).toEqual([])
    expect(s!.worktrees).toEqual([])
    expect(s!.artifacts).toEqual({
      task: false,
      plan: false,
      affect: false,
      architecture: false,
    })
    expect(s!.budget).not.toBeNull()
    expect(s!.traces).toBeNull()
  })

  it("should fall back to STATE.md when checkpoint.json is corrupt", () => {
    writeFixtureFile(
      f,
      "STATE.md",
      `---
topic: "${f.topic}"
status: blocked
blockers: ["verification failed"]
lastUpdatedAt: "2026-09-04T01:00:00.000Z"
---
`,
    )
    writeFixtureFile(f, "checkpoint.json", "{ this is not json")
    const s = readTopicStatus(f.slug, f.topic, planningRootForTests())
    expect(s).not.toBeNull()
    expect(s!.stage).toBeNull()
    expect(s!.status).toBe("blocked")
    expect(s!.blockers).toEqual(["verification failed"])
    expect(s!.savedAt).toBe("2026-09-04T01:00:00.000Z")
    expect(s!.phases).toEqual([])
  })

  it("should not throw on a STATE.md without frontmatter or a plan without steps", () => {
    writeFixtureFile(f, "STATE.md", "just some notes, no frontmatter\n")
    writeFixtureFile(f, `${f.topic}/plan.md`, "# Plan\n\nno steps here\n")
    const s = readTopicStatus(f.slug, f.topic, planningRootForTests())
    expect(s).not.toBeNull()
    expect(s!.status).toBeNull()
    expect(s!.steps).toEqual([])
  })

  it("should handle a truncated checkpoint.json object tolerantly", () => {
    writeFixtureFile(f, "checkpoint.json", '{"current_command": "fd-verify", "phases": 42}')
    const s = readTopicStatus(f.slug, f.topic, planningRootForTests())
    expect(s).not.toBeNull()
    expect(s!.stage).toBe("fd-verify")
    expect(s!.phases).toEqual([])
  })
})

describe("readAuditTail", () => {
  it("should return the last n events and skip corrupt lines", () => {
    writeCompleteFixture(f)
    const tail = readAuditTail(slugDir(f.slug, planningRootForTests())!, 50)
    expect(tail.events).toHaveLength(3)
    expect(tail.skipped).toBe(1)
    expect(tail.events[0].kind).toBe("guard.allow")
    expect(tail.events[0].tool).toBe("bash")
    expect(tail.events[0].decision).toBe("allow")
    expect(tail.events[1].agent).toBe("backend-coder")
    expect(tail.events[1].reason).toBe("path outside workspace")
    expect(tail.events[2].timestamp).toBe("2026-09-05T06:02:00.000Z")
  })

  it("should limit the tail to n events", () => {
    writeCompleteFixture(f)
    const tail = readAuditTail(slugDir(f.slug, planningRootForTests())!, 2)
    expect(tail.events).toHaveLength(2)
    expect(tail.events[0].kind).toBe("guard.block")
  })

  it("should return an empty tail when the audit log is missing", () => {
    const tail = readAuditTail(slugDir(f.slug, planningRootForTests())!, 10)
    expect(tail).toEqual({ events: [], skipped: 0 })
  })

  it("should count every corrupt line when no line parses", () => {
    writeFixtureFile(f, ".codebase/AUDIT.jsonl", "garbage\nmore garbage\n")
    const tail = readAuditTail(slugDir(f.slug, planningRootForTests())!, 10)
    expect(tail.events).toEqual([])
    expect(tail.skipped).toBe(2)
  })

  it("should read only the 1 MiB tail window and count the cap as skipped", () => {
    const total = 20000
    const line = (i: number) =>
      JSON.stringify({
        kind: "lifecycle.transition",
        reason: `event-${i}`,
        timestamp: "2026-09-05T06:00:00.000Z",
      })
    const content = Array.from({ length: total }, (_, i) => line(i)).join("\n") + "\n"
    expect(Buffer.byteLength(content)).toBeGreaterThan(1024 * 1024)
    writeFixtureFile(f, ".codebase/AUDIT.jsonl", content)
    const tail = readAuditTail(slugDir(f.slug, planningRootForTests())!, 5)
    expect(tail.skipped).toBe(1)
    expect(tail.events).toHaveLength(5)
    expect(tail.events[0].reason).toBe(`event-${total - 5}`)
    expect(tail.events[4].reason).toBe(`event-${total - 1}`)
  })
})

describe("readTopicStatus (trace tail)", () => {
  function runLine(i: number, corrupt = false): string {
    if (corrupt) return "not json"
    return JSON.stringify({
      run_id: `run-${i}`,
      session_id: "ses_x",
      command: "fd-execute",
      args: { prompt: SECRET_PROMPT },
      started_at: "2026-09-05T06:00:00.000Z",
      ended_at: "2026-09-05T06:30:00.000Z",
      status: "complete",
      files_touched: [],
      event_ids: [],
      risk_score: i,
      outcome: "done",
    })
  }

  it("should list the most recent runs first from the tail of RUNS.jsonl", () => {
    writeFixtureFile(f, ".codebase/RUNS.jsonl", [1, 2, 3].map((i) => runLine(i)).join("\n") + "\n")
    const s = readTopicStatus(f.slug, f.topic, planningRootForTests())
    expect(s!.traces).toHaveLength(3)
    expect(s!.traces![0].runId).toBe("run-3")
    expect(s!.traces![1].runId).toBe("run-2")
    expect(s!.traces![2].runId).toBe("run-1")
    expect(s!.traces![2].riskScore).toBe(1)
  })

  it("should cap traces at 20 and skip corrupt lines in the window", () => {
    const lines = Array.from({ length: 25 }, (_, idx) => runLine(idx + 1, idx + 1 === 23))
    writeFixtureFile(f, ".codebase/RUNS.jsonl", lines.join("\n") + "\n")
    const s = readTopicStatus(f.slug, f.topic, planningRootForTests())
    expect(s!.traces).toHaveLength(19)
    expect(s!.traces![0].runId).toBe("run-25")
    expect(s!.traces!.some((t) => t.runId === "run-23")).toBe(false)
  })
})

describe("secret-freedom of parsed output", () => {
  it("should never surface audit details, trace args, session ids, or absolute paths", () => {
    writeCompleteFixture(f)
    const status = readTopicStatus(f.slug, f.topic, planningRootForTests())
    const tail = readAuditTail(slugDir(f.slug, planningRootForTests())!, 50)
    const dumped = JSON.stringify({ status, tail })
    expect(dumped).not.toContain(SECRET_PROMPT)
    expect(dumped).not.toContain(SECRET_TOKEN)
    expect(dumped).not.toContain("ses_x")
    expect(dumped).not.toContain("/home/")
    expect(dumped).not.toContain(homedir())
  })
})

import { describe, expect, it } from "vitest"
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureAgentFiles, FLOWDECK_AGENT_MARKER, renderAgentMarkdown } from "@/v2/agent-files"
import type { AgentConfig } from "@opencode-ai/sdk/v2"

describe("renderAgentMarkdown", () => {
  it("renders frontmatter scalars, tools block, marker and prompt body", () => {
    const md = renderAgentMarkdown("orchestrator", {
      description: "Leads the pipeline",
      mode: "primary",
      model: "anthropic/claude",
      tools: { task: false },
      prompt: "You are the orchestrator.",
    } as AgentConfig)
    expect(md).toContain("mode: primary")
    expect(md).toContain('description: "Leads the pipeline"')
    expect(md).toContain("model: anthropic/claude")
    expect(md).toContain("tools:\n  task: false")
    expect(md).toContain(FLOWDECK_AGENT_MARKER)
    expect(md).toContain("You are the orchestrator.")
  })

  it("falls back to a heading when no prompt is set", () => {
    const md = renderAgentMarkdown("planner", { description: "plans" } as AgentConfig)
    expect(md).toContain("# planner")
  })
})

describe("ensureAgentFiles", () => {
  it("writes new files, overwrites stale flowdeck files, preserves user files", () => {
    const dir = mkdtempSync(join(tmpdir(), "fd-agents-"))

    const first = ensureAgentFiles(dir, {
      orchestrator: { mode: "primary", prompt: "v1 prompt" } as AgentConfig,
      planner: { mode: "subagent", prompt: "planner prompt" } as AgentConfig,
    })
    expect(first.written.sort()).toEqual(["orchestrator", "planner"])
    expect(existsSync(join(dir, "orchestrator.md"))).toBe(true)

    // Idempotent re-run: no writes.
    const second = ensureAgentFiles(dir, {
      orchestrator: { mode: "primary", prompt: "v1 prompt" } as AgentConfig,
      planner: { mode: "subagent", prompt: "planner prompt" } as AgentConfig,
    })
    expect(second.written).toEqual([])

    // Content bump: flowdeck-owned file is rewritten.
    const third = ensureAgentFiles(dir, {
      orchestrator: { mode: "primary", prompt: "v2 prompt" } as AgentConfig,
    })
    expect(third.written).toEqual(["orchestrator"])
    expect(readFileSync(join(dir, "orchestrator.md"), "utf-8")).toContain("v2 prompt")

    // A user-authored file with the same name is never touched.
    writeFileSync(join(dir, "reviewer.md"), "# my custom reviewer\n", "utf-8")
    const fourth = ensureAgentFiles(dir, { reviewer: { mode: "subagent", prompt: "fd" } as AgentConfig })
    expect(fourth.skipped).toEqual(["reviewer"])
    expect(readFileSync(join(dir, "reviewer.md"), "utf-8")).toBe("# my custom reviewer\n")
  })
})

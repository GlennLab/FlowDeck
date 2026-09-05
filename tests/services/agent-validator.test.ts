import { describe, it, expect } from "vitest"
import {
  normalizeToolName,
  validateToolCall,
} from "@/services/agent-validator"

describe("normalizeToolName", () => {
  it.each([
    ["write_file", "write"],
    ["edit_file", "edit"],
    ["apply_patch", "patch"],
    ["str_replace_editor", "edit"],
    ["create_file", "write"],
    ["read_file", "read"],
    ["write", "write"],
    ["bash", "bash"],
    ["totally-unknown-tool", "totally-unknown-tool"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeToolName(input)).toBe(expected)
  })
})

describe("validateToolCall", () => {
  it.each([
    // orchestrator: may delegate and manage planning state
    { agent: "orchestrator", tool: "task", allowed: true, severity: "info" },
    { agent: "orchestrator", tool: "planning-state", allowed: true, severity: "info" },
    { agent: "orchestrator", tool: "read", allowed: true, severity: "info" },
    // orchestrator: may not write or mutate via shell
    { agent: "orchestrator", tool: "write", allowed: false, severity: "block" },
    { agent: "orchestrator", tool: "write_file", allowed: false, severity: "block" },
    { agent: "orchestrator", tool: "edit", allowed: false, severity: "block" },
    { agent: "orchestrator", tool: "bash", allowed: false, severity: "block" },
    { agent: "orchestrator", tool: "apply_patch", allowed: false, severity: "block" },
    // coder: may write and edit
    { agent: "backend-coder", tool: "write", allowed: true, severity: "info" },
    { agent: "backend-coder", tool: "edit", allowed: true, severity: "info" },
    { agent: "backend-coder", tool: "write_file", allowed: true, severity: "info" },
    { agent: "backend-coder", tool: "read_file", allowed: true, severity: "info" },
    { agent: "backend-coder", tool: "bash", allowed: true, severity: "info" },
    // reviewer: read-only
    { agent: "reviewer", tool: "read", allowed: true, severity: "info" },
    { agent: "reviewer", tool: "fdx-diff", allowed: true, severity: "info" },
    { agent: "reviewer", tool: "write", allowed: false, severity: "block" },
    { agent: "reviewer", tool: "edit", allowed: false, severity: "block" },
    { agent: "reviewer", tool: "create_file", allowed: false, severity: "block" },
    // security-auditor: read-only
    { agent: "security-auditor", tool: "read", allowed: true, severity: "info" },
    { agent: "security-auditor", tool: "write", allowed: false, severity: "block" },
    { agent: "security-auditor", tool: "edit", allowed: false, severity: "block" },
  ])("$agent + $tool → allowed=$allowed ($severity)", (c) => {
    const verdict = validateToolCall(c.agent, c.tool)
    expect(verdict.allowed).toBe(c.allowed)
    expect(verdict.severity).toBe(c.severity)
  })

  it("unknown tool is a warn, never a block (R-06)", () => {
    const verdict = validateToolCall("reviewer", "teleport-to-moon")
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toBe("unknown-tool")
    expect(verdict.severity).toBe("warn")
  })

  it("a forbiddenAction-only tool is NOT classified unknown-tool (N1)", () => {
    // "patch" appears only in the orchestrator's forbiddenActions — it is in
    // no contract's allowedTools and is not an alias key. The legacy
    // validateToolAccess path blocks it; the new path must agree instead of
    // classifying it as an unknown tool (warn, never block).
    const verdict = validateToolCall("orchestrator", "patch")
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toBe("tool-not-in-contract")
    expect(verdict.severity).toBe("block")
  })

  it("a tool matching a forbiddenAction by substring is NOT classified unknown-tool (N1)", () => {
    // "create" matches the orchestrator's forbiddenAction "create_file" via
    // the same bidirectional substring test the legacy path uses.
    const verdict = validateToolCall("orchestrator", "create")
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toBe("tool-not-in-contract")
    expect(verdict.severity).toBe("block")
  })

  it("known tool outside the contract but not explicitly forbidden is a warn", () => {
    // "bash" is a known tool (other agents allow it), not in the reviewer's
    // allowedTools, and the reviewer's forbiddenActions are phrased as
    // "write or edit any files" — so this is a warn, not a block.
    const verdict = validateToolCall("reviewer", "bash")
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toBe("tool-not-in-contract")
    expect(verdict.severity).toBe("warn")
  })

  it("agent without a contract is allowed with info severity", () => {
    const verdict = validateToolCall("does-not-exist", "write")
    expect(verdict.allowed).toBe(true)
    expect(verdict.reason).toBe("no-contract")
    expect(verdict.severity).toBe("info")
  })
})

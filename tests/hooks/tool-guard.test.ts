import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { toolGuardHook, clearWriteCounter, getWriteCount, clearToolGuardDecisions, getRecentToolGuardDecisions } from "@/hooks/tool-guard"
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { planningDir } from "@/tools/planning-state-lib"
import { auditLogPath } from "@/services/audit-log"

const TMP = join(process.cwd(), "tmp-test-guard")
const TEST_SESSION = "test-session"

describe("toolGuardHook - Phase Enforcement", () => {
  beforeEach(() => {
    process.env.FLOWDECK_TOOL_GUARD_ENABLED = "on"
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
    if (!existsSync(planningDir(TMP))) mkdirSync(planningDir(TMP), { recursive: true })
    clearWriteCounter(TEST_SESSION)
  })

  afterEach(() => {
    delete process.env.FLOWDECK_TOOL_GUARD_ENABLED
    rmSync(TMP, { recursive: true, force: true })
    rmSync(planningDir(TMP), { recursive: true, force: true })
    clearWriteCounter(TEST_SESSION)
  })

  it("blocks write tool in discuss phase (phase 1)", async () => {
    writeFileSync(join(planningDir(TMP), "STATE.md"), "phase: 1\nstatus: planned")
    
    const ctx = { directory: TMP }
    const input = { tool: "write" }
    const output = { args: { filePath: "src/index.ts" } }

    await expect(toolGuardHook(ctx, input, output)).rejects.toThrow(/blocked in phase 1/)
  })

  it("blocks edit tool in plan phase (phase 2)", async () => {
    writeFileSync(join(planningDir(TMP), "STATE.md"), "phase: 2\nstatus: planned")
    
    const ctx = { directory: TMP }
    const input = { tool: "edit" }
    const output = { args: { filePath: "src/index.ts" } }

    await expect(toolGuardHook(ctx, input, output)).rejects.toThrow(/blocked in phase 2/)
  })

  it("allows write tool in execute phase (phase 3)", async () => {
    writeFileSync(join(planningDir(TMP), "STATE.md"), "phase: 3\nstatus: in_progress\nrequires_design_first: false")
    
    const ctx = { directory: TMP }
    const input = { tool: "write" }
    const output = { args: { filePath: "src/index.ts" } }

    await toolGuardHook(ctx, input, output)
  })

  it("blocks write tool for UI-heavy plans without approved design handoff", async () => {
    mkdirSync(join(planningDir(TMP), "phases", "phase-3"), { recursive: true })
    writeFileSync(
      join(planningDir(TMP), "STATE.md"),
      "phase: 3\nstatus: in_progress\nrequires_design_first: true\ndesign_stage: \"pending\"\ndesign_approved: false\ndesign_override: false",
    )
    writeFileSync(
      join(planningDir(TMP), "phases", "phase-3", "PLAN.md"),
      "# PLAN\n- Build a landing page with responsive sections and CTA flow\n",
    )

    const ctx = { directory: TMP }
    const input = { tool: "write" }
    const output = { args: { filePath: "src/ui.tsx" } }

    await expect(toolGuardHook(ctx, input, output)).rejects.toThrow(/design-gate/)
  })

  it("allows write tool for UI-heavy plans with explicit override reason", async () => {
    mkdirSync(join(planningDir(TMP), "phases", "phase-3"), { recursive: true })
    writeFileSync(
      join(planningDir(TMP), "STATE.md"),
      "phase: 3\nstatus: in_progress\nrequires_design_first: true\ndesign_stage: \"pending\"\ndesign_approved: false\ndesign_override: true\ndesign_override_reason: \"urgent hotfix\"",
    )
    writeFileSync(
      join(planningDir(TMP), "phases", "phase-3", "PLAN.md"),
      "# PLAN\n- Build admin panel settings page\n",
    )

    const ctx = { directory: TMP }
    const input = { tool: "write" }
    const output = { args: { filePath: "src/ui.tsx" } }

    await toolGuardHook(ctx, input, output)
  })

  it("allows read tool in any phase", async () => {
    writeFileSync(join(planningDir(TMP), "STATE.md"), "phase: 1\nstatus: planned")
    
    const ctx = { directory: TMP }
    const input = { tool: "read" }
    const output = { args: { filePath: "src/index.ts" } }

    await toolGuardHook(ctx, input, output)
  })
})

describe("toolGuardHook - Write Limit", () => {
  beforeEach(() => {
    process.env.FLOWDECK_TOOL_GUARD_ENABLED = "on"
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
    if (!existsSync(planningDir(TMP))) mkdirSync(planningDir(TMP), { recursive: true })
    writeFileSync(
      join(planningDir(TMP), "STATE.md"),
      "phase: 3\nstatus: in_progress\nrequires_design_first: false",
    )
    clearWriteCounter(TEST_SESSION)
  })

  afterEach(() => {
    delete process.env.FLOWDECK_TOOL_GUARD_ENABLED
    rmSync(TMP, { recursive: true, force: true })
    rmSync(planningDir(TMP), { recursive: true, force: true })
    clearWriteCounter(TEST_SESSION)
  })

  it("allows writes up to the configured limit", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "write", sessionID: TEST_SESSION }

    for (let i = 1; i <= 14; i++) {
      const output = { args: { filePath: `src/file${i}.ts` } }
      await toolGuardHook(ctx, input, output)
    }
  })

  it("allows the 15th unique file write", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "write", sessionID: TEST_SESSION }

    for (let i = 1; i <= 15; i++) {
      const output = { args: { filePath: `src/file${i}.ts` } }
      await toolGuardHook(ctx, input, output)
    }
  })

  it("blocks the 16th unique file write", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "write", sessionID: TEST_SESSION }

    for (let i = 1; i <= 15; i++) {
      const output = { args: { filePath: `src/file${i}.ts` } }
      await toolGuardHook(ctx, input, output)
    }

    const output16 = { args: { filePath: "src/file16.ts" } }
    await expect(toolGuardHook(ctx, input, output16)).rejects.toThrow(/Write limit reached/)
  })

  it("counts repeated writes to the same file as one", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "write", sessionID: TEST_SESSION }

    for (let i = 0; i < 5; i++) {
      const output = { args: { filePath: "src/same.ts" } }
      await toolGuardHook(ctx, input, output)
    }

    expect(getWriteCount(TEST_SESSION)).toBe(1)
  })

  it("clearWriteCounter resets the count to 0", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "write", sessionID: TEST_SESSION }

    for (let i = 1; i <= 15; i++) {
      const output = { args: { filePath: `src/file${i}.ts` } }
      await toolGuardHook(ctx, input, output)
    }

    clearWriteCounter(TEST_SESSION)

    for (let i = 1; i <= 15; i++) {
      const output = { args: { filePath: `src/after${i}.ts` } }
      await toolGuardHook(ctx, input, output)
    }

    const output16 = { args: { filePath: "src/after16.ts" } }
    await expect(toolGuardHook(ctx, input, output16)).rejects.toThrow(/Write limit reached/)
  })
})

describe("toolGuardHook - Default ON", () => {
  beforeEach(() => {
    delete process.env.FLOWDECK_TOOL_GUARD_ENABLED
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
    if (!existsSync(planningDir(TMP))) mkdirSync(planningDir(TMP), { recursive: true })
    writeFileSync(join(planningDir(TMP), "STATE.md"), "phase: 1\nstatus: planned")
    clearWriteCounter(TEST_SESSION)
  })

  afterEach(() => {
    delete process.env.FLOWDECK_TOOL_GUARD_ENABLED
    rmSync(TMP, { recursive: true, force: true })
    rmSync(planningDir(TMP), { recursive: true, force: true })
    clearWriteCounter(TEST_SESSION)
  })

  it("blocks write in discuss phase without explicit env", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "write" }
    const output = { args: { filePath: "src/index.ts" } }
    await expect(toolGuardHook(ctx, input, output)).rejects.toThrow(/blocked in phase 1/)
  })

  it("allows all tools when FLOWDECK_TOOL_GUARD_ENABLED=off", async () => {
    process.env.FLOWDECK_TOOL_GUARD_ENABLED = "off"
    const ctx = { directory: TMP }
    const input = { tool: "write" }
    const output = { args: { filePath: "src/index.ts" } }
    await toolGuardHook(ctx, input, output)
  })
})

describe("toolGuardHook - Expanded write-tool coverage", () => {
  beforeEach(() => {
    process.env.FLOWDECK_TOOL_GUARD_ENABLED = "on"
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
    if (!existsSync(planningDir(TMP))) mkdirSync(planningDir(TMP), { recursive: true })
    writeFileSync(
      join(planningDir(TMP), "STATE.md"),
      "phase: 3\nstatus: in_progress\nrequires_design_first: false",
    )
    clearWriteCounter(TEST_SESSION)
  })

  afterEach(() => {
    delete process.env.FLOWDECK_TOOL_GUARD_ENABLED
    rmSync(TMP, { recursive: true, force: true })
    rmSync(planningDir(TMP), { recursive: true, force: true })
    clearWriteCounter(TEST_SESSION)
  })

  it("blocks edit tool writing to node_modules", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "edit" }
    const output = { args: { filePath: "node_modules/foo/index.js" } }
    await expect(toolGuardHook(ctx, input, output)).rejects.toThrow(/Writing to "node_modules" is blocked/)
  })

  it("blocks apply_patch tool writing to node_modules", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "apply_patch" }
    const output = { args: { path: "node_modules/foo/index.js" } }
    await expect(toolGuardHook(ctx, input, output)).rejects.toThrow(/Writing to "node_modules" is blocked/)
  })

  it("blocks hash-edit tool writing to node_modules", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "hash-edit" }
    const output = { args: { file_path: "node_modules/foo/index.js" } }
    await expect(toolGuardHook(ctx, input, output)).rejects.toThrow(/Writing to "node_modules" is blocked/)
  })

  it("blocks str_replace tool writing to node_modules", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "str_replace" }
    const output = { args: { file: "node_modules/foo/index.js" } }
    await expect(toolGuardHook(ctx, input, output)).rejects.toThrow(/Writing to "node_modules" is blocked/)
  })

  it("allows edit tool in execute phase for normal path", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "edit", sessionID: TEST_SESSION }
    const output = { args: { filePath: "src/index.ts" } }
    await toolGuardHook(ctx, input, output)
  })

  it("records decisions for diagnostics", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "write", sessionID: TEST_SESSION }
    const output = { args: { filePath: "src/index.ts" } }
    const { getRecentToolGuardDecisions, clearToolGuardDecisions } = await import("@/hooks/tool-guard")
    clearToolGuardDecisions()
    await toolGuardHook(ctx, input, output)
    const decisions = getRecentToolGuardDecisions()
    expect(decisions.length).toBeGreaterThan(0)
    expect(decisions[0].tool).toBe("write")
    expect(decisions[0].allowed).toBe(true)
  })
})

describe("toolGuardHook - Worker tool permissions", () => {
  beforeEach(() => {
    process.env.FLOWDECK_TOOL_GUARD_ENABLED = "on"
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
    if (!existsSync(planningDir(TMP))) mkdirSync(planningDir(TMP), { recursive: true })
    writeFileSync(
      join(planningDir(TMP), "STATE.md"),
      "phase: 3\nstatus: in_progress\nrequires_design_first: false",
    )
    clearWriteCounter(TEST_SESSION)
  })

  afterEach(() => {
    delete process.env.FLOWDECK_TOOL_GUARD_ENABLED
    rmSync(TMP, { recursive: true, force: true })
    rmSync(planningDir(TMP), { recursive: true, force: true })
    clearWriteCounter(TEST_SESSION)
  })

  it("blocks researcher from writing files per contract via ctx.agent", async () => {
    const ctx = { directory: TMP, agent: "researcher" }
    const input = { tool: "write", sessionID: TEST_SESSION }
    const output = { args: { filePath: "src/index.ts" } }
    await expect(toolGuardHook(ctx, input, output)).rejects.toThrow(/not in allowedTools/)
  })

  it("blocks researcher from writing files per contract via ctx.session.agent", async () => {
    const ctx = { directory: TMP, session: { agent: "researcher" } }
    const input = { tool: "write", sessionID: TEST_SESSION }
    const output = { args: { filePath: "src/index.ts" } }
    await expect(toolGuardHook(ctx, input, output)).rejects.toThrow(/not in allowedTools/)
  })

  it("allows backend-coder to write files per contract", async () => {
    const ctx = { directory: TMP, agent: "backend-coder" }
    const input = { tool: "write", sessionID: TEST_SESSION }
    const output = { args: { filePath: "src/index.ts" } }
    await toolGuardHook(ctx, input, output)
  })
})

describe("toolGuardHook - Contract enforcement (LE-1 Wave 2)", () => {
  function writeConfig(config: Record<string, unknown>): void {
    writeFileSync(join(TMP, ".flowdeck.json"), JSON.stringify(config))
  }

  function readAuditEvents(dir: string): Array<Record<string, unknown>> {
    const p = auditLogPath(dir)
    if (!existsSync(p)) return []
    return readFileSync(p, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
  }

  beforeEach(() => {
    process.env.FLOWDECK_TOOL_GUARD_ENABLED = "on"
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
    if (!existsSync(planningDir(TMP))) mkdirSync(planningDir(TMP), { recursive: true })
    writeFileSync(
      join(planningDir(TMP), "STATE.md"),
      "phase: 3\nstatus: in_progress\nrequires_design_first: false",
    )
    clearWriteCounter(TEST_SESSION)
  })

  afterEach(() => {
    delete process.env.FLOWDECK_TOOL_GUARD_ENABLED
    rmSync(TMP, { recursive: true, force: true })
    rmSync(planningDir(TMP), { recursive: true, force: true })
    clearWriteCounter(TEST_SESSION)
  })

  it("strict: blocks a disallowed call (reviewer + write) and emits guard.block", async () => {
    writeConfig({ governance: { validator: { mode: "strict" } } })
    const ctx = { directory: TMP, agent: "reviewer" }
    const input = { tool: "write", sessionID: TEST_SESSION }
    const output = { args: { filePath: "src/index.ts" } }

    const promise = toolGuardHook(ctx, input, output)
    await expect(promise).rejects.toThrow(/Agent "reviewer"/)
    await expect(promise).rejects.toThrow(/write/)

    const events = readAuditEvents(TMP)
    expect(
      events.some((e) => e.kind === "guard.block" && e.agent === "reviewer" && e.tool === "write"),
    ).toBe(true)
  })

  it("strict: blocks an aliased write via the normalized contract check (reviewer + write_file)", async () => {
    writeConfig({ governance: { validator: { mode: "strict" } } })
    const ctx = { directory: TMP, agent: "reviewer" }
    const input = { tool: "write_file", sessionID: TEST_SESSION }
    const output = { args: { filePath: "src/index.ts" } }

    const promise = toolGuardHook(ctx, input, output)
    await expect(promise).rejects.toThrow(/contract-enforcement/)
    await expect(promise).rejects.toThrow(/tool-not-in-contract/)

    const events = readAuditEvents(TMP)
    expect(
      events.some((e) => e.kind === "guard.block" && e.agent === "reviewer" && e.tool === "write_file"),
    ).toBe(true)
  })

  it("warn: allows the call through and emits guard.warn (reviewer + bash)", async () => {
    writeConfig({ governance: { validator: { mode: "advisory", contractEnforcement: "warn" } } })
    const ctx = { directory: TMP, agent: "reviewer" }
    const input = { tool: "bash", sessionID: TEST_SESSION }
    const output = { args: { command: "ls -la" } }

    await toolGuardHook(ctx, input, output)

    const events = readAuditEvents(TMP)
    expect(
      events.some(
        (e) =>
          e.kind === "guard.warn" &&
          e.agent === "reviewer" &&
          e.tool === "bash" &&
          e.reason === "tool-not-in-contract",
      ),
    ).toBe(true)
  })

  it("warn: allows a block-severity violation through when enforcement is warn (reviewer + write_file)", async () => {
    writeConfig({ governance: { validator: { mode: "advisory", contractEnforcement: "warn" } } })
    const ctx = { directory: TMP, agent: "reviewer" }
    const input = { tool: "write_file", sessionID: TEST_SESSION }
    const output = { args: { filePath: "src/index.ts" } }

    await toolGuardHook(ctx, input, output)

    const events = readAuditEvents(TMP)
    expect(
      events.some((e) => e.kind === "guard.warn" && e.agent === "reviewer" && e.tool === "write_file"),
    ).toBe(true)
  })

  it("off: no block and no contract audit events (reviewer + write)", async () => {
    writeConfig({ governance: { validator: { mode: "off" } } })
    const ctx = { directory: TMP, agent: "reviewer" }
    const input = { tool: "write", sessionID: TEST_SESSION }
    const output = { args: { filePath: "src/index.ts" } }

    await toolGuardHook(ctx, input, output)

    const events = readAuditEvents(TMP)
    expect(events.some((e) => e.kind === "guard.block" || e.kind === "guard.warn")).toBe(false)
  })

  it.each(["orchestrator", "planner", "mapper"])(
    "path exception (R-04): %s may write under ~/.fd-plan/ in strict mode",
    async (agent) => {
      writeConfig({ governance: { validator: { mode: "strict" } } })
      const planningPath = join(homedir(), ".fd-plan", "le1-test-slug", "STATE.md")
      const ctx = { directory: TMP, agent }
      const input = { tool: "write", sessionID: TEST_SESSION }
      const output = { args: { filePath: planningPath } }

      await toolGuardHook(ctx, input, output)
    },
  )

  it("path exception (R-04): orchestrator writing project source is still blocked in strict mode", async () => {
    writeConfig({ governance: { validator: { mode: "strict" } } })
    const ctx = { directory: TMP, agent: "orchestrator" }
    const input = { tool: "write", sessionID: TEST_SESSION }
    const output = { args: { filePath: "src/index.ts" } }

    await expect(toolGuardHook(ctx, input, output)).rejects.toThrow()
  })

  it.each([
    ["tilde traversal", "~/.fd-plan/../../src/x.ts"],
    ["absolute traversal", `${join(homedir(), ".fd-plan")}/../../src/x.ts`],
  ])(
    "path exception (R-04): %s is NOT exempt — orchestrator write is blocked in strict mode",
    async (_label, traversalPath) => {
      writeConfig({ governance: { validator: { mode: "strict" } } })
      const ctx = { directory: TMP, agent: "orchestrator" }
      const input = { tool: "write", sessionID: TEST_SESSION }
      const output = { args: { filePath: traversalPath } }

      // Traversal out of ~/.fd-plan/ must not inherit the planning-artifact
      // carve-out; the write is blocked by the agent-contract check.
      await expect(toolGuardHook(ctx, input, output)).rejects.toThrow()
    },
  )
})

describe("toolGuardHook - Hard blocks regression (R-05)", () => {
  function writeConfig(config: Record<string, unknown>): void {
    writeFileSync(join(TMP, ".flowdeck.json"), JSON.stringify(config))
  }

  beforeEach(() => {
    process.env.FLOWDECK_TOOL_GUARD_ENABLED = "on"
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
    if (!existsSync(planningDir(TMP))) mkdirSync(planningDir(TMP), { recursive: true })
    writeFileSync(
      join(planningDir(TMP), "STATE.md"),
      "phase: 3\nstatus: in_progress\nrequires_design_first: false",
    )
    clearWriteCounter(TEST_SESSION)
  })

  afterEach(() => {
    delete process.env.FLOWDECK_TOOL_GUARD_ENABLED
    rmSync(TMP, { recursive: true, force: true })
    rmSync(planningDir(TMP), { recursive: true, force: true })
    clearWriteCounter(TEST_SESSION)
  })

  it("still blocks read of .env files", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "read" }
    const output = { args: { filePath: "src/.env" } }
    await expect(toolGuardHook(ctx, input, output)).rejects.toThrow(
      /Access to ".env" files is blocked/,
    )
  })

  it("still blocks read of .pem files", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "read" }
    const output = { args: { filePath: "keys/server.pem" } }
    await expect(toolGuardHook(ctx, input, output)).rejects.toThrow(
      /Access to ".pem" files is blocked/,
    )
  })

  it("still blocks bash commands containing rm -rf", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "bash" }
    const output = { args: { command: "rm -rf /tmp/whatever" } }
    await expect(toolGuardHook(ctx, input, output)).rejects.toThrow(
      /Command containing "rm -rf" is blocked/,
    )
  })

  it("still blocks writes to node_modules", async () => {
    const ctx = { directory: TMP }
    const input = { tool: "write" }
    const output = { args: { filePath: "node_modules/foo/index.js" } }
    await expect(toolGuardHook(ctx, input, output)).rejects.toThrow(
      /Writing to "node_modules" is blocked/,
    )
  })

  it("hard blocks fire BEFORE the contract check (strict + orchestrator + rm -rf)", async () => {
    writeConfig({ governance: { validator: { mode: "strict" } } })
    const ctx = { directory: TMP, agent: "orchestrator" }
    const input = { tool: "bash" }
    const output = { args: { command: "rm -rf node_modules" } }
    const promise = toolGuardHook(ctx, input, output)
    await expect(promise).rejects.toThrow(/Command containing "rm -rf" is blocked/)
    await expect(promise).rejects.not.toThrow(/contract-enforcement/)
  })
})

describe("toolGuardHook - Contract enforcement E2E (LE-1 Wave 3)", () => {
  /**
   * Acceptance criterion: strict → disallowed call blocked + guard.block line
   * in AUDIT.jsonl; warn → same call passes + guard.warn line; off → no block,
   * no contract audit events.
   *
   * The disallowed call is `reviewer + write_file` (the R-06 alias of
   * "write"): it is the only write shape where the contractEnforcement key
   * itself decides block vs. warn — the pre-existing validateToolAccess path
   * sees the raw name "write_file" as warn-severity, while the normalized
   * contract check sees "write" as block-severity.
   *
   * Assertions read the raw AUDIT.jsonl lines (not parsed events); each test
   * starts with a fresh audit file because afterEach removes planningDir(TMP),
   * which owns .codebase/AUDIT.jsonl.
   */

  function writeConfig(config: Record<string, unknown>): void {
    writeFileSync(join(TMP, ".flowdeck.json"), JSON.stringify(config))
  }

  function auditLines(dir: string): string[] {
    const p = auditLogPath(dir)
    if (!existsSync(p)) return []
    return readFileSync(p, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
  }

  beforeEach(() => {
    process.env.FLOWDECK_TOOL_GUARD_ENABLED = "on"
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
    if (!existsSync(planningDir(TMP))) mkdirSync(planningDir(TMP), { recursive: true })
    writeFileSync(
      join(planningDir(TMP), "STATE.md"),
      "phase: 3\nstatus: in_progress\nrequires_design_first: false",
    )
    clearWriteCounter(TEST_SESSION)
  })

  afterEach(() => {
    delete process.env.FLOWDECK_TOOL_GUARD_ENABLED
    rmSync(TMP, { recursive: true, force: true })
    rmSync(planningDir(TMP), { recursive: true, force: true })
    clearWriteCounter(TEST_SESSION)
  })

  it("strict: reviewer + write_file is blocked and a guard.block line lands in AUDIT.jsonl", async () => {
    writeConfig({ governance: { validator: { mode: "advisory", contractEnforcement: "strict" } } })
    const ctx = { directory: TMP, agent: "reviewer" }
    const input = { tool: "write_file", sessionID: TEST_SESSION }
    const output = { args: { filePath: "src/index.ts" } }

    const promise = toolGuardHook(ctx, input, output)
    await expect(promise).rejects.toThrow(/Agent "reviewer"/)
    await expect(promise).rejects.toThrow(/contract rule: tool-not-in-contract/)

    const lines = auditLines(TMP)
    expect(
      lines.some(
        (line) =>
          line.includes('"kind":"guard.block"') &&
          line.includes('"agent":"reviewer"') &&
          line.includes('"tool":"write_file"'),
      ),
    ).toBe(true)
  })

  it("warn: the same call (reviewer + write_file) passes through and a guard.warn line lands in AUDIT.jsonl", async () => {
    writeConfig({ governance: { validator: { mode: "advisory", contractEnforcement: "warn" } } })
    const ctx = { directory: TMP, agent: "reviewer" }
    const input = { tool: "write_file", sessionID: TEST_SESSION }
    const output = { args: { filePath: "src/index.ts" } }

    await toolGuardHook(ctx, input, output)

    const lines = auditLines(TMP)
    expect(
      lines.some(
        (line) =>
          line.includes('"kind":"guard.warn"') &&
          line.includes('"agent":"reviewer"') &&
          line.includes('"tool":"write_file"'),
      ),
    ).toBe(true)
  })

  it("off: the same call (reviewer + write_file) passes with no guard.block or guard.warn lines", async () => {
    writeConfig({ governance: { validator: { mode: "advisory", contractEnforcement: "off" } } })
    const ctx = { directory: TMP, agent: "reviewer" }
    const input = { tool: "write_file", sessionID: TEST_SESSION }
    const output = { args: { filePath: "src/index.ts" } }

    await toolGuardHook(ctx, input, output)

    const lines = auditLines(TMP)
    expect(lines.some((line) => line.includes('"kind":"guard.block"'))).toBe(false)
    expect(lines.some((line) => line.includes('"kind":"guard.warn"'))).toBe(false)
  })

  it("strict: canonical reviewer + write is blocked and a guard.block line lands in AUDIT.jsonl", async () => {
    writeConfig({ governance: { validator: { mode: "advisory", contractEnforcement: "strict" } } })
    const ctx = { directory: TMP, agent: "reviewer" }
    const input = { tool: "write", sessionID: TEST_SESSION }
    const output = { args: { filePath: "src/index.ts" } }

    const promise = toolGuardHook(ctx, input, output)
    await expect(promise).rejects.toThrow(/Agent "reviewer"/)

    const lines = auditLines(TMP)
    expect(
      lines.some(
        (line) =>
          line.includes('"kind":"guard.block"') &&
          line.includes('"agent":"reviewer"') &&
          line.includes('"tool":"write"'),
      ),
    ).toBe(true)
  })
})

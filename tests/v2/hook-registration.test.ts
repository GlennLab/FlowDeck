import { describe, expect, it } from "vitest"
import { registerShellEnvBridge, registerToolExecuteBridge } from "@/v2/hook-registration"
import type {
  LegacyHooks,
  Registration,
  ShellDomainSlice,
  ToolDomainSlice,
  ToolEditorSlice,
  ToolHookAfterEvent,
  ToolHookBeforeEvent,
} from "@/v2/types"

interface FakeDomains {
  before: Array<(e: ToolHookBeforeEvent) => Promise<void> | void>
  after: Array<(e: ToolHookAfterEvent) => Promise<void> | void>
  createBefore: Array<(e: { command: string; cwd: string; env: Record<string, string | undefined> }) => Promise<void> | void>
  tool: ToolDomainSlice
  shell: ShellDomainSlice
}

function fakeDomains(): FakeDomains {
  const before: FakeDomains["before"] = []
  const after: FakeDomains["after"] = []
  const createBefore: FakeDomains["createBefore"] = []
  const reg: Registration = { dispose: async () => {} }
  const editor: ToolEditorSlice = { add: () => {} }
  return {
    before,
    after,
    createBefore,
    tool: {
      transform: async (cb) => {
        cb(editor)
        return reg
      },
      hook: async (name, callback) => {
        if (name === "execute.before") before.push(callback as (e: ToolHookBeforeEvent) => Promise<void>)
        else after.push(callback as (e: ToolHookAfterEvent) => Promise<void>)
        return reg
      },
    },
    shell: {
      hook: async (_name, callback) => {
        createBefore.push(callback as (e: { command: string; cwd: string; env: Record<string, string | undefined> }) => Promise<void>)
        return reg
      },
    },
  }
}

describe("registerToolExecuteBridge", () => {
  it("forwards before events and propagates replaced args", async () => {
    const domains = fakeDomains()
    const legacy: LegacyHooks = {
      "tool.execute.before": async (_input, output) => {
        const out = output as { args: Record<string, unknown> }
        out.args = { ...out.args, injected: true }
      },
    }
    await registerToolExecuteBridge(domains.tool, legacy)

    const event: ToolHookBeforeEvent = { tool: "write", sessionID: "s1", agent: "a", messageID: "m", input: { filePath: "x" } }
    await domains.before[0](event)
    expect(event.input).toEqual({ filePath: "x", injected: true })
  })

  it("propagates in-place arg mutations", async () => {
    const domains = fakeDomains()
    await registerToolExecuteBridge(domains.tool, {
      "tool.execute.before": async (input) => {
        const args = (input as { args: Record<string, unknown> }).args
        args.normalized = true
      },
    })
    const event: ToolHookBeforeEvent = { tool: "edit", sessionID: "s1", agent: "a", messageID: "m", input: { filePath: "y" } }
    await domains.before[0](event)
    expect((event.input as Record<string, unknown>).normalized).toBe(true)
  })

  it("lets throws propagate to block the call", async () => {
    const domains = fakeDomains()
    await registerToolExecuteBridge(domains.tool, {
      "tool.execute.before": async () => {
        throw new Error("blocked by guard")
      },
    })
    await expect(
      domains.before[0]({ tool: "bash", sessionID: "s1", agent: "a", messageID: "m", input: {} }),
    ).rejects.toThrow("blocked by guard")
  })

  it("appends to the after result content", async () => {
    const domains = fakeDomains()
    await registerToolExecuteBridge(domains.tool, {
      "tool.execute.after": async (_input, output) => {
        const out = output as { output: string }
        out.output += " +reminder"
      },
    })
    const event: ToolHookAfterEvent = {
      tool: "write",
      sessionID: "s1",
      agent: "a",
      messageID: "m",
      input: {},
      status: "completed",
      result: { content: "base" },
    }
    await domains.after[0](event)
    expect(event.result?.content).toBe("base +reminder")
  })

  it("skips errored tool results", async () => {
    const domains = fakeDomains()
    let called = 0
    await registerToolExecuteBridge(domains.tool, {
      "tool.execute.after": async () => {
        called += 1
      },
    })
    const event: ToolHookAfterEvent = {
      tool: "bash",
      sessionID: "s1",
      agent: "a",
      messageID: "m",
      input: {},
      status: "error",
      error: { name: "Error" },
    }
    await domains.after[0](event)
    expect(called).toBe(0)
  })
})

describe("registerShellEnvBridge", () => {
  it("propagates env writes onto the V2 event", async () => {
    const domains = fakeDomains()
    await registerShellEnvBridge(domains.shell, {
      "shell.env": async (_input, output) => {
        output.env.FLOWDECK_PHASE = "execute"
      },
    })
    const event = { command: "ls", cwd: "/repo", env: {} as Record<string, string | undefined> }
    await domains.createBefore[0](event)
    expect(event.env.FLOWDECK_PHASE).toBe("execute")
  })

  it("registers nothing when the legacy hook is absent", async () => {
    const domains = fakeDomains()
    const registrations = await registerShellEnvBridge(domains.shell, {})
    expect(registrations).toHaveLength(0)
  })
})

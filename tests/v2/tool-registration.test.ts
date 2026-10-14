import { describe, expect, it } from "vitest"
import { tool } from "@opencode-ai/plugin"
import { mapLegacyToolResult, registerV2Tools } from "@/v2/tool-registration"
import type {
  Registration,
  ToolDomainSlice,
  ToolEditorSlice,
  V2ToolCallContext,
} from "@/v2/types"

function fakeToolDomain(): { domain: ToolDomainSlice; added: Array<Parameters<ToolEditorSlice["add"]>[0]> } {
  const added: Array<Parameters<ToolEditorSlice["add"]>[0]> = []
  const editor: ToolEditorSlice = { add: (t) => added.push(t) }
  const domain: ToolDomainSlice = {
    transform: async (cb) => {
      cb(editor)
      const reg: Registration = { dispose: async () => {} }
      return reg
    },
    hook: async () => ({ dispose: async () => {} }),
  }
  return { domain, added }
}

function fakeV2Context(overrides: Partial<V2ToolCallContext> = {}): V2ToolCallContext {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "orchestrator",
    signal: new AbortController().signal,
    progress: async () => {},
    ...overrides,
  }
}

interface Zodish {
  safeParse(value: unknown): { success: boolean }
}

describe("registerV2Tools", () => {
  it("adds each V1 tool with a schema-validated input and bridged context", async () => {
    const captured: Array<Record<string, unknown>> = []
    const probe = tool({
      description: "probe tool",
      args: { name: tool.schema.string() },
      async execute(args, context) {
        captured.push({ args: args as unknown as Record<string, unknown>, directory: context.directory, sessionID: context.sessionID })
        return `hello ${args.name}`
      },
    })

    const { domain, added } = fakeToolDomain()
    await registerV2Tools(domain, { probe }, { directory: "/repo", worktree: "/wt" })

    expect(added).toHaveLength(1)
    expect(added[0].name).toBe("probe")
    expect(added[0].description).toBe("probe tool")

    const schema = added[0].input as Zodish
    expect(schema.safeParse({ name: "x" }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)

    const result = await added[0].execute({ name: "world" }, fakeV2Context())
    expect(result).toEqual({ content: "hello world" })
    expect(captured[0]).toEqual({ args: { name: "world" }, directory: "/repo", sessionID: "s1" })
  })
})

describe("mapLegacyToolResult", () => {
  it("maps plain strings to content", () => {
    expect(mapLegacyToolResult("text")).toEqual({ content: "text" })
  })

  it("maps {output, metadata} to content + metadata", () => {
    expect(mapLegacyToolResult({ output: "out", metadata: { k: 1 } })).toEqual({ content: "out", metadata: { k: 1 } })
  })

  it("maps attachments into a content array with a leading text part", () => {
    const mapped = mapLegacyToolResult({
      output: "see file",
      attachments: [{ type: "file", mime: "image/png", url: "file:///x.png", filename: "x.png" }],
    })
    expect(Array.isArray(mapped.content)).toBe(true)
    const parts = mapped.content as Array<Record<string, unknown>>
    expect(parts[0]).toEqual({ type: "text", text: "see file" })
    expect(parts[1].type).toBe("file")
  })

  it("falls back to JSON for unexpected shapes", () => {
    expect(mapLegacyToolResult({ weird: true } as never)).toEqual({ content: '{"weird":true}' })
  })
})

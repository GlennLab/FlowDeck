import { describe, expect, it } from "vitest"
import { registerV2Mcps, toV2McpConfig } from "@/v2/mcp-registration"
import type { LegacyMcpConfig, McpDomainSlice, McpEditorSlice, Registration } from "@/v2/types"

describe("toV2McpConfig", () => {
  it("maps enabled remote servers without a disabled flag", () => {
    const config: LegacyMcpConfig = { type: "remote", url: "https://mcp.example.com/mcp", enabled: true, oauth: false }
    expect(toV2McpConfig(config)).toEqual({ type: "remote", url: "https://mcp.example.com/mcp", oauth: false })
  })

  it("maps disabled servers to the V2 disabled flag and drops enabled", () => {
    const config: LegacyMcpConfig = { type: "local", command: ["npx", "-y", "some-mcp"], enabled: false }
    const mapped = toV2McpConfig(config)
    expect(mapped).toEqual({ type: "local", command: ["npx", "-y", "some-mcp"], disabled: true })
    expect("enabled" in mapped).toBe(false)
  })

  it("keeps remote headers", () => {
    const config: LegacyMcpConfig = { type: "remote", url: "https://x", enabled: true, headers: { Authorization: "Bearer k" } }
    expect(toV2McpConfig(config)).toEqual({ type: "remote", url: "https://x", headers: { Authorization: "Bearer k" } })
  })
})

describe("registerV2Mcps", () => {
  it("sets every server through the editor", async () => {
    const set: Array<[string, Record<string, unknown>]> = []
    const editor: McpEditorSlice = { set: (name, config) => set.push([name, config]) }
    const domain: McpDomainSlice = {
      transform: async (cb) => {
        cb(editor)
        const reg: Registration = { dispose: async () => {} }
        return reg
      },
    }
    await registerV2Mcps(domain, {
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true, oauth: false },
    })
    expect(set).toHaveLength(1)
    expect(set[0][0]).toBe("context7")
    expect(set[0][1].type).toBe("remote")
  })
})

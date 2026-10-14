/**
 * V2 MCP registration for FlowDeck's built-in MCP servers.
 *
 * V1 merged entries into cfg.mcp using the {enabled} flag; V2's
 * McpServerConfig schema uses {disabled} and rejects unknown fields, so
 * configs are mapped explicitly field-by-field.
 */
import type { LegacyMcpConfig, McpDomainSlice } from "./types"

export function toV2McpConfig(config: LegacyMcpConfig): Record<string, unknown> {
  if (config.type === "remote") {
    return {
      type: "remote",
      url: config.url,
      ...(config.headers ? { headers: config.headers } : {}),
      ...(config.oauth === false ? { oauth: false } : {}),
      ...(config.enabled ? {} : { disabled: true }),
    }
  }
  return {
    type: "local",
    command: config.command,
    ...(config.environment ? { environment: config.environment } : {}),
    ...(config.enabled ? {} : { disabled: true }),
  }
}

export async function registerV2Mcps(domain: McpDomainSlice, mcps: Record<string, LegacyMcpConfig>): Promise<void> {
  await domain.transform((editor) => {
    for (const [name, config] of Object.entries(mcps)) {
      editor.set(name, toV2McpConfig(config))
    }
  })
}

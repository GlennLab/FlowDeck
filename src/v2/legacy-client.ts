/**
 * Minimal stand-in for the V1 plugin SDK client.
 *
 * FlowDeck's V1 plugin only ever calls `client.app.log(...)` (diagnostics in
 * src/index.ts and src/hooks/session-idle-hook.ts). V2 plugins have no client
 * object; console output from the plugin lands in the OpenCode server log,
 * which is the equivalent destination. The cast at the call boundary in
 * index.ts is documented there.
 */
import type { LegacyClient, LegacyAppLogger } from "./types"

const PREFIX = "[flowdeck]"

export function createLegacyAppLog(): LegacyAppLogger["log"] {
  return async ({ body }) => {
    const line = `${PREFIX} ${body.service}/${body.level}: ${body.message}`
    if (body.level === "error") console.error(line)
    else console.log(line)
    return { data: {} }
  }
}

export function createLegacyClient(): LegacyClient {
  return { app: { log: createLegacyAppLog() } }
}

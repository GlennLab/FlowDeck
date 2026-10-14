/**
 * V2 tool registration for FlowDeck's V1 tool definitions.
 *
 * V1: tool({ description, args: <zod raw shape>, execute(args, context) })
 * V2: ctx.tool.transform(editor.add({ name, description, input, execute }))
 *     where `input` is a StandardSchemaV1 — zod v4 schemas qualify natively,
 *     so the zod raw shape wraps into z.object(shape) with no JSON-Schema
 *     conversion.
 *
 * The V1 execute context ({directory, worktree, sessionID, abort, metadata,
 * ask}) does not exist in V2 ToolContext, so a compatible object is
 * fabricated per call from the V2 context + the plugin's location. Return
 * values map V1 `string | {output, metadata, attachments}` onto V2
 * `{content, metadata}`.
 */
import { tool } from "@opencode-ai/plugin"
import type { ToolDefinition } from "@opencode-ai/plugin"
import type {
  LegacyHooks,
  ToolDomainSlice,
  V2ToolCallContext,
  V2ToolResult,
} from "./types"

export interface ToolLocation {
  directory: string
  worktree: string
}

/** Fabricate the V1 ToolContext fields FlowDeck tools actually read. */
function buildLegacyToolContext(v2: V2ToolCallContext, location: ToolLocation): Parameters<ToolDefinition["execute"]>[1] {
  return {
    sessionID: v2.sessionID,
    messageID: v2.messageID,
    agent: v2.agent,
    directory: location.directory,
    worktree: location.worktree,
    abort: v2.signal,
    metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => {
      void v2.progress({ kind: "flowdeck.metadata", ...input })
    },
    ask: async () => {
      // V1 permission prompts are not reachable from a V2 tool context;
      // FlowDeck tools never call ask() today — guard against future use.
      throw new Error("flowdeck tool called ask() which the V2 adapter does not support")
    },
  }
}

export function mapLegacyToolResult(value: Awaited<ReturnType<ToolDefinition["execute"]>>): V2ToolResult {
  if (typeof value === "string") return { content: value }
  if (value && typeof value === "object" && typeof value.output === "string") {
    const metadata = value.metadata
    if (value.attachments && value.attachments.length > 0) {
      return {
        content: [{ type: "text", text: value.output }, ...value.attachments],
        ...(metadata ? { metadata } : {}),
      }
    }
    return { content: value.output, ...(metadata ? { metadata } : {}) }
  }
  return { content: JSON.stringify(value ?? null) }
}

export async function registerV2Tools(
  domain: ToolDomainSlice,
  tools: NonNullable<LegacyHooks["tool"]>,
  location: ToolLocation,
): Promise<void> {
  await domain.transform((editor) => {
    for (const [name, definition] of Object.entries(tools)) {
      const legacyExecute = definition.execute
      editor.add({
        name,
        description: definition.description,
        input: tool.schema.object(definition.args),
        execute: async (input, context) =>
          mapLegacyToolResult(
            // The host validates `input` against `input` schema above before
            // execute runs, so it matches the legacy args type.
            await legacyExecute(
              input as Parameters<typeof legacyExecute>[0],
              buildLegacyToolContext(context, location),
            ),
          ),
      })
    }
  })
}

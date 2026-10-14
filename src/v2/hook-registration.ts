/**
 * Bridges the V1 hook functions (tool.execute.before/after, shell.env) onto
 * the V2 hook domains.
 *
 * V1 shape: hook(input, output) where `output` is the mutable payload
 * (args for before, {output: string} for after, {env} for shell.env).
 * V2 shape: hook(event) with a single mutable draft.
 *
 * Blocking semantics carry over by throwing: V1 toolGuardHook/loop detector
 * throw to veto a call, and a throwing execute.before hook aborts the tool
 * run in V2 as well.
 */
import type {
  LegacyHooks,
  Registration,
  ShellDomainSlice,
  ToolDomainSlice,
  ToolHookAfterEvent,
  ToolHookBeforeEvent,
} from "./types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Extract plain-text from a V2 tool result content field. */
function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts = content
      .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => (part as { text: string }).text)
    if (texts.length > 0) return texts.join("")
  }
  return undefined
}

export async function registerToolExecuteBridge(
  domain: ToolDomainSlice,
  legacy: LegacyHooks,
): Promise<Registration[]> {
  const registrations: Registration[] = []

  const before = legacy["tool.execute.before"]
  if (before) {
    registrations.push(
      await domain.hook("execute.before", async (event: ToolHookBeforeEvent) => {
        const args = isRecord(event.input) ? event.input : {}
        const toolInput = { tool: event.tool, name: event.tool, sessionID: event.sessionID, agent: event.agent, args }
        const toolOutput = { args }
        await before(toolInput, toolOutput)
        // Legacy hooks may replace or mutate args; propagate when identity changed.
        if (toolOutput.args !== event.input) event.input = toolOutput.args
      }),
    )
  }

  const after = legacy["tool.execute.after"]
  if (after) {
    registrations.push(
      await domain.hook("execute.after", async (event: ToolHookAfterEvent) => {
        if (event.status !== "completed" || !event.result) return
        const text = contentText(event.result.content)
        if (text === undefined) return
        const toolInput = { tool: event.tool, name: event.tool, sessionID: event.sessionID, args: event.input, output: text }
        const toolOutput = { output: text }
        await after(toolInput, toolOutput)
        if (toolOutput.output !== text) event.result.content = toolOutput.output
      }),
    )
  }

  return registrations
}

export async function registerShellEnvBridge(
  shell: ShellDomainSlice,
  legacy: LegacyHooks,
): Promise<Registration[]> {
  const shellEnv = legacy["shell.env"]
  if (!shellEnv) return []
  return [
    await shell.hook("create.before", async (event) => {
      // Legacy hook assigns keys onto output.env; passing event.env by
      // reference makes those writes land on the V2 draft directly.
      await shellEnv({ cwd: event.cwd }, { env: event.env })
    }),
  ]
}

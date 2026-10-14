/**
 * Shared structural types for the V2 adapter.
 *
 * The adapter bridges the V1 plugin surface (src/index.ts: a function that
 * receives {directory, client, worktree} and returns a hooks object) onto the
 * OpenCode V2 plugin API (a default export {id, setup(ctx)} with domain
 * transforms and hooks — see docs/build/plugins/migrate-v1).
 *
 * Narrow slice interfaces are declared here so both production wiring and
 * tests depend on structure, not the full V2 Context type.
 */
import type { ToolDefinition } from "@opencode-ai/plugin"

/** One V1 plugin registration result: {dispose()} — matches V2 Registration shape. */
export interface Registration {
  dispose(): Promise<void>
}

export type TransformCallback<Editor> = (editor: Editor) => void
export type TransformFn<Editor> = (callback: TransformCallback<Editor>) => Promise<Registration>

/**
 * The hook surface returned by the V1 plugin function in src/index.ts.
 * Only the keys FlowDeck actually returns are modelled; everything is
 * optional so the adapter degrades gracefully when a hook is absent.
 */
export interface LegacyHooks {
  name?: string
  mcp?: Record<string, LegacyMcpConfig>
  tool?: Record<string, ToolDefinition>
  config?: (cfg: Record<string, unknown>) => Promise<void>
  "tool.execute.before"?: (input: unknown, output: unknown) => Promise<void>
  "tool.execute.after"?: (input: unknown, output: unknown) => Promise<void>
  "shell.env"?: (input: unknown, output: { env: Record<string, string | undefined> }) => Promise<void>
  event?: (arg: { event: LegacyBusEvent }) => Promise<void>
  dispose?: () => Promise<void> | void
}

export interface LegacyBusEvent {
  type: string
  properties?: unknown
}

export type LegacyMcpConfig =
  | { type: "remote"; url: string; enabled: boolean; headers?: Record<string, string>; oauth?: false }
  | { type: "local"; command: string[]; environment?: Record<string, string>; enabled: boolean }

/** Minimal V1 client surface FlowDeck uses (client.app.log only). */
export interface LegacyAppLogger {
  log(input: {
    body: { service: string; level: string; message: string }
  }): Promise<{ data?: unknown; error?: unknown }>
}

export interface LegacyClient {
  app: { log: LegacyAppLogger["log"] }
}

/** V2 tool call context subset the bridge relies on. */
export interface V2ToolCallContext {
  readonly sessionID: string
  readonly messageID: string
  readonly agent: string
  readonly signal: AbortSignal
  progress(update: { kind?: string; [key: string]: unknown }): Promise<void>
}

export interface V2ToolResultContentText {
  type: "text"
  text: string
}

export interface V2ToolResult {
  content?: string | Array<V2ToolResultContentText | Record<string, unknown>>
  metadata?: Record<string, unknown>
}

/** Project location data passed to the V1 plugin function. */
export interface LegacyPluginInput {
  directory: string
  client: LegacyClient
  worktree: string
}

export type LegacyPluginFn = (input: LegacyPluginInput) => Promise<LegacyHooks>

/** Domain slices used by the registration helpers (structural, test-friendly). */
export interface ToolDomainSlice {
  transform: TransformFn<ToolEditorSlice>
  hook<Name extends "execute.before" | "execute.after">(
    name: Name,
    callback: (event: ToolHookEvents[Name]) => Promise<void> | void,
  ): Promise<Registration>
}

export interface ToolEditorSlice {
  add(tool: {
    name: string
    description: string
    input: unknown
    execute: (input: Record<string, unknown>, context: V2ToolCallContext) => Promise<V2ToolResult>
  }): void
}

export interface ToolHookBeforeEvent {
  tool: string
  sessionID: string
  agent: string
  messageID: string
  input: unknown
}

export interface ToolHookAfterEvent {
  tool: string
  sessionID: string
  agent: string
  messageID: string
  input: unknown
  status: "completed" | "error"
  result?: V2ToolResult
  error?: unknown
}

export interface ToolHookEvents {
  "execute.before": ToolHookBeforeEvent
  "execute.after": ToolHookAfterEvent
}

export interface ShellDomainSlice {
  hook(
    name: "create.before",
    callback: (event: { command: string; cwd: string; env: Record<string, string | undefined> }) => Promise<void> | void,
  ): Promise<Registration>
}

export interface CommandDomainSlice {
  transform: TransformFn<CommandEditorSlice>
}

export interface CommandEditorSlice {
  add(definition: {
    name: string
    description?: string
    execute: (input: {
      sessionID: string
      prompt: { text: string; [key: string]: unknown }
      delivery: "steer" | "queue"
    }) => Promise<void>
  }): void
}

export interface SkillEditorSlice {
  add(skill: {
    id: string
    name: string
    description?: string
    path: string
    content?: string
    autoinvoke?: boolean
  }): void
}

export interface SkillDomainSlice {
  transform: TransformFn<SkillEditorSlice>
  reload(): Promise<void>
}

export interface McpEditorSlice {
  set(name: string, config: Record<string, unknown>): void
}

export interface McpDomainSlice {
  transform: TransformFn<McpEditorSlice>
}

export interface SessionHookDomains {
  hook(
    name: "context",
    callback: (event: { sessionID: string; system: Array<{ type: string; text: string }> }) => Promise<void> | void,
  ): Promise<Registration>
  prompt(input: {
    sessionID: string
    text: string
    delivery: "steer" | "queue"
    [key: string]: unknown
  }): Promise<unknown>
}

export interface EventStreamSlice {
  subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown>
}

export interface AgentEditorSlice {
  get(id: string): unknown
  default(id: string): void
}

export interface AgentDomainSlice {
  transform: TransformFn<AgentEditorSlice>
  reload(): Promise<void>
}

/**
 * V2 event bus → V1 event bridge.
 *
 * V1 plugins received every bus event through a single `event` hook with
 * {type, properties}. V2 exposes an AsyncIterable of encoded events with
 * {type, data, location}. This module renames the bus events whose names
 * changed after the V1→V2 split (mirrors the mapping opencode-mem uses in
 * production), filters events that belong to another location, and forwards
 * everything else unchanged so FlowDeck's handlers keep working verbatim.
 *
 * Renames learned from the installed V2 event manifest:
 *  - session.execution.{succeeded,failed,interrupted} → session.idle
 *    (V2 no longer publishes session.idle on /api/event; the execution
 *    terminal events are the real "turn finished" signals). Duplicates
 *    within a short window collapse to one delivery per session.
 *  - session.usage.updated → message.updated (assistant, finished, tokens)
 *    so the context-window monitor keeps tracking usage.
 */
import type { EventStreamSlice, LegacyBusEvent, LegacyHooks, Registration } from "./types"

const IDLE_ALIASES: Record<string, string> = {
  "session.execution.succeeded": "session.idle",
  "session.execution.failed": "session.idle",
  "session.execution.interrupted": "session.idle",
}

const IDLE_COALESCE_MS = 2_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function field(obj: unknown, ...keys: string[]): unknown {
  let current = obj
  for (const key of keys) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

/** Normalize a number-ish token field (missing → 0). */
function tokenNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** Build the V1 properties payload for a usage event, or undefined when the
 *  event carries no token data the monitor can use. */
function usageToMessageProperties(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const sessionID = field(data, "sessionID") ?? field(data, "session", "id")
  const usage = (isRecord(data.usage) ? data.usage : undefined) ?? (isRecord(data.tokens) ? data.tokens : undefined)
  if (typeof sessionID !== "string" || !usage) return undefined
  const cache = isRecord(usage.cache) ? usage.cache : {}
  return {
    info: {
      role: "assistant",
      finish: true,
      sessionID,
      tokens: {
        input: tokenNumber(usage.input),
        output: tokenNumber(usage.output),
        cache: { read: tokenNumber(cache.read), write: tokenNumber(cache.write) },
      },
    },
  }
}

/** Translate one V2 encoded event into the V1 {type, properties} shape. */
export function toLegacyEvent(raw: unknown): LegacyBusEvent | undefined {
  if (!isRecord(raw)) return undefined
  const envelope = isRecord(raw.payload) ? raw.payload : raw
  const source = envelope.type === "sync" && isRecord(envelope.syncEvent) ? envelope.syncEvent : envelope
  const rawType = typeof source.type === "string" ? source.type.replace(/\.1$/, "") : undefined
  if (!rawType) return undefined
  const data = isRecord(source.data) ? source.data : {}

  if (rawType === "session.usage.updated") {
    const properties = usageToMessageProperties(data)
    if (!properties) return undefined
    return { type: "message.updated", properties }
  }

  if (isRecord(source.properties)) return { type: rawType, properties: source.properties }
  if (rawType === "session.created" || rawType === "session.updated") {
    return { type: rawType, properties: { info: data.session ?? data.info ?? data } }
  }
  return { type: rawType, properties: data }
}

/** Coalesce idle/usage duplicates; keep ordering stable per session. */
export class IdleCoalescer {
  private last = new Map<string, number>()

  constructor(private readonly windowMs = IDLE_COALESCE_MS) {}

  /** Returns true when this idle event should be delivered; repeats are
   *  measured against the last DELIVERED event, not the last seen one. */
  accept(type: string, sessionID: unknown, now: number): boolean {
    if (type !== "session.idle") return true
    if (typeof sessionID !== "string") return true
    const previous = this.last.get(sessionID)
    if (previous !== undefined && now - previous < this.windowMs) return false
    this.last.set(sessionID, now)
    return true
  }
}

export function eventBelongsToLocation(
  raw: unknown,
  locationDirectory: string,
  lookupSession: (sessionID: string) => Promise<unknown>,
): Promise<boolean> {
  return belongsToLocation(raw, locationDirectory, lookupSession, new Map())
}

async function belongsToLocation(
  raw: unknown,
  locationDirectory: string,
  lookupSession: (sessionID: string) => Promise<unknown>,
  sessionCache: Map<string, boolean>,
): Promise<boolean> {
  const directory =
    field(raw, "location", "directory") ??
    field(raw, "directory") ??
    field(raw, "payload", "location", "directory") ??
    field(raw, "data", "info", "directory")
  if (typeof directory === "string") return normalizePath(directory) === normalizePath(locationDirectory)

  const sessionID = field(raw, "data", "sessionID") ?? field(raw, "payload", "data", "sessionID") ?? field(raw, "properties", "sessionID")
  if (typeof sessionID === "string") {
    const cached = sessionCache.get(sessionID)
    if (cached !== undefined) return cached
    let belongs = false
    try {
      const session = await lookupSession(sessionID)
      const sessionDir = field(session, "location", "directory") ?? field(session, "directory") ?? field(session, "data", "location", "directory")
      belongs = typeof sessionDir === "string" && normalizePath(sessionDir) === normalizePath(locationDirectory)
    } catch {
      belongs = false
    }
    sessionCache.set(sessionID, belongs)
    return belongs
  }

  // Unlocatable events (inventory updates etc.) are harmless for FlowDeck's
  // handlers which key off sessionIDs; forward them.
  return true
}

function normalizePath(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path
}

export async function startEventBridge(
  event: EventStreamSlice,
  directory: string,
  legacyEvent: NonNullable<LegacyHooks["event"]>,
  lookupSession: (sessionID: string) => Promise<unknown>,
): Promise<() => Promise<void>> {
  const controller = new AbortController()
  const coalescer = new IdleCoalescer()

  const pump = (async () => {
    try {
      for await (const raw of event.subscribe({ signal: controller.signal })) {
        if (!(await belongsToLocation(raw, directory, lookupSession, new Map()))) continue
        const legacyRawEvent = toLegacyEvent(raw)
        if (!legacyRawEvent) continue
        const aliasedType = IDLE_ALIASES[legacyRawEvent.type] ?? legacyRawEvent.type
        const sessionID = field(legacyRawEvent.properties, "sessionID") ?? field(legacyRawEvent.properties, "info", "id")
        const legacyEventPayload: LegacyBusEvent =
          aliasedType === "session.idle"
            ? { type: "session.idle", properties: { sessionID: typeof sessionID === "string" ? sessionID : "" } }
            : { type: aliasedType, properties: legacyRawEvent.properties }
        if (!coalescer.accept(aliasedType, sessionID, Date.now())) continue
        await legacyEvent({ event: legacyEventPayload })
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error("[flowdeck] event bridge failed:", error)
    }
  })()

  return async () => {
    controller.abort()
    await pump
  }
}

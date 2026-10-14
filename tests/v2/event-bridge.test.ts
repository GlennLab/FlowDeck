import { describe, expect, it } from "vitest"
import { IdleCoalescer, startEventBridge, toLegacyEvent } from "@/v2/event-bridge"
import type { EventStreamSlice, LegacyBusEvent } from "@/v2/types"

function fakeEventStream(events: unknown[]): EventStreamSlice {
  return {
    subscribe: ({ signal }) => ({
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          if (signal.aborted) return
          yield event
        }
      },
    }),
  }
}

async function collect(events: unknown[], directory = "/proj"): Promise<LegacyBusEvent[]> {
  const seen: LegacyBusEvent[] = []
  const stop = await startEventBridge(
    fakeEventStream(events),
    directory,
    async ({ event }) => {
      seen.push(event)
    },
    async () => ({ location: { directory } }),
  )
  // Let the fake stream drain naturally before tearing the bridge down.
  await new Promise((resolve) => setTimeout(resolve, 25))
  await stop()
  return seen
}

describe("toLegacyEvent", () => {
  it("maps session.created data.info to properties.info", () => {
    const mapped = toLegacyEvent({ type: "session.created", data: { info: { id: "s1" } } })
    expect(mapped).toEqual({ type: "session.created", properties: { info: { id: "s1" } } })
  })

  it("synthesizes message.updated from session.usage.updated", () => {
    const mapped = toLegacyEvent({
      type: "session.usage.updated",
      data: { sessionID: "s1", usage: { input: 10, output: 5, cache: { read: 2, write: 1 } } },
    })
    expect(mapped?.type).toBe("message.updated")
    const info = (mapped?.properties as { info: Record<string, unknown> }).info
    expect(info.role).toBe("assistant")
    expect(info.sessionID).toBe("s1")
    expect(info.tokens).toEqual({ input: 10, output: 5, cache: { read: 2, write: 1 } })
  })

  it("drops usage events without token data", () => {
    expect(toLegacyEvent({ type: "session.usage.updated", data: { sessionID: "s1" } })).toBeUndefined()
  })

  it("ignores non-object payloads", () => {
    expect(toLegacyEvent("nope")).toBeUndefined()
  })
})

describe("startEventBridge", () => {
  it("delivers session.created events for the adapter location", async () => {
    const seen = await collect([
      { type: "session.created", data: { info: { id: "s1", directory: "/proj" } }, location: { directory: "/proj" } },
    ])
    expect(seen).toHaveLength(1)
    expect(seen[0].type).toBe("session.created")
  })

  it("filters events from another location", async () => {
    const seen = await collect([
      { type: "session.created", data: { info: { id: "s2" } }, location: { directory: "/other" } },
    ])
    expect(seen).toHaveLength(0)
  })

  it("resolves location through session lookup when the event has no location", async () => {
    const seen = await collect([{ type: "session.deleted", data: { sessionID: "s1" } }])
    expect(seen).toHaveLength(1)
    expect(seen[0].type).toBe("session.deleted")
  })

  it("aliases session.execution.succeeded to session.idle and coalesces repeats", async () => {
    const seen = await collect([
      { type: "session.execution.succeeded", data: { sessionID: "s1" }, location: { directory: "/proj" } },
      { type: "session.execution.succeeded", data: { sessionID: "s1" }, location: { directory: "/proj" } },
    ])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ type: "session.idle", properties: { sessionID: "s1" } })
  })
})

describe("IdleCoalescer", () => {
  it("delivers the first idle and drops repeats inside the window", () => {
    const coalescer = new IdleCoalescer(2_000)
    expect(coalescer.accept("session.idle", "s1", 1_000)).toBe(true)
    expect(coalescer.accept("session.idle", "s1", 1_500)).toBe(false)
    expect(coalescer.accept("session.idle", "s1", 3_100)).toBe(true)
  })

  it("passes non-idle events through", () => {
    const coalescer = new IdleCoalescer(2_000)
    expect(coalescer.accept("session.error", "s1", 1)).toBe(true)
  })
})

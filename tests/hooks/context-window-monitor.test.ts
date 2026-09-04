/**
 * Context Window Monitor — unit tests
 *
 * The monitor tracks assistant token usage from message.updated events and
 * appends a one-time reminder to tool output once usage crosses 70% of the
 * context limit.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest"

type MonitorHook = {
  "tool.execute.after": (input: { sessionID: string }, output: { output?: string }) => Promise<void>
  event: (args: { event: { type: string; properties?: unknown } }) => Promise<void>
}

const SESSION = "sess-ctx"
const LIMIT = 200_000

let createMonitor: () => MonitorHook
let monitor: MonitorHook

// The limit is read from FLOWDECK_CONTEXT_LIMIT at module load time, so set
// it before the first dynamic import of the module.
beforeAll(async () => {
  process.env.FLOWDECK_CONTEXT_LIMIT = String(LIMIT)
  const mod = await import("@/hooks/context-window-monitor")
  createMonitor = () => mod.createContextWindowMonitorHook() as unknown as MonitorHook
})

beforeEach(() => {
  monitor = createMonitor()
})

afterAll(() => {
  delete process.env.FLOWDECK_CONTEXT_LIMIT
})

function messageUpdated(input: number, cacheRead = 0) {
  return {
    event: {
      type: "message.updated",
      properties: {
        info: {
          role: "assistant",
          sessionID: SESSION,
          finish: true,
          tokens: { input, output: 10, cache: { read: cacheRead, write: 0 } },
        },
      },
    },
  }
}

describe("context-window-monitor", () => {
  it("appends a reminder when input + cache-read usage exceeds 70% of the limit", async () => {
    // 100k input + 50k cache read = 150k = 75% of 200k.
    await monitor.event(messageUpdated(100_000, 50_000))
    const output = { output: "tool result" }
    await monitor["tool.execute.after"]({ sessionID: SESSION }, output)
    expect(output.output).toContain("[FlowDeck Context Monitor]")
    expect(output.output).toContain("75.0% used")
  })

  it("does not append a reminder below the 70% threshold", async () => {
    await monitor.event(messageUpdated(100_000)) // 50%
    const output = { output: "tool result" }
    await monitor["tool.execute.after"]({ sessionID: SESSION }, output)
    expect(output.output).toBe("tool result")
  })

  it("reminds at most once per session", async () => {
    await monitor.event(messageUpdated(150_000))
    const first = { output: "a" }
    await monitor["tool.execute.after"]({ sessionID: SESSION }, first)
    const second = { output: "b" }
    await monitor["tool.execute.after"]({ sessionID: SESSION }, second)
    expect(first.output).toContain("[FlowDeck Context Monitor]")
    expect(second.output).toBe("b")
  })

  it("does not throw or mutate when output.output is not a string", async () => {
    await monitor.event(messageUpdated(150_000))
    const output = { output: undefined }
    let threw: unknown = null
    try {
      await monitor["tool.execute.after"]({ sessionID: SESSION }, output)
    } catch (err) {
      threw = err
    }
    expect(threw).toBeNull()
    expect(output.output).toBeUndefined()
  })

  it("resets session state on session.deleted so a later session can be reminded again", async () => {
    await monitor.event(messageUpdated(150_000))
    const before = { output: "a" }
    await monitor["tool.execute.after"]({ sessionID: SESSION }, before)
    expect(before.output).toContain("[FlowDeck Context Monitor]")

    await monitor.event({
      event: { type: "session.deleted", properties: { info: { id: SESSION } } },
    })
    // Re-report usage after the reset.
    await monitor.event(messageUpdated(150_000))

    const after = { output: "b" }
    await monitor["tool.execute.after"]({ sessionID: SESSION }, after)
    // Without the reset, the one-time reminder would be suppressed here.
    expect(after.output).toContain("[FlowDeck Context Monitor]")
  })
})

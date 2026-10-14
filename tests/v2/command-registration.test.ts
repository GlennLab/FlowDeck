import { describe, expect, it } from "vitest"
import { renderCommandTemplate, registerV2Commands } from "@/v2/command-registration"
import type { CommandDomainSlice, CommandEditorSlice, Registration } from "@/v2/types"

function fakeCommandDomain(): { domain: CommandDomainSlice; added: Array<Parameters<CommandEditorSlice["add"]>[0]> } {
  const added: Array<Parameters<CommandEditorSlice["add"]>[0]> = []
  const editor: CommandEditorSlice = { add: (def) => added.push(def) }
  const domain: CommandDomainSlice = {
    transform: async (cb) => {
      cb(editor)
      const reg: Registration = { dispose: async () => {} }
      return reg
    },
  }
  return { domain, added }
}

describe("renderCommandTemplate", () => {
  it("substitutes $ARGUMENTS with the user text", () => {
    expect(renderCommandTemplate("Task: $ARGUMENTS end", "build it")).toBe("Task: build it end")
  })

  it("substitutes every occurrence", () => {
    expect(renderCommandTemplate("$ARGUMENTS/$ARGUMENTS", "x")).toBe("x/x")
  })

  it("empty arguments leave an empty substitution", () => {
    expect(renderCommandTemplate("Input: $ARGUMENTS!", "")).toBe("Input: !")
  })
})

describe("registerV2Commands", () => {
  it("registers commands and executes templates through session prompt", async () => {
    const { domain, added } = fakeCommandDomain()
    const prompts: unknown[] = []
    await registerV2Commands(domain, { "fd-task": { description: "d", template: "run $ARGUMENTS now" } }, async (input) => {
      prompts.push(input)
    })

    expect(added).toHaveLength(1)
    expect(added[0].name).toBe("fd-task")
    expect(added[0].description).toBe("d")

    await added[0].execute({ sessionID: "s1", prompt: { text: "deploy" }, delivery: "queue" })
    expect(prompts).toEqual([{ sessionID: "s1", text: "run deploy now", delivery: "queue" }])
  })

  it("omits description when absent", async () => {
    const { domain, added } = fakeCommandDomain()
    await registerV2Commands(domain, { "fd-done": { template: "done" } }, async () => {})
    expect("description" in added[0]).toBe(false)
  })
})

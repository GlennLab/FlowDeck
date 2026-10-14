import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverSkills, parseSkillMarkdown, registerV2Skills } from "@/v2/skill-registration"
import type { Registration, SkillDomainSlice, SkillEditorSlice } from "@/v2/types"

function fixtureSkillsDir(): string {
  const root = mkdtempSync(join(tmpdir(), "fd-skills-"))
  mkdirSync(join(root, "tdd-workflow"), { recursive: true })
  writeFileSync(
    join(root, "tdd-workflow", "SKILL.md"),
    "---\nname: tdd-workflow\ndescription: Enforces TDD.\norigin: FlowDeck\n---\n\n# Body\n\nRed green refactor.\n",
    "utf-8",
  )
  mkdirSync(join(root, "no-frontmatter"), { recursive: true })
  writeFileSync(join(root, "no-frontmatter", "SKILL.md"), "# Only body\n", "utf-8")
  mkdirSync(join(root, "not-a-skill"), { recursive: true })
  return root
}

describe("parseSkillMarkdown", () => {
  it("extracts frontmatter name/description and body", () => {
    const parsed = parseSkillMarkdown(
      "---\nname: x\ndescription: Does X.\n---\n\nbody text\n",
      "fallback",
      "/p/SKILL.md",
    )
    expect(parsed).toEqual({ id: "x", name: "x", description: "Does X.", path: "/p/SKILL.md", content: "body text" })
  })

  it("falls back to the directory name without frontmatter", () => {
    const parsed = parseSkillMarkdown("# Only body\n", "no-frontmatter", "/p/SKILL.md")
    expect(parsed?.id).toBe("no-frontmatter")
    expect(parsed?.content).toBe("# Only body")
  })
})

describe("discoverSkills", () => {
  it("finds SKILL.md files in immediate subdirectories", () => {
    const skills = discoverSkills([fixtureSkillsDir()])
    const ids = skills.map((s) => s.id).sort()
    expect(ids).toEqual(["no-frontmatter", "tdd-workflow"])
  })

  it("tolerates missing directories", () => {
    expect(discoverSkills([join(tmpdir(), "does-not-exist-fd")])).toEqual([])
  })
})

describe("registerV2Skills", () => {
  it("adds every discovered skill with autoinvoke and reloads", async () => {
    const dir = fixtureSkillsDir()
    const added: Array<Parameters<SkillEditorSlice["add"]>[0]> = []
    let reloaded = 0
    const domain: SkillDomainSlice = {
      transform: async (cb) => {
        cb({ add: (skill) => added.push(skill) })
        const reg: Registration = { dispose: async () => {} }
        return reg
      },
      reload: async () => {
        reloaded += 1
      },
    }
    const count = await registerV2Skills(domain, [dir])
    expect(count).toBe(2)
    expect(added.every((s) => s.autoinvoke === true)).toBe(true)
    expect(reloaded).toBe(1)
  })
})

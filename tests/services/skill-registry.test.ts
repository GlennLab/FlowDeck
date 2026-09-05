/**
 * Skill Registry Tests
 *
 * Covers:
 * - The orchestrator is unrestricted and gets no gate block
 * - Restricted agents get exactly the skills their role needs, and nothing else
 * - `buildSkillGate()` renders the MUST NOT instruction agents self-enforce against
 * - Every non-orchestrator agent in AGENT_NAMES has a registry entry
 * - Every skill name in the registry actually exists in src/skills/
 *
 * Why the last case exists: enforcement is by prompt, so a typo'd or invented
 * skill name fails silently — the agent is simply told it may load something
 * that does not exist, and the real skill it needed is denied by omission. The
 * original spec for this registry listed `context-steward-triggers` for 11 of
 * 12 agents; no such skill has ever existed on disk.
 */

import { describe, it, expect, afterEach } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { basename, join } from "path"
import {
  SKILL_REGISTRY,
  getAllowedSkills,
  buildSkillGate,
} from "@/services/skill-registry"
import {
  collectSkillExtraPaths,
  selectExternalSkills,
} from "@/services/skill-loader"
import { AGENT_NAMES } from "@/agents/index"

const SKILLS_DIR = join(__dirname, "..", "..", "src", "skills")

/** Skill directory names present on disk. */
function skillsOnDisk(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(SKILLS_DIR, e.name, "SKILL.md")))
    .map(e => e.name)
}

describe("skill-registry", () => {
  it("orchestrator is unrestricted", () => {
    expect(getAllowedSkills("orchestrator")).toBeNull()
    expect(buildSkillGate("orchestrator")).toBe("")
  })

  it("tester only gets tdd-workflow, test-gap-detector, django-tdd, context-steward", () => {
    expect(getAllowedSkills("tester")).toEqual([
      "tdd-workflow",
      "test-gap-detector",
      "django-tdd",
      "context-steward",
    ])
  })

  it("security-auditor cannot load backend-patterns", () => {
    const skills = getAllowedSkills("security-auditor")
    expect(skills).not.toContain("backend-patterns")
    expect(skills).toContain("security-scan")
  })

  it("buildSkillGate returns MUST NOT instruction for restricted agents", () => {
    const gate = buildSkillGate("tester")
    expect(gate).toContain("MUST NOT load any skill not in this list")
    expect(gate).toContain("tdd-workflow")
    expect(gate).not.toContain("security-scan")
  })

  it("every non-orchestrator agent has an entry", () => {
    const agents = AGENT_NAMES.filter(a => a !== "orchestrator")
    expect(agents).toHaveLength(11)
    for (const a of agents) {
      expect(SKILL_REGISTRY[a], `${a} has no skill-registry entry`).toBeDefined()
      expect(getAllowedSkills(a), `${a} resolved to unrestricted`).not.toBeNull()
    }
  })

  it("unknown agents resolve to no gate rather than an empty allowlist", () => {
    expect(getAllowedSkills("no-such-agent")).toBeNull()
    expect(buildSkillGate("no-such-agent")).toBe("")
  })

  it("every skill named in the registry exists in src/skills/", () => {
    const onDisk = new Set(skillsOnDisk())
    expect(onDisk.size).toBeGreaterThan(0)

    const missing: string[] = []
    for (const [agent, entry] of Object.entries(SKILL_REGISTRY)) {
      if (entry === "*") continue
      for (const skill of entry) {
        if (!onDisk.has(skill)) missing.push(`${agent} -> ${skill}`)
      }
    }
    expect(missing).toEqual([])
  })

  it("no agent lists the same skill twice", () => {
    for (const [agent, entry] of Object.entries(SKILL_REGISTRY)) {
      if (entry === "*") continue
      expect(new Set(entry).size, `${agent} has duplicate skills`).toBe(entry.length)
    }
  })
})

/**
 * External skill registration (LE-2 R-01, R-04).
 *
 * The registry itself is prompt-side and static; path-side registration
 * happens in src/index.ts via skill-loader. These tests pin the conflict
 * rule (bundled wins by directory name) and the no-duplicate-registration
 * guarantee that index.ts relies on, so a regression there fails here.
 */
describe("external skill registration (LE-2)", () => {
  const dirs: string[] = []
  const makeDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), "flowdeck-skill-registry-test-"))
    dirs.push(d)
    return d
  }

  /** Create `<root>/<name>/SKILL.md`; omitted opts are left out of the frontmatter. */
  function makeSkill(
    root: string,
    name: string,
    opts: { name?: string; description?: string },
  ): string {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    const lines = ["---"]
    if (opts.name !== undefined) lines.push(`name: ${opts.name}`)
    if (opts.description !== undefined) lines.push(`description: ${opts.description}`)
    lines.push("---", "", `# ${name}`, "", "Body.")
    writeFileSync(join(dir, "SKILL.md"), lines.join("\n"), "utf-8")
    return dir
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("collectSkillExtraPaths merges config and env, config first, dedupes", () => {
    expect(collectSkillExtraPaths(["/a", "/b"], "/b:/c")).toEqual(["/a", "/b", "/c"])
  })

  it("collectSkillExtraPaths ignores non-string config entries and empty env segments", () => {
    expect(collectSkillExtraPaths([1, null, "/a", "  "], ":/a:")).toEqual(["/a"])
  })

  it("collectSkillExtraPaths returns [] when both sources are absent", () => {
    expect(collectSkillExtraPaths(undefined, undefined)).toEqual([])
    expect(collectSkillExtraPaths("not-an-array", "")).toEqual([])
  })

  it("adds a valid external skill dir", () => {
    const ext = makeDir()
    makeSkill(ext, "my-external-skill", { name: "my-external-skill", description: "A test skill." })

    const sel = selectExternalSkills(SKILLS_DIR, [ext])

    expect(sel.added).toEqual([join(ext, "my-external-skill")])
    expect(sel.skipped).toEqual([])
  })

  it("bundled skill wins a name conflict — external is skipped with a reason", () => {
    const ext = makeDir()
    makeSkill(ext, "tdd-workflow", { name: "tdd-workflow", description: "A test skill." })

    const sel = selectExternalSkills(SKILLS_DIR, [ext])

    expect(sel.added).toEqual([])
    expect(sel.skipped).toEqual([
      {
        dir: join(ext, "tdd-workflow"),
        name: "tdd-workflow",
        reason: "conflicts with bundled skill (bundled wins)",
      },
    ])
  })

  it("skips an external skill with an invalid manifest", () => {
    const ext = makeDir()
    makeSkill(ext, "broken-skill", { name: "broken-skill" }) // no description

    const sel = selectExternalSkills(SKILLS_DIR, [ext])

    expect(sel.added).toEqual([])
    expect(sel.skipped).toHaveLength(1)
    expect(sel.skipped[0].name).toBe("broken-skill")
    expect(sel.skipped[0].reason).toContain("manifest")
  })

  it("registers the same external skill name only once across extra paths", () => {
    const a = makeDir()
    const b = makeDir()
    makeSkill(a, "dup-skill", { name: "dup-skill", description: "A test skill." })
    makeSkill(b, "dup-skill", { name: "dup-skill", description: "A test skill." })

    const sel = selectExternalSkills(SKILLS_DIR, [a, b])

    expect(sel.added).toEqual([join(a, "dup-skill")])
    expect(sel.skipped).toHaveLength(1)
    expect(sel.skipped[0].name).toBe("dup-skill")
    expect(sel.skipped[0].reason).toContain("duplicate")
  })

  it("treats an extra root that contains SKILL.md itself as a single skill dir", () => {
    const root = makeDir()
    const skillName = basename(root)
    writeFileSync(
      join(root, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: Root skill.\n---\n\n# Root\n\nBody.\n`,
      "utf-8",
    )

    const sel = selectExternalSkills(SKILLS_DIR, [root])

    expect(sel.added).toEqual([root])
    expect(sel.skipped).toEqual([])
  })

  it("getAllowedSkills is unaffected by external loading (registry stays static)", () => {
    expect(getAllowedSkills("tester")).toEqual([
      "tdd-workflow",
      "test-gap-detector",
      "django-tdd",
      "context-steward",
    ])
    expect(SKILL_REGISTRY["tester"]).not.toContain("my-external-skill")
  })
})

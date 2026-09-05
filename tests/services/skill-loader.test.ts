/**
 * Skill Loader Tests (LE-2 Wave 1)
 *
 * Covers:
 * - resolveSkillPaths merges bundled + extra paths, dedupes, and reports
 *   missing/non-directory paths as skips instead of throwing (R-01, R-03)
 * - loadSkillManifest parses SKILL.md frontmatter and enforces required
 *   `name` + `description` and `name === directory name` (R-02)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { resolveSkillPaths, loadSkillManifest, listSkillDirs } from "@/services/skill-loader"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "flowdeck-skill-loader-test-"))
}

/** Create `<root>/<name>/SKILL.md`; omitted opts are left out of the frontmatter. */
function makeSkill(
  root: string,
  name: string,
  opts: { name?: string; description?: string } = {},
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

describe("resolveSkillPaths", () => {
  let base: string

  beforeEach(() => {
    base = makeTempDir()
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it("returns the bundled dir plus existing extra paths", () => {
    const bundled = join(base, "bundled")
    const extra = join(base, "extra")
    mkdirSync(bundled)
    mkdirSync(extra)

    const res = resolveSkillPaths({ bundledDir: bundled, extraPaths: [extra] })

    expect(res.paths).toEqual([bundled, extra])
    expect(res.skipped).toEqual([])
  })

  it("skips a missing path with a reason instead of throwing", () => {
    const bundled = join(base, "bundled")
    const missing = join(base, "nope")
    mkdirSync(bundled)

    const res = resolveSkillPaths({ bundledDir: bundled, extraPaths: [missing] })

    expect(res.paths).toEqual([bundled])
    expect(res.skipped).toEqual([{ path: missing, reason: "does not exist" }])
  })

  it("skips a path that exists but is not a directory", () => {
    const bundled = join(base, "bundled")
    const file = join(base, "file.txt")
    mkdirSync(bundled)
    writeFileSync(file, "x", "utf-8")

    const res = resolveSkillPaths({ bundledDir: bundled, extraPaths: [file] })

    expect(res.paths).toEqual([bundled])
    expect(res.skipped).toEqual([{ path: file, reason: "not a directory" }])
  })

  it("dedupes repeated paths, first occurrence wins", () => {
    const bundled = join(base, "bundled")
    const extra = join(base, "extra")
    mkdirSync(bundled)
    mkdirSync(extra)

    const res = resolveSkillPaths({ bundledDir: bundled, extraPaths: [extra, extra, bundled] })

    expect(res.paths).toEqual([bundled, extra])
    expect(res.skipped).toEqual([])
  })

  it("returns only the bundled dir for empty extraPaths", () => {
    const bundled = join(base, "bundled")
    mkdirSync(bundled)

    const res = resolveSkillPaths({ bundledDir: bundled, extraPaths: [] })

    expect(res.paths).toEqual([bundled])
    expect(res.skipped).toEqual([])
  })

  it("reports a missing bundled dir as skipped without throwing", () => {
    const res = resolveSkillPaths({ bundledDir: join(base, "missing"), extraPaths: [] })

    expect(res.paths).toEqual([])
    expect(res.skipped).toHaveLength(1)
    expect(res.skipped[0].path).toBe(join(base, "missing"))
  })
})

describe("loadSkillManifest", () => {
  let base: string

  beforeEach(() => {
    base = makeTempDir()
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it("returns name and description for a valid skill", () => {
    const dir = makeSkill(base, "my-skill", { name: "my-skill", description: "Does things." })

    expect(loadSkillManifest(dir)).toEqual({ name: "my-skill", description: "Does things." })
  })

  it("returns null when description is missing", () => {
    const dir = makeSkill(base, "my-skill", { name: "my-skill" })

    expect(loadSkillManifest(dir)).toBeNull()
  })

  it("returns null when name is missing", () => {
    const dir = makeSkill(base, "my-skill", { description: "Does things." })

    expect(loadSkillManifest(dir)).toBeNull()
  })

  it("returns null when name does not match the directory name", () => {
    const dir = makeSkill(base, "my-skill", { name: "other-name", description: "Does things." })

    expect(loadSkillManifest(dir)).toBeNull()
  })

  it("returns null when SKILL.md is missing", () => {
    const dir = join(base, "empty-skill")
    mkdirSync(dir)

    expect(loadSkillManifest(dir)).toBeNull()
  })

  it("returns null when SKILL.md has no frontmatter", () => {
    const dir = join(base, "no-fm")
    mkdirSync(dir)
    writeFileSync(join(dir, "SKILL.md"), "# Just a heading\n", "utf-8")

    expect(loadSkillManifest(dir)).toBeNull()
  })

  it("returns null when SKILL.md exceeds the 1 MiB size cap", () => {
    const dir = join(base, "huge-skill")
    mkdirSync(dir)
    const pad = "x".repeat(1024 * 1024) // pushes the file just over 1 MiB
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: huge-skill\ndescription: Huge.\n---\n\n# H\n\n${pad}\n`,
      "utf-8",
    )

    expect(loadSkillManifest(dir)).toBeNull()
  })

  it("parses a valid SKILL.md just under the size cap", () => {
    const dir = join(base, "big-skill")
    mkdirSync(dir)
    const pad = "x".repeat(1024 * 1024 - 64)
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: big-skill\ndescription: Big.\n---\n\n# B\n\n${pad}\n`,
      "utf-8",
    )

    expect(loadSkillManifest(dir)).toEqual({ name: "big-skill", description: "Big." })
  })
})

describe("listSkillDirs", () => {
  let base: string

  beforeEach(() => {
    base = makeTempDir()
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it("finds nested skill dirs and does not descend into skill dirs", () => {
    const root = join(base, "root")
    makeSkill(root, "top-skill", { name: "top-skill", description: "Top." })
    const nestedDir = join(root, "group", "nested-skill")
    mkdirSync(nestedDir, { recursive: true })
    writeFileSync(
      join(nestedDir, "SKILL.md"),
      "---\nname: nested-skill\ndescription: Nested.\n---\n\n# N\n\nBody.\n",
      "utf-8",
    )
    mkdirSync(join(root, "plain-dir")) // no SKILL.md -> not a skill dir

    const listing = listSkillDirs(root)

    expect(listing.dirs.sort()).toEqual([join(root, "top-skill"), nestedDir].sort())
    expect(listing.skipped).toEqual([])
  })

  it("returns an empty listing for a missing root", () => {
    expect(listSkillDirs(join(base, "nope"))).toEqual({ dirs: [], skipped: [] })
  })

  it("stops the walk at the entry cap and reports a skip reason", () => {
    const root = join(base, "big")
    mkdirSync(root)
    // 1001 plain subdirs: the 1001st entry exceeds the 1000-entry cap, so
    // the walk must stop before descending into anything (deterministic
    // regardless of readdir order).
    for (let i = 0; i <= 1000; i += 1) mkdirSync(join(root, `d${i}`))

    const listing = listSkillDirs(root)

    expect(listing.dirs).toEqual([])
    expect(listing.skipped).toHaveLength(1)
    expect(listing.skipped[0].path).toBe(root)
    expect(listing.skipped[0].reason).toContain("1000")
  })

  it("reports symlinked entries as skipped and never follows them", () => {
    const root = join(base, "root")
    const target = join(base, "target")
    makeSkill(target, "linked-skill", { name: "linked-skill", description: "Linked." })
    mkdirSync(root)
    symlinkSync(target, join(root, "link"))

    const listing = listSkillDirs(root)

    expect(listing.dirs).toEqual([])
    expect(listing.skipped).toEqual([{ path: join(root, "link"), reason: "symlink not followed" }])
  })
})

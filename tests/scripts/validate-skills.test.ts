/**
 * validate-skills.mjs Tests (LE-2 fix round, R-05)
 *
 * The script runs at import time, so tests spawn it as a child process with
 * an isolated cwd (fake project root) and HOME (fake global OpenCode config).
 * Covers:
 * - an empty project passes
 * - skills.extraPaths in the GLOBAL ~/.config/opencode/opencode.json are
 *   validated (M3: the validator must read the same sources as the plugin's
 *   merged config)
 * - an invalid skill in a global-config extra path fails the run
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { spawnSync } from "child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const SCRIPT = join(__dirname, "..", "..", "scripts", "validate-skills.mjs")

function writeValidSkill(root: string, name: string): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: A test skill.\norigin: test\n---\n\n# ${name}\n\n## Work\n\nBody.\n`,
    "utf-8",
  )
}

function writeInvalidSkill(root: string, name: string): void {
  // Missing the required `origin` key -> CI failure.
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: A test skill.\n---\n\n# ${name}\n\n## Work\n\nBody.\n`,
    "utf-8",
  )
}

function writeGlobalConfig(home: string, extraPaths: string[]): void {
  const dir = join(home, ".config", "opencode")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({ skills: { extraPaths } }),
    "utf-8",
  )
}

function runValidator(cwd: string, home: string): { status: number | null; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  delete env.FLOWDECK_SKILLS_PATH
  const res = spawnSync(process.execPath, [SCRIPT], { cwd, env, encoding: "utf-8" })
  return { status: res.status, stderr: res.stderr }
}

describe("validate-skills (spawned)", () => {
  let project: string
  let home: string

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "flowdeck-validate-skills-proj-"))
    home = mkdtempSync(join(tmpdir(), "flowdeck-validate-skills-home-"))
    mkdirSync(join(project, "src", "skills"), { recursive: true })
  })

  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it("passes on an empty project", () => {
    const { status } = runValidator(project, home)

    expect(status).toBe(0)
  })

  it("validates skills.extraPaths from the global OpenCode config (M3)", () => {
    const ext = join(project, "external-skills")
    writeValidSkill(ext, "global-extra")
    writeGlobalConfig(home, [ext])

    const { status } = runValidator(project, home)

    expect(status).toBe(0)
  })

  it("fails when a global-config extra path contains an invalid skill", () => {
    const ext = join(project, "external-skills")
    writeInvalidSkill(ext, "global-bad")
    writeGlobalConfig(home, [ext])

    const { status, stderr } = runValidator(project, home)

    expect(status).toBe(1)
    expect(stderr).toContain('missing frontmatter key "origin"')
  })
})

/**
 * skill-install.mjs Tests (LE-2 Wave 3, R-06)
 *
 * The git clone is injected (no network in tests): the fake clone writes
 * the fixture content the real clone would have produced. Covers:
 * - arg parsing (url, --dest, bad usage)
 * - repo name derivation and default dest
 * - manifest validation (valid, missing description, name mismatch, empty clone)
 * - validation failure -> dest removed, no residue
 * - clone failure -> dest removed, no residue (incl. parent dir the script created)
 * - successful install -> dest remains
 * - existing dest -> refused, left untouched
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  parseArgs,
  repoNameFromUrl,
  defaultDest,
  validateSkillDir,
  validateClone,
  installSkill,
} from "../../scripts/skill-install.mjs"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "flowdeck-skill-install-test-"))
}

function writeValidSkill(root: string, name: string): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: A test skill.\n---\n\n# ${name}\n\n## Work\n\nBody.\n`,
    "utf-8",
  )
}

function writeInvalidSkill(root: string, name: string): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  // Frontmatter without a description -> invalid manifest.
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\n---\n\n# ${name}\n\n## Work\n\nBody.\n`,
    "utf-8",
  )
}

describe("parseArgs", () => {
  it("parses url and --dest", () => {
    expect(parseArgs(["https://example.com/x/y.git", "--dest", "/tmp/foo"])).toEqual({
      url: "https://example.com/x/y.git",
      dest: "/tmp/foo",
    })
  })

  it("parses url without --dest", () => {
    expect(parseArgs(["https://example.com/x/y.git"])).toEqual({
      url: "https://example.com/x/y.git",
      dest: null,
    })
  })

  it("throws when url is missing", () => {
    expect(() => parseArgs([])).toThrow(/usage/)
  })

  it("throws on --dest without a value", () => {
    expect(() => parseArgs(["https://x", "--dest"])).toThrow(/--dest requires a value/)
  })

  it("throws on unknown options and extra positionals", () => {
    expect(() => parseArgs(["https://x", "--bogus"])).toThrow(/unknown option/)
    expect(() => parseArgs(["https://x", "https://y"])).toThrow(/unexpected argument/)
  })

  it("accepts https, http, ssh, file, and scp-like git@ URLs", () => {
    expect(parseArgs(["https://github.com/org/repo.git"]).url).toBe("https://github.com/org/repo.git")
    expect(parseArgs(["http://git.example.com/org/repo.git"]).url).toBe("http://git.example.com/org/repo.git")
    expect(parseArgs(["ssh://git.example.com/org/repo.git"]).url).toBe("ssh://git.example.com/org/repo.git")
    expect(parseArgs(["file:///srv/git/repo.git"]).url).toBe("file:///srv/git/repo.git")
    expect(parseArgs(["git@github.com:org/repo.git"]).url).toBe("git@github.com:org/repo.git")
  })

  it("rejects URLs with unsupported schemes", () => {
    expect(() => parseArgs(["ftp://example.com/repo.git"])).toThrow(/invalid git URL/)
    expect(() => parseArgs(["example.com/repo.git"])).toThrow(/invalid git URL/)
  })

  it("rejects --dest values that start with a dash", () => {
    expect(() => parseArgs(["https://example.com/x/y.git", "--dest", "-bad"])).toThrow(
      /--dest must be a directory path/,
    )
  })
})

describe("repoNameFromUrl / defaultDest", () => {
  it("derives the repo name from https and ssh URLs", () => {
    expect(repoNameFromUrl("https://github.com/org/repo.git")).toBe("repo")
    expect(repoNameFromUrl("https://github.com/org/repo")).toBe("repo")
    expect(repoNameFromUrl("git@github.com:org/repo.git")).toBe("repo")
  })

  it("defaults dest to ./skills-external/<repo-name>", () => {
    expect(defaultDest("https://github.com/org/repo.git")).toBe(join("skills-external", "repo"))
  })
})

describe("validateSkillDir / validateClone", () => {
  let base: string

  beforeEach(() => {
    base = makeTempDir()
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it("accepts a valid skill dir", () => {
    writeValidSkill(base, "good-skill")

    expect(validateSkillDir(join(base, "good-skill"))).toEqual({ ok: true, name: "good-skill" })
  })

  it("rejects a skill dir missing description", () => {
    writeInvalidSkill(base, "bad-skill")

    expect(validateSkillDir(join(base, "bad-skill")).ok).toBe(false)
  })

  it("rejects a name/dir mismatch", () => {
    const dir = join(base, "mismatch")
    mkdirSync(dir)
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: other\ndescription: x.\n---\n\n# M\n\n## W\n\nB.\n",
      "utf-8",
    )

    const v = validateSkillDir(dir)
    expect(v.ok).toBe(false)
    expect(v).toMatchObject({ reason: expect.stringContaining("does not match") })
  })

  it("validateClone reports a clone without any SKILL.md", () => {
    expect(validateClone(base)).toEqual(["no SKILL.md found in clone"])
  })
})

describe("installSkill", () => {
  let base: string

  beforeEach(() => {
    base = makeTempDir()
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it("keeps dest on a successful install", () => {
    const dest = join(base, "ok-repo")
    const clone = (_url: string, d: string) => {
      writeValidSkill(d, "ok-skill")
      return { ok: true }
    }

    const result = installSkill("https://example.com/x/ok-repo.git", dest, { clone })

    expect(result).toBe(dest)
    expect(existsSync(dest)).toBe(true)
  })

  it("removes dest when validation fails (no residue)", () => {
    const dest = join(base, "bad-repo")
    const clone = (_url: string, d: string) => {
      writeInvalidSkill(d, "bad-skill")
      return { ok: true }
    }

    expect(() => installSkill("https://example.com/x/bad-repo.git", dest, { clone })).toThrow(
      /validation failed/,
    )
    expect(existsSync(dest)).toBe(false)
  })

  it("removes dest when the clone fails (no residue)", () => {
    const dest = join(base, "fail-repo")
    const clone = (_url: string, d: string) => {
      mkdirSync(d, { recursive: true }) // simulate partial clone residue
      return { ok: false, error: "fatal: repository not found" }
    }

    expect(() => installSkill("https://example.com/x/fail-repo.git", dest, { clone })).toThrow(
      /git clone failed/,
    )
    expect(existsSync(dest)).toBe(false)
  })

  it("removes the parent dir it created itself", () => {
    const parent = join(base, "new-parent")
    const dest = join(parent, "fail-repo")
    const clone = (_url: string, _d: string) => ({ ok: false, error: "boom" })

    expect(() => installSkill("https://example.com/x/fail-repo.git", dest, { clone })).toThrow(
      /git clone failed/,
    )
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(parent)).toBe(false)
  })

  it("refuses to overwrite an existing dest and leaves it untouched", () => {
    const dest = join(base, "exists")
    mkdirSync(dest)
    writeFileSync(join(dest, "keep.txt"), "keep", "utf-8")
    const clone = (_url: string, _d: string) => ({ ok: true })

    expect(() => installSkill("https://example.com/x/exists.git", dest, { clone })).toThrow(
      /already exists/,
    )
    expect(existsSync(join(dest, "keep.txt"))).toBe(true)
  })

  it("appends the cleanup error to the thrown message when removing dest fails", () => {
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("EACCES: permission denied, rm")
    })
    try {
      const dest = join(base, "cleanup-fail")
      const clone = (_url: string, _d: string) => ({ ok: false, error: "boom" })

      expect(() => installSkill("https://example.com/x/cleanup-fail.git", dest, { clone })).toThrow(
        /git clone failed: boom.*cleanup.*EACCES/,
      )
    } finally {
      rmSpy.mockRestore()
    }
  })
})

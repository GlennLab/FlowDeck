#!/usr/bin/env node
/**
 * skill-install — install an external skill from a git URL (LE-2 R-06).
 *
 *   node scripts/skill-install.mjs <git-url> [--dest <dir>]
 *
 * Shallow-clones the repo into <dest> (default: ./skills-external/<repo-name>
 * under the cwd), then validates the skill manifest(s) in the clone with the
 * same rules as the plugin loader and scripts/validate-skills.mjs frontmatter
 * checks: required `name` + `description`, and `name` equal to the directory
 * name. On ANY failure (clone or validation) the script removes the dest
 * directory and any parent dirs it created itself, leaving no residue.
 *
 * v1 scope: no auto-update, no version resolver. See docs/skills/index.md.
 * Pure helpers (parseArgs, repoNameFromUrl, defaultDest, validateSkillDir,
 * validateClone, installSkill) are exported for unit tests; installSkill
 * accepts an injectable `clone` so tests never touch the network.
 */
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync } from "fs"
import { basename, dirname, join } from "path"
import { pathToFileURL } from "url"

/** Same frontmatter pattern as scripts/validate-skills.mjs (LF line endings). */
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n/

/** Accepted git URL forms: https/http/ssh/file URLs and scp-like git@host:path. */
const GIT_URL_PATTERN = /^(?:https?:\/\/\S+|ssh:\/\/\S+|file:\/\/\S+|git@[^:\s]+:\S+)$/

/** Parse CLI args: <git-url> [--dest <dir>]. Throws on bad usage. */
export function parseArgs(argv) {
  let url = null
  let dest = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--dest") {
      i += 1
      if (i >= argv.length) throw new Error("--dest requires a value")
      dest = argv[i]
      if (dest.startsWith("-")) {
        throw new Error(`--dest must be a directory path, not an option: ${dest}`)
      }
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`)
    } else if (url === null) {
      url = arg
    } else {
      throw new Error(`unexpected argument: ${arg}`)
    }
  }
  if (!url) throw new Error("usage: skill-install <git-url> [--dest <dir>]")
  if (!GIT_URL_PATTERN.test(url)) {
    throw new Error(`invalid git URL (expected https://, http://, ssh://, file://, or git@host:path): ${url}`)
  }
  return { url, dest }
}

/** Derive a directory name from a git URL (https or ssh form, with/without .git). */
export function repoNameFromUrl(url) {
  const cleaned = url.replace(/\.git$/, "")
  const last = cleaned.split(/[/:]/).filter(Boolean).pop()
  if (!last) throw new Error(`cannot derive a directory name from URL: ${url}`)
  return last
}

/** Default install location: ./skills-external/<repo-name> under the cwd. */
export function defaultDest(url) {
  return join("skills-external", repoNameFromUrl(url))
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Directories containing a SKILL.md under root (recursive walk; a directory
 * that is itself a skill dir is not descended into). Mirrors the plugin's
 * skill discovery. Never throws.
 */
export function findSkillDirs(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      out.push(dir)
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name))
    }
  }
  if (isDirectory(root)) walk(root)
  return out
}

/**
 * Validate one skill dir. Returns { ok: true, name } or { ok: false, reason }.
 */
export function validateSkillDir(dir) {
  const skillFile = join(dir, "SKILL.md")
  if (!existsSync(skillFile)) return { ok: false, reason: "missing SKILL.md" }
  let raw
  try {
    raw = readFileSync(skillFile, "utf-8")
  } catch (err) {
    return { ok: false, reason: `unreadable SKILL.md: ${err.message}` }
  }
  const fm = raw.match(FRONTMATTER_PATTERN)
  if (!fm) return { ok: false, reason: "missing YAML frontmatter" }
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim()
  if (!name) return { ok: false, reason: 'missing frontmatter key "name"' }
  if (!description) return { ok: false, reason: 'missing frontmatter key "description"' }
  if (name !== basename(dir)) {
    return { ok: false, reason: `name "${name}" does not match directory name "${basename(dir)}"` }
  }
  return { ok: true, name }
}

/** Validate every skill dir found in the clone. Returns problems (empty = valid). */
export function validateClone(dest) {
  const dirs = findSkillDirs(dest)
  if (dirs.length === 0) return ["no SKILL.md found in clone"]
  const problems = []
  for (const dir of dirs) {
    const v = validateSkillDir(dir)
    if (!v.ok) problems.push(`${dir}: ${v.reason}`)
  }
  return problems
}

function defaultClone(url, dest) {
  const res = spawnSync("git", ["clone", "--depth", "1", url, dest], { encoding: "utf-8" })
  if (res.status === 0) return { ok: true }
  return { ok: false, error: (res.stderr || res.stdout || `git clone exited ${res.status}`).trim() }
}

/**
 * Clone <url> into <dest> and validate the result. On any failure the dest
 * directory (and any parent dirs this call created) are removed. Refuses to
 * touch a dest that already exists. Throws on failure; returns dest on
 * success.
 */
export function installSkill(url, dest, { clone = defaultClone } = {}) {
  if (existsSync(dest)) throw new Error(`dest already exists: ${dest} (refusing to overwrite)`)

  const parent = dirname(dest)
  const createdParent = !existsSync(parent)
  if (createdParent) {
    try {
      mkdirSync(parent, { recursive: true })
    } catch (err) {
      throw new Error(`cannot create dest parent ${parent}: ${err.message}`)
    }
  }

  const fail = (message) => {
    let cleanupError = null
    try {
      rmSync(dest, { recursive: true, force: true })
    } catch (err) {
      cleanupError = err
    }
    if (createdParent) {
      try {
        rmdirSync(parent)
      } catch {
        /* leave non-empty parents in place */
      }
    }
    if (cleanupError) {
      throw new Error(`${message} (cleanup of ${dest} also failed: ${cleanupError.message})`)
    }
    throw new Error(message)
  }

  const result = clone(url, dest)
  if (!result.ok) fail(`git clone failed: ${result.error}`)

  const problems = validateClone(dest)
  if (problems.length > 0) fail(`skill validation failed:\n- ${problems.join("\n- ")}`)

  return dest
}

// CLI entry point (skipped when imported by tests).
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    const { url, dest } = parseArgs(process.argv.slice(2))
    const finalDest = dest ?? defaultDest(url)
    const installed = installSkill(url, finalDest)
    console.log(`Installed skill(s) into ${installed}`)
    console.log("Add the destination (or its parent) to skills.extraPaths or FLOWDECK_SKILLS_PATH to load them.")
  } catch (err) {
    console.error(`skill-install: ${err.message}`)
    process.exit(1)
  }
}

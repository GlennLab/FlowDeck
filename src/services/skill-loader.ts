/**
 * External skill loading (LE-2).
 *
 * Resolves extra skill paths and validates skill manifests. Every function
 * here is side-effect free and never throws: missing or invalid skills are
 * reported in the return value so that plugin load is never blocked (R-03).
 * The caller logs the skip reasons and decides what to register.
 */
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "fs"
import { basename, join } from "path"

export interface SkillManifest {
  name: string
  description: string
}

export interface SkippedPath {
  path: string
  reason: string
}

export interface SkillPathResolution {
  /** Existing directories, bundled first. */
  paths: string[]
  /** Entries that could not be used, with the reason. */
  skipped: SkippedPath[]
}

export interface SkippedSkill {
  dir: string
  name: string
  reason: string
}

export interface SkillSelection {
  /** Skill dirs that may be added to cfg.skills.paths (valid, no conflicts). */
  added: string[]
  /** Rejected skill dirs, with the reason (caller logs these). */
  skipped: SkippedSkill[]
}

/** Same frontmatter pattern as scripts/validate-skills.mjs (LF line endings). */
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n/

/** Max entries visited per root while walking for skill dirs (M1). */
const MAX_SKILL_DIR_ENTRIES = 1000

/** SKILL.md size cap: larger files are skipped, never read (M2). */
const MAX_SKILL_MANIFEST_BYTES = 1024 * 1024 // 1 MiB

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Merge the bundled skills dir with extra paths (config + env). Entries are
 * deduped (first occurrence wins); missing or non-directory entries go to
 * `skipped` with a reason. Never throws.
 */
export function resolveSkillPaths(opts: {
  bundledDir: string
  extraPaths: string[]
}): SkillPathResolution {
  const paths: string[] = []
  const skipped: SkippedPath[] = []
  const seen = new Set<string>()

  for (const p of [opts.bundledDir, ...opts.extraPaths]) {
    if (seen.has(p)) continue
    seen.add(p)
    if (!isDirectory(p)) {
      skipped.push({ path: p, reason: existsSync(p) ? "not a directory" : "does not exist" })
      continue
    }
    paths.push(p)
  }
  return { paths, skipped }
}

/**
 * Parse `<skillDir>/SKILL.md` frontmatter. Returns null when the file is
 * missing, exceeds MAX_SKILL_MANIFEST_BYTES (M2), has no frontmatter, `name`
 * or `description` is absent, or `name` does not equal the directory name
 * (R-02).
 */
export function loadSkillManifest(skillDir: string): SkillManifest | null {
  const skillFile = join(skillDir, "SKILL.md")
  let size: number
  try {
    size = statSync(skillFile).size
  } catch {
    return null
  }
  if (size > MAX_SKILL_MANIFEST_BYTES) return null

  let raw: string
  try {
    raw = readFileSync(skillFile, "utf-8")
  } catch {
    return null
  }

  const fm = raw.match(FRONTMATTER_PATTERN)
  if (!fm) return null

  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim()
  if (!name || !description) return null
  if (name !== basename(skillDir)) return null
  return { name, description }
}

/**
 * Collect extra skill paths from OpenCode config (`cfg.skills.extraPaths`)
 * and the FLOWDECK_SKILLS_PATH env var (colon-separated). Config entries
 * come first; duplicates are dropped (first occurrence wins). Non-string
 * entries are ignored — cfg.skills is loosely typed, so anything may
 * arrive here.
 */
export function collectSkillExtraPaths(
  configValue: unknown,
  envValue: string | undefined,
): string[] {
  const fromConfig: string[] = []
  if (Array.isArray(configValue)) {
    for (const entry of configValue) {
      if (typeof entry === "string" && entry.trim() !== "") fromConfig.push(entry.trim())
    }
  }
  const fromEnv: string[] = []
  if (typeof envValue === "string") {
    for (const entry of envValue.split(":")) {
      if (entry.trim() !== "") fromEnv.push(entry.trim())
    }
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of [...fromConfig, ...fromEnv]) {
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

export interface SkillDirListing {
  /** Skill directories found under the root. */
  dirs: string[]
  /** Entries skipped during the walk (symlinks, entry cap), with reasons. */
  skipped: SkippedPath[]
}

/**
 * Skill directories under `root`: every directory that contains a SKILL.md,
 * found by walking the tree (mirrors OpenCode's recursive SKILL.md glob
 * scan). A directory that is itself a skill dir is not descended into.
 * The walk visits at most MAX_SKILL_DIR_ENTRIES entries per root; when the
 * cap is hit it stops and reports a skip reason (M1). Symlinked entries are
 * reported, never followed (L4). Missing or unreadable roots yield empty
 * results. Never throws.
 */
export function listSkillDirs(root: string): SkillDirListing {
  const listing: SkillDirListing = { dirs: [], skipped: [] }
  let visited = 0
  let capped = false
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some(e => e.isFile() && e.name === "SKILL.md")) {
      listing.dirs.push(dir)
      return
    }
    for (const e of entries) {
      if (capped) return
      visited += 1
      if (visited > MAX_SKILL_DIR_ENTRIES) {
        capped = true
        listing.skipped.push({
          path: root,
          reason: `walk stopped at ${MAX_SKILL_DIR_ENTRIES} entries; skills past the cap were not registered`,
        })
        return
      }
      if (e.isSymbolicLink()) {
        listing.skipped.push({ path: join(dir, e.name), reason: "symlink not followed" })
        continue
      }
      if (e.isDirectory()) walk(join(dir, e.name))
    }
  }
  if (isDirectory(root)) walk(root)
  return listing
}

/**
 * Pick which external skill dirs may be registered: valid manifest, no name
 * conflict with a bundled skill (bundled wins, R-04), no duplicate name
 * across extra paths (first wins). Never throws.
 */
export function selectExternalSkills(
  bundledDir: string,
  extraRoots: string[],
): SkillSelection {
  const bundledNames = new Set(listSkillDirs(bundledDir).dirs.map(d => basename(d)))
  const added = new Set<string>()
  const selection: SkillSelection = { added: [], skipped: [] }

  for (const root of extraRoots) {
    const listing = listSkillDirs(root)
    for (const s of listing.skipped) {
      selection.skipped.push({ dir: s.path, name: basename(s.path), reason: s.reason })
    }
    for (const dir of listing.dirs) {
      const name = basename(dir)
      if (!loadSkillManifest(dir)) {
        selection.skipped.push({ dir, name, reason: "invalid or missing SKILL.md manifest" })
        continue
      }
      if (bundledNames.has(name)) {
        selection.skipped.push({ dir, name, reason: "conflicts with bundled skill (bundled wins)" })
        continue
      }
      if (added.has(name)) {
        selection.skipped.push({ dir, name, reason: "duplicate skill name across extra paths" })
        continue
      }
      added.add(name)
      selection.added.push(dir)
    }
  }
  return selection
}

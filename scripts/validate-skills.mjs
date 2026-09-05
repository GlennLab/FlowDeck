import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { homedir } from "os"
import { join } from "path"

const root = process.cwd()
const skillsDir = join(root, "src", "skills")

// External skill paths (LE-2 R-05): same sources as the plugin —
// `skills.extraPaths` in OpenCode's merged config (repo-root opencode.json,
// .opencode/opencode.json, or the global ~/.config/opencode/opencode.json)
// and the FLOWDECK_SKILLS_PATH env var (colon-separated). The existing checks
// below run unchanged over these paths too; missing paths are warned, not fatal.
function readConfigExtraPaths() {
  const out = []
  const candidates = [
    join(root, "opencode.json"),
    join(root, ".opencode", "opencode.json"),
    join(homedir(), ".config", "opencode", "opencode.json"),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const cfg = JSON.parse(readFileSync(candidate, "utf-8"))
      const extra = cfg && cfg.skills && cfg.skills.extraPaths
      if (Array.isArray(extra)) {
        for (const p of extra) {
          if (typeof p === "string" && p.trim() !== "") out.push(p.trim())
        }
      }
    } catch (err) {
      console.warn(`Warning: ignoring ${candidate} for skills.extraPaths: ${err.message}`)
    }
  }
  return out
}

function readEnvExtraPaths() {
  const raw = process.env.FLOWDECK_SKILLS_PATH
  if (typeof raw !== "string" || raw.trim() === "") return []
  return raw.split(":").map(p => p.trim()).filter(p => p !== "")
}

/** True when `p` exists and is a directory; stat errors (e.g. a path that
 *  vanishes mid-run) are treated as not-found rather than thrown. */
function isExistingDir(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

const extraPaths = [...new Set([...readConfigExtraPaths(), ...readEnvExtraPaths()])]
const skillRoots = [skillsDir, ...extraPaths.filter(p => {
  const ok = isExistingDir(p)
  if (!ok) console.warn(`Warning: external skill path not found, skipping: ${p}`)
  return ok
})]

const requiredFrontmatterKeys = ["name", "description", "origin"]
const sectionPattern = /^##\s+/m
// Description word-count budget: warn at WARN, fail at FAIL.
const DESCRIPTION_WARN_WORDS = 22
const DESCRIPTION_FAIL_WORDS = 30
// SKILL.md body line-count budget: warn at WARN, fail at FAIL.
// Tuned above the current maximum legitimate reference skill (~535 lines for
// python-patterns) so the gate catches future bloat without blocking the
// existing reference set.
const BODY_WARN_LINES = 500
const BODY_FAIL_LINES = 600

function countWords(s) {
  return s.trim().split(/\s+/).filter(Boolean).length
}

function collectSkillFiles(dir) {
  const entries = readdirSync(dir)
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      files.push(...collectSkillFiles(full))
      continue
    }
    if (entry === "SKILL.md") files.push(full)
  }
  return files
}

const failures = []
const warnings = []

for (const skillRoot of skillRoots) {
  for (const file of collectSkillFiles(skillRoot)) {
    const raw = readFileSync(file, "utf-8")
    const rel = file.replace(`${root}/`, "")
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/)
    if (!fmMatch) {
      failures.push(`${rel}: missing YAML frontmatter`)
      continue
    }

    const frontmatter = fmMatch[1]
    for (const key of requiredFrontmatterKeys) {
      if (!new RegExp(`^${key}:\\s*.+$`, "m").test(frontmatter)) {
        failures.push(`${rel}: missing frontmatter key "${key}"`)
      }
    }

    if (!sectionPattern.test(raw)) {
      failures.push(`${rel}: missing markdown sections (expected at least one level-2 heading)`)
    }

    // Token-budget gate: description word count.
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m)
    if (descMatch) {
      const words = countWords(descMatch[1])
      if (words > DESCRIPTION_FAIL_WORDS) {
        failures.push(`${rel}: description has ${words} words (max ${DESCRIPTION_FAIL_WORDS})`)
      } else if (words > DESCRIPTION_WARN_WORDS) {
        warnings.push(`${rel}: description has ${words} words (target ≤${DESCRIPTION_WARN_WORDS})`)
      }
    }

    // Token-budget gate: SKILL.md body line count.
    const lines = raw.split("\n").length
    if (lines > BODY_FAIL_LINES) {
      failures.push(`${rel}: SKILL.md has ${lines} lines (max ${BODY_FAIL_LINES})`)
    } else if (lines > BODY_WARN_LINES) {
      warnings.push(`${rel}: SKILL.md has ${lines} lines (target ≤${BODY_WARN_LINES})`)
    }
  }
}

if (warnings.length > 0) {
  console.warn("Skill validation warnings:")
  for (const w of warnings) console.warn(`- ${w}`)
}

if (failures.length > 0) {
  console.error("Skill validation failed:")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log("Skill validation passed.")

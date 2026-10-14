/**
 * V2 skill registration.
 *
 * V1 pushed skill directories into cfg.skills.paths and let the host
 * discover them. V2 plugins register skills explicitly through
 * ctx.skill.transform, so the adapter parses each <dir>/<name>/SKILL.md,
 * extracts the frontmatter name/description, and adds the body as content.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { SkillDomainSlice } from "./types"

export interface ParsedSkill {
  id: string
  name: string
  description?: string
  path: string
  content: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export function parseSkillMarkdown(raw: string, fallbackId: string, path: string): ParsedSkill | undefined {
  const match = raw.match(FRONTMATTER_RE)
  const frontmatter = match ? match[1] : ""
  const body = (match ? match[2] : raw).trim()
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? fallbackId
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  if (!body) return undefined
  return { id: name, name, ...(description ? { description } : {}), path, content: body }
}

/** Parse every DIR/NAME/SKILL.md under the given directories into registerable skills. */
export function discoverSkills(dirs: string[]): ParsedSkill[] {
  const skills: ParsedSkill[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const skillFile = join(dir, entry, "SKILL.md")
      if (!existsSync(skillFile)) continue
      let raw: string
      try {
        raw = readFileSync(skillFile, "utf-8")
      } catch {
        continue
      }
      const skill = parseSkillMarkdown(raw, entry, skillFile)
      if (!skill || seen.has(skill.id)) continue
      seen.add(skill.id)
      skills.push(skill)
    }
  }
  return skills
}

export async function registerV2Skills(domain: SkillDomainSlice, dirs: string[]): Promise<number> {
  const skills = discoverSkills(dirs)
  if (skills.length === 0) return 0
  await domain.transform((editor) => {
    for (const skill of skills) {
      editor.add({ ...skill, autoinvoke: true })
    }
  })
  await domain.reload()
  return skills.length
}

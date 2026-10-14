/**
 * Resolve the OpenCode config directory and read the user's own
 * opencode.json(c) — used by the V2 adapter to honor FlowDeck's V1 rule of
 * "only set default_agent when the user has not" and to pick up
 * skills.extraPaths the way the V1 config hook did.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function resolveOpencodeConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(xdg, "opencode")
}

/** Parse opencode.json/jsonc best-effort; returns {} when unreadable. */
export function readUserConfig(configDir: string): Record<string, unknown> {
  for (const file of ["opencode.json", "opencode.jsonc"]) {
    const path = join(configDir, file)
    if (!existsSync(path)) continue
    try {
      const raw = readFileSync(path, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Malformed user config is not the adapter's problem to fix.
    }
  }
  return {}
}

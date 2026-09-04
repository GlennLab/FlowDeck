/**
 * Shared FlowDeck message helpers.
 *
 * D1 error grammar: guard/gate errors are emitted as
 * `FLOWDECK [gate-name]: message` so guard output is scannable.
 */

import { homedir } from "os"

/**
 * Format a guard/gate error with the canonical D1 prefix.
 * e.g. flowdeckError("write-limit", "Write limit reached") →
 * "FLOWDECK [write-limit]: Write limit reached"
 */
export function flowdeckError(gate: string, message: string): string {
  return `FLOWDECK [${gate}]: ${message}`
}

const MAX_SANITIZED_ERROR_LENGTH = 200

/**
 * Sanitize error text before it reaches a sensitive sink (project-local
 * JSONL log, OS notification). Strips URL userinfo, Bearer/Basic tokens, and
 * key=value credential patterns; caps the result at 200 characters.
 */
export function sanitizeErrorText(text: string): string {
  let s = text
  // scheme://user:pass@host → scheme://***@host
  s = s.replace(/(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@\s/]+@/g, "$1***@")
  // Bearer <token> → Bearer ***
  s = s.replace(/\bBearer\s+\S+/gi, "Bearer ***")
  // Basic <base64> → Basic *** (runs before the key=value pass, which would
  // mask only the word "Basic" and leave the base64 behind)
  s = s.replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic ***")
  // key=value / key: value credential patterns (value only)
  const credKey =
    "(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|pwd|authorization|credential|private[_-]?key)"
  s = s.replace(new RegExp(`\\b(${credKey}\\s*[=:]\\s*)\\S+`, "gi"), "$1***")
  if (s.length > MAX_SANITIZED_ERROR_LENGTH) {
    s = s.slice(0, MAX_SANITIZED_ERROR_LENGTH)
  }
  return s
}

/**
 * Mask an absolute home-directory path to `~/...` form for tool output
 * (avoids leaking the user's home path into agent-visible output).
 * Paths outside the home directory are returned unchanged.
 */
export function maskHomePath(p: string): string {
  const home = homedir()
  if (home && (p === home || p.startsWith(home + "/"))) {
    return "~" + p.slice(home.length)
  }
  return p
}

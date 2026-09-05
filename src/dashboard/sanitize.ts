/**
 * Dashboard Sanitizer
 *
 * Default-deny gate between the data layer and the HTTP response. Keys whose
 * normalized form (lowercase, `-`/`_` stripped) contains a forbidden prefix
 * (prompt, arg, env, secret, token, password, apikey, credential,
 * authorization, privatekey, ...) are dropped wherever they appear — this
 * also catches compound names like `api_keys`, `prompt_text`, `user_prompt`,
 * and `env_vars`. Absolute paths are rewritten to `~` form, and long strings
 * are truncated without splitting surrogate pairs. The data layer already
 * returns typed view models; this is the second, shape-agnostic gate applied
 * to the final response.
 */

import { homedir } from "os"

/** Maximum length of any string that reaches the browser. */
export const MAX_STRING_LENGTH = 200

const FORBIDDEN_KEY_PREFIXES = [
  "prompt",
  "arg",
  "argv",
  "env",
  "secret",
  "token",
  "password",
  "passwd",
  "apikey",
  "credential",
  "authorization",
  "privatekey",
] as const

/** True when a field name must never reach the browser, in any casing/separator form. */
export function isForbiddenKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "")
  return FORBIDDEN_KEY_PREFIXES.some((prefix) => normalized.includes(prefix))
}

/** Rewrite an absolute home path to `~` form; leave everything else as-is. */
export function toTildePath(value: string): string {
  const home = homedir()
  if (value === home) return "~"
  if (value.startsWith(home + "/")) return "~" + value.slice(home.length)
  const match = value.match(/^(?:\/(?:home|Users)\/[^/]+)(?=\/|$)/)
  if (match) return "~" + value.slice(match[0].length)
  return value
}

/** Truncate to `max` chars, marking the cut with an ellipsis. */
export function truncate(value: string, max: number = MAX_STRING_LENGTH): string {
  if (value.length <= max) return value
  let cut = max - 1
  // Back off one when the cut would orphan a low surrogate from its pair.
  const boundary = value.charCodeAt(cut)
  if (boundary >= 0xdc00 && boundary <= 0xdfff) cut = Math.max(0, cut - 1)
  return value.slice(0, cut) + "…"
}

/** Path rewrite + truncation for a single string. */
export function sanitizeString(value: string): string {
  return truncate(toTildePath(value))
}

/**
 * Recursively sanitize an unknown value: strings are path-rewritten and
 * truncated, objects drop forbidden keys, arrays are mapped. Numbers,
 * booleans, and null pass through.
 */
export function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item))
  if (typeof value === "object" && value !== null) {
    return sanitizeRecord(value as Record<string, unknown>)
  }
  return value
}

/** Copy a record, dropping forbidden keys and sanitizing the rest. */
export function sanitizeRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (isForbiddenKey(key)) continue
    out[key] = sanitizeValue(value)
  }
  return out
}

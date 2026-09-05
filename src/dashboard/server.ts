/**
 * Dashboard Server
 *
 * Minimal read-only viewer over the planning artifacts, served with the
 * built-in `Bun.serve` (no framework). Binds to 127.0.0.1 only. Every JSON
 * response passes through the sanitizer; there are no mutation endpoints and
 * no write call anywhere in this codepath.
 */

import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { fdPlanRoot } from "../tools/planning-state-lib"
import { readAuditTail, readTopicStatus, slugDir, isValidName } from "./data"
import { sanitizeValue } from "./sanitize"

export const DEFAULT_PORT = 4321
const AUDIT_DEFAULT_LIMIT = 50
const AUDIT_MAX_LIMIT = 200
const LIMIT_RE = /^\d+$/

export interface DashboardServerOptions {
  /** Port to bind (0 = ephemeral, for tests). Default 4321. */
  port?: number
  /** Host to bind. Default 127.0.0.1 — never override to a public interface. */
  host?: string
  /** Planning root to read from. Default `~/.fd-plan` (via `fdPlanRoot`). */
  planningRoot?: string
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

function handleStatus(url: URL, root: string): Response {
  const slug = url.searchParams.get("slug") ?? ""
  const topic = url.searchParams.get("topic") ?? ""
  if (!isValidName(slug) || !isValidName(topic)) {
    return json(400, { error: "invalid slug or topic" })
  }
  const status = readTopicStatus(slug, topic, root)
  if (status === null) {
    return json(404, { error: `topic '${topic}' not found` })
  }
  return json(200, sanitizeValue(status))
}

function handleAudit(url: URL, root: string): Response {
  const slug = url.searchParams.get("slug") ?? ""
  const dir = slugDir(slug, root)
  if (dir === null) {
    return json(400, { error: "invalid slug" })
  }
  const rawLimit = url.searchParams.get("limit")
  let limit: number
  if (rawLimit === null) {
    limit = AUDIT_DEFAULT_LIMIT
  } else if (!LIMIT_RE.test(rawLimit)) {
    return json(400, { error: "invalid limit" })
  } else {
    limit = Number.parseInt(rawLimit, 10)
  }
  if (limit < 1) {
    return json(400, { error: "invalid limit" })
  }
  const tail = readAuditTail(dir, Math.min(limit, AUDIT_MAX_LIMIT))
  return json(200, sanitizeValue({ slug, events: tail.events, skipped: tail.skipped }))
}

/**
 * Start the dashboard server. Returns the `Bun.serve` handle; call
 * `server.stop(true)` to shut it down.
 */
export function createDashboardServer(
  options: DashboardServerOptions = {},
): ReturnType<typeof Bun.serve> {
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? DEFAULT_PORT
  const root = options.planningRoot ?? fdPlanRoot()
  const indexHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "index.html"),
    "utf-8",
  )

  return Bun.serve({
    hostname: host,
    port,
    fetch(req) {
      const url = new URL(req.url)
      if (req.method !== "GET") {
        return json(405, { error: "read-only: GET only" })
      }
      if (url.pathname === "/") {
        return new Response(indexHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      }
      if (url.pathname === "/api/status") return handleStatus(url, root)
      if (url.pathname === "/api/audit") return handleAudit(url, root)
      return json(404, { error: "not found" })
    },
  })
}

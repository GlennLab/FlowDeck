#!/usr/bin/env bun
/**
 * FlowDeck dashboard CLI — read-only local pipeline viewer.
 *
 * Usage:
 *   bun run dashboard -- --slug <slug> [--topic <topic>] [--port <port>]
 *
 * Serves the static dashboard on 127.0.0.1. It only reads
 * ~/.fd-plan/<slug>/ — it never writes anything.
 */
import { createDashboardServer, DEFAULT_PORT } from "../src/dashboard/server"

interface CliOptions {
  slug?: string
  topic?: string
  port: number
}

function usage(): string {
  return "Usage: bun run dashboard -- --slug <slug> [--topic <topic>] [--port <port>]"
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { port: DEFAULT_PORT }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = (): string => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`missing value for ${arg}\n${usage()}`)
      return value
    }
    if (arg === "--slug") {
      options.slug = next()
    } else if (arg === "--topic") {
      options.topic = next()
    } else if (arg === "--port") {
      const port = Number.parseInt(next(), 10)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`invalid --port\n${usage()}`)
      }
      options.port = port
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage())
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}\n${usage()}`)
    }
  }
  return options
}

let options: CliOptions
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}

const server = createDashboardServer({ port: options.port })
const query = new URLSearchParams()
if (options.slug) query.set("slug", options.slug)
if (options.topic) query.set("topic", options.topic)
const qs = query.toString()
console.log(`FlowDeck dashboard (read-only) → http://127.0.0.1:${server.port}${qs ? `?${qs}` : ""}`)
console.log(`Reading ~/.fd-plan/${options.slug ?? "<slug from UI>"} — press Ctrl+C to stop.`)

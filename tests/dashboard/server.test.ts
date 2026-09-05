import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest"
import { createHash } from "crypto"
import { existsSync, readdirSync, readFileSync } from "fs"
import { join } from "path"
import type { Server } from "bun"
import { createDashboardServer } from "../../src/dashboard/server"

type DashboardServer = Server<unknown>
import {
  SECRET_PROMPT,
  SECRET_TOKEN,
  cleanupFixture,
  cleanupPlanningRoot,
  createFixture,
  planningRootForTests,
  resetFixture,
  writeCompleteFixture,
  type Fixture,
} from "./fixture"

let f: Fixture
let server: DashboardServer

beforeAll(() => {
  planningRootForTests()
})

afterAll(() => {
  cleanupPlanningRoot()
})

beforeEach(() => {
  f = createFixture()
  resetFixture(f)
})

afterEach(() => {
  server?.stop(true)
  cleanupFixture(f)
})

function start(): number {
  server = createDashboardServer({ port: 0, planningRoot: planningRootForTests() })
  if (server.port === undefined) throw new Error("dashboard server did not bind")
  return server.port
}

function url(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

/** Recursive snapshot (path + sha256) of a directory tree. */
function snapshotDir(root: string): string {
  const entries: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else entries.push(`${p}\0${createHash("sha256").update(readFileSync(p)).digest("hex")}`)
    }
  }
  if (existsSync(root)) walk(root)
  return JSON.stringify(entries.sort())
}

describe("dashboard server routes", () => {
  it("should bind to 127.0.0.1 only", () => {
    const port = start()
    expect(server.hostname).toBe("127.0.0.1")
    expect(port).toBeGreaterThan(0)
  })

  it("should serve index.html at /", async () => {
    const port = start()
    const res = await fetch(url(port, "/"))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("FlowDeck")
  })

  it("should return 200 and the status JSON shape for a complete topic", async () => {
    writeCompleteFixture(f)
    const port = start()
    const res = await fetch(url(port, `/api/status?slug=${f.slug}&topic=${f.topic}`))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = (await res.json()) as Record<string, unknown>
    expect(body.slug).toBe(f.slug)
    expect(body.topic).toBe(f.topic)
    expect(body.stage).toBe("fd-execute")
    expect(body.stageStatus).toBe("wave-2")
    expect(Array.isArray(body.phases)).toBe(true)
    expect((body.phases as unknown[]).length).toBe(5)
    expect(Array.isArray(body.steps)).toBe(true)
    expect(body.stepsTotal).toBe(3)
    expect(body.stepsComplete).toBe(1)
    expect(body.budget).toEqual(
      expect.objectContaining({ total: expect.any(Number), remaining: expect.any(Number) }),
    )
    expect(Array.isArray(body.traces)).toBe(true)
  })

  it("should not leak secrets or absolute paths in the status response", async () => {
    writeCompleteFixture(f)
    const port = start()
    const res = await fetch(url(port, `/api/status?slug=${f.slug}&topic=${f.topic}`))
    const body = await res.text()
    expect(body).not.toContain(SECRET_PROMPT)
    expect(body).not.toContain(SECRET_TOKEN)
    expect(body).not.toContain("ses_x")
    expect(body).not.toContain("/home/")
  })

  it("should return 400 for invalid slug or topic", async () => {
    const port = start()
    const badSlug = await fetch(url(port, "/api/status?slug=a/b&topic=t"))
    expect(badSlug.status).toBe(400)
    const badTopic = await fetch(url(port, `/api/status?slug=${f.slug}&topic=..`))
    expect(badTopic.status).toBe(400)
    const missing = await fetch(url(port, "/api/status"))
    expect(missing.status).toBe(400)
  })

  it("should return 404 for a missing topic", async () => {
    const port = start()
    const res = await fetch(url(port, `/api/status?slug=${f.slug}&topic=no-such-topic`))
    expect(res.status).toBe(404)
  })

  it("should return the audit tail with 200 and the JSON shape", async () => {
    writeCompleteFixture(f)
    const port = start()
    const res = await fetch(url(port, `/api/audit?slug=${f.slug}&limit=50`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.slug).toBe(f.slug)
    expect(body.skipped).toBe(1)
    const events = body.events as Array<Record<string, unknown>>
    expect(events).toHaveLength(3)
    expect(events[0].kind).toBe("guard.allow")
    const dumped = JSON.stringify(body)
    expect(dumped).not.toContain("details")
    expect(dumped).not.toContain(SECRET_PROMPT)
    expect(dumped).not.toContain("ses_x")
  })

  it("should honor the audit limit", async () => {
    writeCompleteFixture(f)
    const port = start()
    const res = await fetch(url(port, `/api/audit?slug=${f.slug}&limit=2`))
    const body = (await res.json()) as Record<string, unknown>
    const events = body.events as Array<Record<string, unknown>>
    expect(events).toHaveLength(2)
    expect(events[0].kind).toBe("guard.block")
  })

  it("should return 400 for an invalid audit slug or limit", async () => {
    const port = start()
    expect((await fetch(url(port, "/api/audit?slug=../x"))).status).toBe(400)
    expect((await fetch(url(port, "/api/audit?slug=x&limit=0"))).status).toBe(400)
    expect((await fetch(url(port, "/api/audit?slug=x&limit=abc"))).status).toBe(400)
  })

  it("should reject limit values that are not plain non-negative integers", async () => {
    const port = start()
    expect((await fetch(url(port, "/api/audit?slug=x&limit=5abc"))).status).toBe(400)
    expect((await fetch(url(port, "/api/audit?slug=x&limit=1.5"))).status).toBe(400)
    expect((await fetch(url(port, "/api/audit?slug=x&limit=-3"))).status).toBe(400)
    expect((await fetch(url(port, "/api/audit?slug=x&limit="))).status).toBe(400)
  })

  it("should return an empty audit tail when the log is missing", async () => {
    const port = start()
    const res = await fetch(url(port, `/api/audit?slug=${f.slug}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.events).toEqual([])
    expect(body.skipped).toBe(0)
  })

  it("should reject non-GET methods with 405", async () => {
    const port = start()
    const res = await fetch(url(port, "/api/status?slug=x&topic=y"), { method: "POST" })
    expect(res.status).toBe(405)
  })

  it("should return 404 for unknown paths", async () => {
    const port = start()
    expect((await fetch(url(port, "/nope"))).status).toBe(404)
    expect((await fetch(url(port, "/api/nope"))).status).toBe(404)
  })
})

describe("dashboard server read-only guarantee", () => {
  it("should contain no fs write calls in the dashboard source", () => {
    const files = ["data.ts", "sanitize.ts", "server.ts"]
    const forbidden = [
      "writeFileSync",
      "appendFileSync",
      "createWriteStream",
      "writeFile(",
      "appendFile(",
      "mkdirSync",
      "rmSync",
      "unlinkSync",
      "renameSync",
      "copyFileSync",
      "Bun.write",
    ]
    for (const file of files) {
      const source = readFileSync(
        new URL(`../../src/dashboard/${file}`, import.meta.url),
        "utf-8",
      )
      for (const pattern of forbidden) {
        expect(source, `${file} must not contain ${pattern}`).not.toContain(pattern)
      }
    }
  })

  it("should leave the planning directory byte-identical after serving requests", async () => {
    writeCompleteFixture(f)
    const port = start()
    const before = snapshotDir(f.root)
    await fetch(url(port, `/api/status?slug=${f.slug}&topic=${f.topic}`))
    await fetch(url(port, `/api/audit?slug=${f.slug}&limit=50`))
    await fetch(url(port, "/"))
    await fetch(url(port, `/api/status?slug=${f.slug}&topic=${f.topic}`), { method: "POST" })
    expect(snapshotDir(f.root)).toBe(before)
  })
})
